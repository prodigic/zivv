import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import PostalMime from "postal-mime";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  listRetainedSteveEmailSources,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import { sha256 } from "./steve-preflight.js";

export interface SteveArchiveResult {
  status:
    | "created"
    | "already-matched"
    | "correction-replaced"
    | "needs-attention";
  path?: string;
  messageId?: string;
  receiptId?: string;
  reason?: string;
  auditPath?: string;
  actionBeforeAuditFailure?: SteveArchiveResult["status"];
}

function archiveError(code: string): never {
  throw new Error(code);
}

/** Convert HTML in the same way as the existing archive extractor. */
function htmlText(html: string): string {
  const parts: string[] = [];
  const blocks = new Set(["p", "div", "li", "tr", "h1", "h2", "h3"]);
  function walk(node: DefaultTreeAdapterMap["node"]): void {
    if (node.nodeName === "#text") {
      parts.push((node as DefaultTreeAdapterMap["textNode"]).value);
      return;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node)
        for (const child of node.childNodes) walk(child);
      return;
    }
    const tag = node.tagName;
    if (tag === "script" || tag === "style") return;
    if (tag === "br" || blocks.has(tag)) parts.push("\n");
    for (const child of node.childNodes) walk(child);
    if (blocks.has(tag)) parts.push("\n");
  }
  walk(parseFragment(html));
  return parts.join("").replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
}

/** Extract body and calendar date without converting the sender's timezone. */
export async function archiveEmailBody(
  raw: Buffer
): Promise<{ date: string; body: Buffer }> {
  const email = await new PostalMime().parse(raw);
  const dates = email.headers.filter(
    (header) => header.key.toLowerCase() === "date"
  );
  if (dates.length !== 1) archiveError("ARCHIVE_INVALID_DATE");
  const match = dates[0].value.match(
    /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|[A-Za-z]{1,5})(?:\s*\([^)]*\))?\s*$/i
  );
  if (!match) archiveError("ARCHIVE_INVALID_DATE");
  const month =
    [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(match[2].toLowerCase()) + 1;
  const year = Number(match[3]),
    day = Number(match[1]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    archiveError("ARCHIVE_INVALID_DATE");
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const text =
    email.text !== undefined
      ? email.text
      : email.html !== undefined
        ? htmlText(email.html)
        : archiveError("ARCHIVE_NO_BODY");
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const footer =
    /^[ \t]*-{3,}[ \t]*\n[ \t]*Please feel free to forward The List on to your friends\.[ \t]*(?:\n|$)/m.exec(
      normalized
    );
  if (!footer || footer.index === undefined)
    archiveError("ARCHIVE_FOOTER_NOT_FOUND");
  return {
    date,
    body: Buffer.from(
      normalized.slice(0, footer.index).trimEnd() + "\n",
      "utf8"
    ),
  };
}

function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    archiveError("ARCHIVE_UNSAFE_FILE");
  return readFileSync(path);
}

