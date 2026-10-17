import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  PROMOTION_DESTINATIONS,
  promotionDigest,
  type PromotionDestination,
} from "./promotion-control.js";

export interface LiveInventoryEvidence {
  inventorySha256: string;
  manifestSha256: string;
  fileCount: number;
  retainedFileCount: number;
}
export interface LiveInventoryOptions {
  destination: PromotionDestination;
  files: ReadonlyMap<string, Buffer>;
  expectedInventorySha256: string;
  timeoutMs?: number;
  /** Offline fixtures only. Production CLI cannot select another origin. */
  testTransport?: { baseUrl: string; fetch: typeof fetch };
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Compare every retained public byte, including a second manifest read after the sweep. */
export async function verifyLiveInventory(
  options: LiveInventoryOptions
): Promise<LiveInventoryEvidence> {
  const policy = PROMOTION_DESTINATIONS[options.destination];
  if (!policy) throw new Error("Unknown release destination");
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)
    throw new Error("Invalid live verification deadline");
  const files = new Map(
    [...options.files].map(([path, bytes]) => [path, Buffer.from(bytes)])
  );
  const inventory = [...files]
    .map(([path, bytes]) => {
      if (
        !path ||
        path.includes("\\") ||
        path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        /[?#%]/.test(path) ||
        [...path].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
      )
        throw new Error("Unsafe live inventory path");
      return { path, size: bytes.length, sha256: hash(bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    !files.has("index.html") ||
    !files.has("data/manifest.json") ||
    promotionDigest(inventory) !== options.expectedInventorySha256
  )
    throw new Error("Retained live inventory identity mismatch");
  let baseUrl = policy.liveUrl as string;
  const request = options.testTransport?.fetch ?? fetch;
  if (options.testTransport) {
    const url = new URL(options.testTransport.baseUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/")
    )
      throw new Error("Live fixtures require a loopback origin");
    baseUrl = url.href;
  }
  // Pages consumes this deployment marker but does not serve it as a public URL.
  const servedInventory = inventory.filter((file) => file.path !== ".nojekyll");
  if (files.has(".nojekyll") && files.get(".nojekyll")!.length !== 0)
    throw new Error("Unexpected nonempty Pages marker");
  const signal = AbortSignal.timeout(timeout);
  const nonce = randomBytes(16).toString("hex");
  const read = async (path: string) => {
    const expected = files.get(path)!;
    const url = new URL(
      path.split("/").map(encodeURIComponent).join("/"),
      baseUrl
    );
    url.searchParams.set("zivv_verify", nonce);
    const response = await request(url, {
      redirect: "error",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal,
    });
    if (response.status !== 200 || !response.body)
      throw new Error("Live inventory response unavailable");
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > expected.length)
          throw new Error("Live inventory response exceeds retained size");
        digest.update(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (size !== expected.length || digest.digest("hex") !== hash(expected))
      throw new Error("Live inventory bytes differ from retained release");
  };
  await read("data/manifest.json");
  // Bounded concurrency avoids serial multi-minute sweeps of a complete static site.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, servedInventory.length) }, async () => {
      while (cursor < servedInventory.length)
        await read(servedInventory[cursor++].path);
    })
  );
  await read("data/manifest.json");
  return {
    inventorySha256: options.expectedInventorySha256,
    manifestSha256: hash(files.get("data/manifest.json")!),
    fileCount: servedInventory.length,
    retainedFileCount: files.size,
  };
}
