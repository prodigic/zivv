import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const index = readFileSync("index.html", "utf8");
const fallback = readFileSync("public/404.html", "utf8");

function redirectFor(path: string) {
  let redirected = "";
  const location = new URL(`https://www.prodigic.com${path}`);
  const script = fallback.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    window: {
      location: Object.assign(location, {
        replace: (url: string) => {
          redirected = url;
        },
      }),
    },
  });
  return redirected;
}

describe("GitHub Pages route recovery", () => {
  it.each([
    "/zivv/newsletter/sfmusic",
    "/zivv/calendar/month?city=Oakland&search=rock%20show#october",
    "/zivv/events/2026-10-02-death-from-above-1979-the-uc-theater",
  ])("restores %s before the app starts", (path) => {
    const dom = new JSDOM(index, {
      url: redirectFor(path),
      runScripts: "dangerously",
    });
    expect(
      dom.window.location.pathname +
        dom.window.location.search +
        dom.window.location.hash
    ).toBe(path);
    dom.window.close();
  });
  it("preserves normal homepage query strings", () => {
    const url = "https://www.prodigic.com/zivv/?release=4962ef0#top";
    const dom = new JSDOM(index, { url, runScripts: "dangerously" });
    expect(dom.window.location.href).toBe(url);
    dom.window.close();
  });
});
