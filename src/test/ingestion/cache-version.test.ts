import { describe, expect, it } from "vitest";
import { CacheService } from "../../services/CacheService.js";

describe("cache dataset version boundary", () => {
  it("rejects a fresh entry from a different dataset even without a cached manifest", async () => {
    const cache = new CacheService();
    const request: Record<string, unknown> = {
      result: {
        version: "before-migration",
        timestamp: Date.now(),
        data: [{ id: 1 }],
      },
    };
    Reflect.set(cache, "db", {
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            queueMicrotask(() => (request.onsuccess as () => void)());
            return request;
          },
        }),
      }),
    });
    expect(await cache.get("chunk-2026-12", "after-migration")).toBeNull();
  });
});