/** Archive only receipts independently authenticated and validated by the intake journal. */
async function updateArchive(input: {
  operatorDirectory: string;
  accountId: string;
  expectedEditionId: string;
  archiveDirectory?: string;
}): Promise<SteveArchiveResult> {
  let target: string | undefined;
  let selected: SteveEmailReceipt | undefined;
  let lock: string | undefined;
  let lockFd: number | undefined;
  let temp: string | undefined;
  let tempCreated = false;
  try {
    if (!input.archiveDirectory)
      archiveError("ARCHIVE_DIRECTORY_NOT_CONFIGURED");
    const directory = resolve(input.archiveDirectory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      archiveError("ARCHIVE_UNSAFE_DIRECTORY");
    const retained = listRetainedSteveEmailSources(input);
    if (
      !retained.length ||
      retained.some(({ receipt }) => receipt.disposition !== "ready")
    )
      archiveError("ARCHIVE_SOURCE_REVIEW_REQUIRED");
    const receipts = retained.map(({ receipt }) => receipt);
    const roots = receipts.filter((receipt) => !receipt.correctionOf);
    if (roots.length !== 1) archiveError("ARCHIVE_AMBIGUOUS_SOURCE");
    const ordered = [roots[0]];
    while (ordered.length < receipts.length) {
      const children = receipts.filter(
        (receipt) => receipt.correctionOf === ordered.at(-1)?.receiptId
      );
      if (children.length !== 1 || ordered.includes(children[0]))
        archiveError("ARCHIVE_AMBIGUOUS_CORRECTION");
      ordered.push(children[0]);
    }
    selected = ordered.at(-1);
    if (!selected) archiveError("ARCHIVE_SOURCE_REVIEW_REQUIRED");
    const bodies = await Promise.all(
      ordered.map(async (receipt) => {
        const raw = readRegular(
          join(
            resolve(input.operatorDirectory),
            "email-intake",
            receipt.accountSha256,
            "messages",
            sha256(receipt.messageId),
            "message.eml"
          )
        );
        if (sha256(raw) !== receipt.rawSha256)
          archiveError("ARCHIVE_SOURCE_CHANGED");
        return archiveEmailBody(raw);
      })
    );
    target = join(directory, `${bodies[0].date}.txt`);
    const desired = bodies.at(-1)!.body;
    lock = join(directory, `.${bodies[0].date}.archive.lock`);
    lockFd = openSync(lock, "wx", 0o600);
    if (!existsSync(target)) {
      writeFileSync(target, desired, { flag: "wx" });
      if (!readRegular(target).equals(desired))
        archiveError("ARCHIVE_VERIFY_FAILED");
      return {
        status: "created",
        path: target,
        messageId: selected.messageId,
        receiptId: selected.receiptId,
      };
    }
    const existing = readRegular(target);
    if (existing.equals(desired))
      return {
        status: "already-matched",
        path: target,
        messageId: selected.messageId,
        receiptId: selected.receiptId,
      };
    if (
      ordered.length < 2 ||
      !bodies.slice(0, -1).some(({ body }) => body.equals(existing))
    )
      archiveError("ARCHIVE_CONTENT_CONFLICT");
    temp = join(
      directory,
      `.${bodies[0].date}.${selected.receiptId}.archive.tmp`
    );
    writeFileSync(temp, desired, { flag: "wx", mode: 0o600 });
    tempCreated = true;
    if (
      !readRegular(temp).equals(desired) ||
      !readRegular(target).equals(existing)
    )
      archiveError("ARCHIVE_CONTENT_CONFLICT");
    renameSync(temp, target);
    temp = undefined;
    tempCreated = false;
    if (!readRegular(target).equals(desired))
      archiveError("ARCHIVE_VERIFY_FAILED");
    return {
      status: "correction-replaced",
      path: target,
      messageId: selected.messageId,
      receiptId: selected.receiptId,
    };
  } catch (error) {
    const reason =
      error instanceof Error && /^ARCHIVE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "ARCHIVE_IO_OR_INTAKE_ERROR";
    return {
      status: "needs-attention",
      path: target,
      messageId: selected?.messageId,
      receiptId: selected?.receiptId,
      reason,
    };
  } finally {
    if (tempCreated && temp && existsSync(temp)) unlinkSync(temp);
    if (lockFd !== undefined) {
      closeSync(lockFd);
      if (lock) unlinkSync(lock);
    }
  }
}

/** Persist the outcome outside the public archive, without overwriting earlier records. */
export async function archiveRetainedSteveEmails(input: {
  operatorDirectory: string;
  accountId: string;
  expectedEditionId: string;
  archiveDirectory?: string;
}): Promise<SteveArchiveResult> {
  let auditPath: string;
  try {
    const operator = resolve(input.operatorDirectory);
    const directory = join(operator, "steve-archive-audit");
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe audit directory");
    const id = randomUUID();
    auditPath = join(directory, `${id}.result.json`);
    writeAudit(join(directory, `${id}.intent.json`), {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      editionId: input.expectedEditionId,
    });
  } catch {
    return { status: "needs-attention", reason: "ARCHIVE_AUDIT_WRITE_FAILED" };
  }
  const result = await updateArchive(input);
  try {
    writeAudit(auditPath, {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      editionId: input.expectedEditionId,
      ...result,
    });
    return { ...result, auditPath };
  } catch {
    return {
      ...result,
      actionBeforeAuditFailure: result.status,
      status: "needs-attention",
      reason: "ARCHIVE_AUDIT_WRITE_FAILED",
    };
  }
}

function writeAudit(path: string, value: object): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
