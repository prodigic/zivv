import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promotionDigest } from "../../lib/ingestion/promotion-control";
import { verifyLiveInventory } from "../../lib/ingestion/release-live-inventory";
const files = new Map([
  ["index.html", Buffer.from("hello")],
  ["data/manifest.json", Buffer.from('{"datasetVersion":"new"}')],
  ["data/events.json", Buffer.from("[]")],
]);
const inventory = [...files]
  .map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
const expectedInventorySha256 = promotionDigest(inventory);
function fixture(change?: (path: string, count: number) => Response) {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(url.searchParams.has("zivv_verify")).toBe(true);
    const path = url.pathname.slice("/zivv/".length);
    return (
      change?.(path, calls.filter((p) => p === url.pathname).length) ??
      new Response(files.get(path))
    );
  };
  return {
    calls,
    testTransport: { baseUrl: "http://127.0.0.1:3210/zivv/", fetch: request },
  };
}
describe("exact live release inventory", () => {
  it("checks all files and brackets the sweep with manifest reads", async () => {
    const mock = fixture();
    const result = await verifyLiveInventory({
      destination: "production",
      files,
      expectedInventorySha256,
      ...mock,
    });
    expect(result.fileCount).toBe(3);
    expect(mock.calls.filter((p) => p.endsWith("manifest.json"))).toHaveLength(
      3
    );
  });
  it("retains but does not request the unserved empty Pages marker", async () => {
    const marked = new Map([...files, [".nojekyll", Buffer.alloc(0)] as const]);
    const expected = promotionDigest(
      [
        ...inventory,
        {
          path: ".nojekyll",
          size: 0,
          sha256: createHash("sha256").update("").digest("hex"),
        },
      ].sort((a, b) => a.path.localeCompare(b.path))
    );
    const mock = fixture();
    const result = await verifyLiveInventory({
      destination: "production",
      files: marked,
      expectedInventorySha256: expected,
      ...mock,
    });
    expect(result.retainedFileCount).toBe(4);
    expect(result.fileCount).toBe(3);
    expect(mock.calls.some((path) => path.includes(".nojekyll"))).toBe(false);
  });
  it.each(["stale", "missing", "oversize", "changed-final-manifest"])(
    "rejects %s",
    async (mode) => {
      const mock = fixture((path, count) => {
        if (mode === "missing") return new Response("missing", { status: 404 });
        if (mode === "oversize") return new Response(Buffer.alloc(1000));
        if (mode === "stale" || (path === "data/manifest.json" && count === 3))
          return new Response("old");
        return new Response(files.get(path));
      });
      await expect(
        verifyLiveInventory({
          destination: "production",
          files,
          expectedInventorySha256,
          ...mock,
        })
      ).rejects.toThrow();
    }
  );
  it("rejects untrusted inventory and remote fixture endpoints before fetch", async () => {
    const mock = fixture();
    await expect(
      verifyLiveInventory({
        destination: "production",
        files,
        expectedInventorySha256: "0".repeat(64),
        ...mock,
      })
    ).rejects.toThrow("identity");
    await expect(
      verifyLiveInventory({
        destination: "production",
        files,
        expectedInventorySha256,
        testTransport: {
          ...mock.testTransport,
          baseUrl: "https://example.com/",
        },
      })
    ).rejects.toThrow("loopback");
    expect(mock.calls).toEqual([]);
  });
});
