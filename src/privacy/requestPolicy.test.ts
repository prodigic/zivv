import {
  createStaticReadRequest,
  PrivacyRequestError,
} from "./requestPolicy.ts";

describe("static request privacy boundary", () => {
  it("creates same-origin read-only requests with no referrer", () => {
    const request = createStaticReadRequest("/zivv/data/manifest.json");

    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("same-origin");
    expect(request.referrerPolicy).toBe("no-referrer");
    expect(new URL(request.url).origin).toBe(window.location.origin);
  });

  it("allows HEAD requests without a body", () => {
    const request = createStaticReadRequest("/data/manifest.json", {
      method: "HEAD",
    });

    expect(request.method).toBe("HEAD");
  });

  it("rejects cross-origin requests", () => {
    expect(() => createStaticReadRequest("https://example.test/data.json"))
      .toThrow(PrivacyRequestError);
  });

  it("rejects upload methods and request bodies", () => {
    expect(() => createStaticReadRequest("/data.json", { method: "POST" }))
      .toThrow(PrivacyRequestError);
    expect(() => createStaticReadRequest("/data.json", { body: "private action" }))
      .toThrow(PrivacyRequestError);
  });
});
