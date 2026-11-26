import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import type { SteveEmailReceipt } from "../../lib/ingestion/steve-email-intake.js";
import {
  archiveEmailBody,
  archiveRetainedSteveEmails,
} from "../../lib/ingestion/steve-text-archive.js";

const retained = vi.hoisted(() => ({
  items: [] as Array<{ receipt: SteveEmailReceipt; source: Buffer }>,
}));
vi.mock("../../lib/ingestion/steve-email-intake.js", () => ({
  listRetainedSteveEmailSources: () => retained.items,
}));
const dirs: string[] = [];
const footer =
  "---\r\nPlease feel free to forward The List on to your friends.\r\nFooter\r\n";
function email(body: string, extra = ""): Buffer {
  return Buffer.from(
    `Date: Sat, 17 Oct 2026 00:05:00 +0000\r\nSubject: List\r\nMIME-Version: 1.0\r\n${extra}\r\n${body}`
  );
}
function setup() {
  const base = mkdtempSync(join(tmpdir(), "zivv-archive-test-"));
  dirs.push(base);
  const archiveDirectory = join(base, "archive"),
    operatorDirectory = join(base, "operator");
  mkdirSync(archiveDirectory);
  mkdirSync(operatorDirectory);
  retained.items = [];
  return {
    archiveDirectory,
    operatorDirectory,
    accountId: "account",
    expectedEditionId: "2026-10-16",
  };
}
function add(
  input: ReturnType<typeof setup>,
  id: string,
  raw: Buffer,
  parent: string | null = null
) {
  const accountSha256 = sha256(input.accountId);
  const receipt = {
    receiptId: id,
    accountSha256,
    messageId: id,
    rawSha256: sha256(raw),
    disposition: "ready",
    correctionOf: parent,
  } as SteveEmailReceipt;
  const path = join(
    input.operatorDirectory,
    "email-intake",
    accountSha256,
    "messages",
    sha256(id)
  );
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "message.eml"), raw);
  retained.items.push({ receipt, source: Buffer.alloc(0) });
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("Steve text archive", () => {
  it("uses the sender date and decodes the plain body, excluding attachments and footer", async () => {
    const raw = email(
      `--b\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9\r\n${footer}\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=extra.txt\r\n\r\nattachment\r\n--b--\r\n`,
      "Content-Type: multipart/mixed; boundary=b\r\n"
    );
    const out = await archiveEmailBody(raw);
    expect(out.date).toBe("2026-10-17");
    expect(out.body.toString()).toBe("Café\n");
  });
  it("converts HTML and refuses an absent dashed footer", async () => {
    const html = email(
      `<p>Hi &amp; bye</p><script>hidden</script><div>---<br>Please feel free to forward The List on to your friends.<br>footer</div>`,
      "Content-Type: text/html; charset=utf-8\r\n"
    );
    expect((await archiveEmailBody(html)).body.toString()).toBe("Hi & bye\n");
    await expect(
      archiveEmailBody(email("No footer\r\n", "Content-Type: text/plain\r\n"))
    ).rejects.toThrow("ARCHIVE_FOOTER_NOT_FOUND");
  });
  it("creates, retries, preserves old files, and refuses unrelated conflicts", async () => {
    const input = setup();
    add(
      input,
      "one",
      email(`First\r\n${footer}`, "Content-Type: text/plain\r\n")
    );
    const target = join(input.archiveDirectory, "2026-10-17.txt");
    writeFileSync(join(input.archiveDirectory, "2025-07-11.txt"), "old");
    const created = await archiveRetainedSteveEmails(input);
    expect(created.status).toBe("created");
    expect(JSON.parse(readFileSync(created.auditPath!, "utf8"))).toMatchObject({
      status: "created",
      messageId: "one",
      path: target,
    });
    expect((await archiveRetainedSteveEmails(input)).status).toBe(
      "already-matched"
    );
    writeFileSync(target, "different");
    expect(await archiveRetainedSteveEmails(input)).toMatchObject({
      status: "needs-attention",
      reason: "ARCHIVE_CONTENT_CONFLICT",
    });
    expect(readFileSync(target, "utf8")).toBe("different");
    expect(
      readFileSync(join(input.archiveDirectory, "2025-07-11.txt"), "utf8")
    ).toBe("old");
  });
  it("uses the selected correction date together and retains the original path when corrected later", async () => {
    for (const firstOriginal of [false, true]) {
      const input = setup();
      add(
        input,
        "one",
        email(`First\r\n${footer}`, "Content-Type: text/plain\r\n")
      );
      if (firstOriginal)
        expect((await archiveRetainedSteveEmails(input)).status).toBe(
          "created"
        );
      add(
        input,
        "two",
        Buffer.from(
          email(`Corrected\r\n${footer}`, "Content-Type: text/plain\r\n")
            .toString("utf8")
            .replace("Sat, 17 Oct", "Sun, 18 Oct")
        ),
        "one"
      );
      expect((await archiveRetainedSteveEmails(input)).status).toBe(
        firstOriginal ? "correction-replaced" : "created"
      );
      const selectedDate = firstOriginal ? "2026-10-17" : "2026-10-18";
      expect(
        readFileSync(
          join(input.archiveDirectory, `${selectedDate}.txt`),
          "utf8"
        )
      ).toBe("Corrected\n");
      expect((await archiveRetainedSteveEmails(input)).status).toBe(
        "already-matched"
      );
      const otherDate = firstOriginal ? "2026-10-18" : "2026-10-17";
      writeFileSync(join(input.archiveDirectory, `${otherDate}.txt`), "other");
      expect(await archiveRetainedSteveEmails(input)).toMatchObject({
        status: "needs-attention",
        reason: "ARCHIVE_AMBIGUOUS_FILES",
      });
    }
  });

  it("reports missing configuration and ambiguous or unreviewed sources", async () => {
    const input = setup();
    add(
      input,
      "one",
      email(`First\r\n${footer}`, "Content-Type: text/plain\r\n")
    );
    expect(
      await archiveRetainedSteveEmails({
        ...input,
        archiveDirectory: undefined,
      })
    ).toMatchObject({
      status: "needs-attention",
      reason: "ARCHIVE_DIRECTORY_NOT_CONFIGURED",
    });
    add(
      input,
      "two",
      email(`Other\r\n${footer}`, "Content-Type: text/plain\r\n")
    );
    expect(await archiveRetainedSteveEmails(input)).toMatchObject({
      status: "needs-attention",
      reason: "ARCHIVE_AMBIGUOUS_SOURCE",
    });
    retained.items[1].receipt.disposition = "review-required";
    expect(await archiveRetainedSteveEmails(input)).toMatchObject({
      status: "needs-attention",
      reason: "ARCHIVE_SOURCE_REVIEW_REQUIRED",
    });
  });
});
