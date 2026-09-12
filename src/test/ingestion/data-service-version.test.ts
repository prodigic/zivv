import { afterEach, describe, expect, it, vi } from "vitest";
const cache = vi.hoisted(() => ({
  initialize: vi.fn(),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn(),
  clearVersion: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../../services/CacheService.js", () => ({
  CacheService: class {
    constructor() {
      return cache;
    }
  },
}));
import { DataService } from "../../services/DataService.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cache.get.mockResolvedValue(null);
});
describe("migration client loading", () => {
  it("uses the manifest version for cached data and rejects a mismatched additions index", async () => {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("manifest.json")
          ? {
              datasetVersion: "new",
              chunks: {
                recentAdditions: { filename: "recent-additions.json" },
              },
            }
          : url.endsWith("recent-additions.json")
            ? { schemaVersion: 1, datasetVersion: "old", events: [] }
            : [],
    }));
    vi.stubGlobal("fetch", fetch);
    const service = new DataService({ baseUrl: "/data", retryAttempts: 1 });
    await service.loadArtists();
    expect(cache.get).toHaveBeenCalledWith("artists", "new");
    await expect(service.loadRecentAdditions()).rejects.toThrow("do not match");
    expect(cache.set).not.toHaveBeenCalledWith(
      "recent-additions",
      expect.anything(),
      expect.anything()
    );
  });

  it("clears in-memory entities after a version change when the manifest cache is absent", async () => {
    let version = "old";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith("manifest.json")
            ? { datasetVersion: version, chunks: {} }
            : [{ id: version === "old" ? 1 : 2, name: version }],
      }))
    );
    const service = new DataService({ baseUrl: "/data", retryAttempts: 1 });
    expect((await service.loadArtists())[0].name).toBe("old");
    version = "new";
    await service.loadManifest();
    expect((await service.loadArtists())[0].name).toBe("new");
    expect(cache.clearVersion).toHaveBeenCalledWith("old");
  });
});
