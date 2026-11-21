#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const [editionId, ledgerRevision, portArg = "5174"] = process.argv.slice(2);
const firstPort = Number(portArg);
if (
  process.argv.length > 5 ||
  !/^\d{4}-\d{2}-\d{2}$/.test(editionId ?? "") ||
  !/^[a-f0-9]{64}$/.test(ledgerRevision ?? "") ||
  !Number.isInteger(firstPort) ||
  firstPort < 1024 ||
  firstPort > 65526
) {
  throw new Error(
    "Usage: npm run weekly:preview-newsletter -- EDITION_ID LEDGER_REVISION [PORT]"
  );
}

const root = process.cwd();
const data = join(root, "public", "data");
const manifestBytes = await readFile(join(data, "manifest.json"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestSha256 = sha256(manifestBytes);
const manifest = JSON.parse(manifestBytes);
const edition = manifest.weeklyEdition;
const state = JSON.parse(
  await readFile(
    join(root, "data", "ingestion", "weekly-editions.json"),
    "utf8"
  )
);
const frozen = state.editions.find((entry) => entry.editionId === editionId);
if (
  manifest.sourceLedgerRevision !== ledgerRevision ||
  edition?.editionId !== editionId ||
  !frozen ||
  !["draft", "published"].includes(frozen.status) ||
  edition.startEpochMs !== frozen.startEpochMs ||
  edition.endEpochMs !== frozen.endEpochMs ||
  edition.datasetVersion !== frozen.datasetVersion ||
  JSON.stringify(edition.eventIds) !== JSON.stringify(frozen.eventIds)
) {
  throw new Error(
    "The export does not match the expected ledger and frozen edition."
  );
}

const assets = [
  ...manifest.chunks.events,
  manifest.chunks.artists,
  manifest.chunks.venues,
  manifest.chunks.indexes,
  manifest.chunks.recentAdditions,
].filter(Boolean);
await Promise.all(
  assets.map(async ({ filename, checksum, size }) => {
    if (basename(filename) !== filename)
      throw new Error("Unexpected path in the public export manifest.");
    const bytes = await readFile(join(data, filename));
    if (bytes.length !== size || `sha256-${sha256(bytes)}` !== checksum)
      throw new Error(`Public export checksum mismatch for ${filename}.`);
  })
);

async function readPreviewManifest(origin) {
  let response;
  try {
    response = await fetch(`${origin}/data/manifest.json`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw error;
  }
  return response.ok ? sha256(Buffer.from(await response.arrayBuffer())) : "";
}

const require = createRequire(import.meta.url);
const vite = join(require.resolve("vite/package.json"), "..", "bin", "vite.js");
let server;
let origin;
try {
  for (let port = firstPort; port < firstPort + 10; port++) {
    const address = `http://127.0.0.1:${port}`;
    const running = await readPreviewManifest(address);
    if (running === manifestSha256) {
      origin = address;
      break;
    }
    if (running !== null) continue;
    server = spawn(
      process.execPath,
      [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ZIVV_BASE_PATH: "/" },
      }
    );
    await new Promise((resolve, reject) => {
      server.once("spawn", resolve);
      server.once("error", reject);
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.exitCode !== null) break;
      if ((await readPreviewManifest(address)) === manifestSha256) {
        origin = address;
        break;
      }
      await delay(250);
    }
    if (origin) break;
    if (server.exitCode === null)
      throw new Error("Vite did not serve the expected newsletter export.");
    server = undefined;
  }
  if (!origin) throw new Error("No local preview port was available.");

  const previewUrl = `${origin}/newsletter/sfmusic`;
  const browser = await chromium.launch({
    executablePath: process.env.ZIVV_NEWSLETTER_CHROMIUM,
  });
  let newsletter;
  try {
    const page = await browser.newPage();
    const response = await page.goto(previewUrl, { timeout: 30000 });
    if (!response?.ok()) throw new Error("SF Music preview route failed.");
    const article = page.locator("main article").first();
    await article.waitFor({ timeout: 30000 });
    const headingDate = new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeZone: "America/Los_Angeles",
    }).format(new Date(`${editionId}T12:00:00Z`));
    if (
      !(
        await article.getByRole("heading", { level: 2 }).first().textContent()
      )?.includes(`Week of ${headingDate}`) ||
      !(await article
        .getByRole("heading", { name: "San Francisco Events", exact: true })
        .count()) ||
      !(await article
        .getByRole("heading", { name: "Nearby Events", exact: true })
        .count())
    ) {
      throw new Error(
        "The SF Music preview does not show the expected edition."
      );
    }
    newsletter = await article.evaluate((article) => {
      const styles = {
        H2: "font-size:23px;margin:0 0 16px",
        H3: "font-size:19px;margin:24px 0 10px;color:#362665",
        H4: "font-size:15px;margin:17px 0 9px;color:#493889",
        P: "margin:3px 0;line-height:1.5",
        HR: "border:0;border-top:1px solid #dedbe7;margin:15px 0",
        LI: "margin:3px 0;line-height:1.5",
      };
      const allowed = new Set([
        ...Object.keys(styles),
        "BR",
        "UL",
        "OL",
        "STRONG",
        "EM",
        "A",
        "DIV",
        "SPAN",
      ]);
      function append(parent, node) {
        if (node.nodeType === Node.TEXT_NODE) {
          parent.append(document.createTextNode(node.textContent));
          return;
        }
        if (!(node instanceof HTMLElement)) return;
        if (!allowed.has(node.tagName)) {
          node.childNodes.forEach((child) => append(parent, child));
          return;
        }
        const element = document.createElement(node.tagName.toLowerCase());
        if (styles[node.tagName]) element.style.cssText = styles[node.tagName];
        if (
          node.matches("span[aria-hidden='true']") &&
          node.textContent === "•"
        )
          element.style.marginRight = "6px";
        if (node instanceof HTMLAnchorElement && node.protocol === "https:")
          element.href = node.href;
        node.childNodes.forEach((child) => append(element, child));
        parent.append(element);
      }
      const body = document.createElement("div");
      article.childNodes.forEach((node) => append(body, node));
      return body.innerHTML;
    });
  } finally {
    await browser.close();
  }
  if ((await readPreviewManifest(origin)) !== manifestSha256)
    throw new Error("The export changed while rendering the newsletter.");
  const subject = `Zivv SF Music newsletter — ${editionId}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5fa;color:#211b36;font:15px/1.45 Arial,sans-serif"><div style="max-width:680px;margin:0 auto;padding:24px;background:#fff"><p><a href="${previewUrl}">Open the local preview on the Zivv computer</a></p>${newsletter}</div></body></html>`;
  server?.unref();
  console.log(
    JSON.stringify({
      editionId,
      ledgerRevision,
      manifestSha256,
      previewUrl,
      subject,
      html,
    })
  );
} catch (error) {
  server?.kill();
  throw error;
}
