import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSiteBase,
  renderWebManifest,
  siteCacheName,
} from "../../utils/site-base.js";
vi.mock("../../services/CacheService.js", () => ({
  CacheService: class {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn();
    clearVersion = vi.fn();
  },
}));
import { DataService } from "../../services/DataService.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("site base boundary", () => {
  it.each(["/", "/zivv/", "/zivv-test/", "/nested/preview/"])(
    "keeps route/assets/data aligned for %s",
    async (base) => {
      expect(normalizeSiteBase(base)).toBe(base);
      const manifest = JSON.parse(
        renderWebManifest('{"icons":[{"src":"/vite.svg"}]}', base)
      );
      expect(manifest).toMatchObject({
        scope: base,
        start_url: base,
        icons: [{ src: base + "vite.svg" }],
      });
      vi.stubEnv("BASE_URL", base);
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ datasetVersion: "fixture", chunks: {} }),
      });
      vi.stubGlobal("fetch", fetch);
      await new DataService({ retryAttempts: 1 }).loadManifest();
      expect(fetch.mock.calls[0][0]).toBe(base + "data/manifest.json");
    }
  );

  it("preserves the production cache namespace and separates preview namespaces", () => {
    expect(siteCacheName("/zivv/")).toBe("zivv-data-v6");
    expect(siteCacheName("/zivv-test/")).not.toBe(siteCacheName("/zivv/"));
    expect(siteCacheName("/nested/preview/")).not.toBe(
      siteCacheName("/nested-preview/")
    );
  });

  it.each([
    "https://elsewhere.invalid/",
    "../",
    "/../",
    "/zivv",
    "/zivv/?x=1",
    "//example/",
  ])("rejects unsupported base %s", (base) => {
    expect(() => normalizeSiteBase(base)).toThrow("same-origin");
  });
});
