import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execute }));
import { createAuthoritativePromotionControlTransport } from "../../lib/ingestion/promotion-control-git.js";

const url = "https://github.com/prodigic/zivv.git";
const ref = "refs/heads/zivv-promotion-control/production";
const token = "ghp_fixture_secret";

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation((_binary: string, args: string[]) => {
    if (args.includes("--show-object-format")) return Buffer.from("sha1\n");
    if (args.includes("get-url") || args.includes("--get-url"))
      return Buffer.from(url + "\n");
    if (args.includes("--get-regexp"))
      throw Object.assign(new Error(), { status: 1 });
    if (args.includes("ls-remote")) return Buffer.alloc(0);
    throw new Error("Unexpected fixture command");
  });
});

describe("transient Actions promotion credentials", () => {
  it("passes an explicit header only to network Git, with no token in argv or config writes", () => {
    const transport = createAuthoritativePromotionControlTransport(
      process.cwd(),
      { token }
    );
    expect(transport.readHead(ref)).toBeNull();
    const calls = execute.mock.calls;
    const network = calls.find(([, args]) => args.includes("--refs"));
    expect(network).toBeDefined();
    expect(network?.[2].env).toMatchObject({
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: `http.${url}.extraheader`,
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: `http.${url}.followRedirects`,
      GIT_CONFIG_VALUE_3: "false",
      GIT_CONFIG_KEY_4: `http.${url}.sslVerify`,
      GIT_CONFIG_VALUE_4: "true",
      GIT_CONFIG_KEY_5: `credential.${url}.helper`,
      GIT_CONFIG_VALUE_5: "",
      GIT_ALLOW_PROTOCOL: "https",
    });
    for (const [, args, options] of calls) {
      expect(JSON.stringify(args)).not.toContain(token);
      expect(args).not.toContain("--add");
      if (!args.includes("--refs"))
        expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
    }
  });

  it("overrides hostile URL-specific repository policy using real Git matching", async () => {
    const { execFileSync } =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process"
      );
    createAuthoritativePromotionControlTransport(process.cwd(), {
      token,
    }).readHead(ref);
    const network = execute.mock.calls.find(([, args]) =>
      args.includes("--refs")
    );
    const directory = mkdtempSync(join(tmpdir(), "zivv-auth-policy-"));
    try {
      const config = join(directory, "config");
      writeFileSync(
        config,
        `[http "${url}"]\n extraHeader = X-Hostile: inherited\n followRedirects = true\n sslVerify = false\n[credential "${url}"]\n helper = hostile-helper\n`
      );
      const env = { ...network?.[2].env, GIT_CONFIG_GLOBAL: config };
      const read = (key: string) =>
        execFileSync("git", ["config", "--get-urlmatch", key, url], {
          env,
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      expect(read("http.followRedirects")).toBe("false");
      expect(read("http.sslVerify")).toBe("true");
      expect(read("http.extraHeader")).toBe(
        `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
      );
      expect(read("credential.helper")).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts subprocess failures which contain the credential", () => {
    const transport = createAuthoritativePromotionControlTransport(
      process.cwd(),
      { token }
    );
    const previous = execute.getMockImplementation();
    execute.mockImplementation((binary, args, options) => {
      if (args.includes("--refs")) throw new Error(token);
      return previous?.(binary, args, options);
    });
    expect(() => transport.readHead(ref)).toThrow(
      "Promotion Git transport failed"
    );
    try {
      transport.readHead(ref);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it.each(["", "a\nb", "a\0b", " ", "a".repeat(4097)])(
    "rejects malformed credentials before subprocesses",
    (value) => {
      expect(() =>
        createAuthoritativePromotionControlTransport(process.cwd(), {
          token: value,
        })
      ).toThrow("printable credential");
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("does not implicitly inherit GITHUB_TOKEN", () => {
    vi.stubEnv("GITHUB_TOKEN", token);
    try {
      createAuthoritativePromotionControlTransport(process.cwd()).readHead(ref);
      for (const [, , options] of execute.mock.calls) {
        expect(options.env.GITHUB_TOKEN).toBeUndefined();
        expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
