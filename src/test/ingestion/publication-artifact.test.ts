import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  retainPublicationArtifact,
  type PublicationArtifactTransport,
} from "../../lib/ingestion/publication-artifact.js";
import { writePublicationPayloadGit } from "../../lib/ingestion/publication-git.js";
import { createBareTestPromotionControlTransport } from "../../lib/ingestion/promotion-control-git.js";
import { publicationTransportFixture } from "./fixtures/publication-transport-fixture.js";

describe("immutable remote publication artifact retention", () => {
  let directory: string,
    repositoryRoot: string,
    remote: string,
    payloadCommit: string,
    otherCommit: string,
    ref: string;
  let transport: PublicationArtifactTransport;
  const fixture = publicationTransportFixture();
  const git = (root: string, args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-artifact-retention-"));
    repositoryRoot = join(directory, "source");
    remote = join(directory, "remote.git");
    mkdirSync(repositoryRoot);
    git(repositoryRoot, ["init", "--quiet"]);
    git(repositoryRoot, [
      "remote",
      "add",
      "origin",
      "https://github.com/prodigic/zivv.git",
    ]);
    git(directory, ["init", "--bare", "--quiet", remote]);
    payloadCommit = writePublicationPayloadGit({
      repositoryRoot,
      files: fixture.payload.files,
      createdAt: "2026-10-14T23:00:00.000Z",
    }).payloadCommit;
    otherCommit = writePublicationPayloadGit({
      repositoryRoot,
      files: fixture.payload.files,
      createdAt: "2026-10-14T23:00:01.000Z",
    }).payloadCommit;
    transport = createBareTestPromotionControlTransport(repositoryRoot, remote);
    ref = "refs/heads/zivv-candidate-artifacts/" + payloadCommit;
  }, 30_000);
  beforeEach(() => {
    git(remote, ["update-ref", "-d", ref]);
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const retain = (chosen = transport, expectation = fixture.expectation) =>
    retainPublicationArtifact({
      repositoryRoot,
      payloadCommit,
      transport: chosen,
      ...expectation,
    });

  it("retains and replays one exact artifact without writing normal source refs", () => {
    let writes = 0;
    const counted = {
      ...transport,
      append: (...args: Parameters<PublicationArtifactTransport["append"]>) => {
        writes++;
        transport.append(...args);
      },
    };
    expect(retain(counted)).toMatchObject({
      status: "retained",
      payloadCommit,
      observedHead: payloadCommit,
    });
    expect(retain(counted).status).toBe("retained");
    expect(writes).toBe(1);
    expect(git(repositoryRoot, ["for-each-ref", "--format=%(refname)"])).toBe(
      ""
    );
  }, 30_000);
  it("recovers a lost push response through exact remote identity", () => {
    const lost = {
      ...transport,
      append: (...args: Parameters<PublicationArtifactTransport["append"]>) => {
        transport.append(...args);
        throw new Error("lost response");
      },
    };
    expect(retain(lost).status).toBe("retained");
  }, 30_000);
  it("retains uncertainty after no confirmed write and retries only its same immutable ref", () => {
    const unavailable = {
      ...transport,
      append: () => {
        throw new Error("offline");
      },
    };
    expect(retain(unavailable)).toMatchObject({
      status: "uncertain",
      observedHead: null,
    });
    expect(retain().status).toBe("retained");
  }, 30_000);
  it("does not claim success when post-push observation is unavailable", () => {
    let reads = 0;
    const unavailable = {
      ...transport,
      readHead: (key: string) => {
        if (++reads > 1) throw new Error("readback unavailable");
        return transport.readHead(key);
      },
    };
    expect(retain(unavailable).status).toBe("uncertain");
    expect(retain().status).toBe("retained");
  }, 30_000);
  it("refuses a conflicting artifact head without replacing it", () => {
    git(repositoryRoot, ["push", remote, otherCommit + ":" + ref]);
    expect(retain()).toMatchObject({
      status: "conflict",
      observedHead: otherCommit,
    });
    expect(transport.readHead(ref)).toBe(otherCommit);
  }, 30_000);
  it("rejects changed trusted identity or wrong authority before any remote write", () => {
    expect(() =>
      retain(transport, {
        ...fixture.expectation,
        expectedCandidateId: "0".repeat(64),
      })
    ).toThrow();
    expect(() =>
      retain({
        ...transport,
        repository: "prodigic/zivv-test",
      } as unknown as PublicationArtifactTransport)
    ).toThrow("authoritative");
    expect(transport.readHead(ref)).toBe(null);
  }, 30_000);

  it("runs the actual retention/verification CLI, saves exact intent and refuses changed intent", () => {
    const script = resolve("scripts/retain-publication-artifact.js");
    const intentDirectory = join(directory, "private-intents");
    const args = [
      "--root",
      repositoryRoot,
      "--transport",
      "bare-test",
      "--bare-path",
      remote,
      "--payload-commit",
      payloadCommit,
      "--candidate-id",
      fixture.expectation.expectedCandidateId,
      "--source-commit",
      fixture.expectation.expectedSourceCommit,
      "--purpose",
      "release",
      "--base",
      "/zivv/",
    ];
    const prepared = JSON.parse(
      execFileSync(
        process.execPath,
        [script, "retain", ...args, "--intent-dir", intentDirectory],
        { encoding: "utf8", windowsHide: true }
      )
    );
    expect(prepared).toMatchObject({ status: "retained", payloadCommit });
    const intentFiles = readdirSync(intentDirectory);
    expect(intentFiles).toEqual([prepared.intentId + ".json"]);
    const saved = readFileSync(join(intentDirectory, intentFiles[0]));
    expect(JSON.parse(saved.toString())).toMatchObject({
      payloadCommit,
      expectedCandidateId: fixture.expectation.expectedCandidateId,
    });
    const verified = JSON.parse(
      execFileSync(process.execPath, [script, "verify", ...args], {
        encoding: "utf8",
        windowsHide: true,
      })
    );
    expect(verified).toMatchObject({
      status: "retained",
      payloadCommit,
      receiptId: fixture.payload.receipt.receiptId,
    });
    expect(
      execFileSync(
        process.execPath,
        [script, "retain", ...args, "--intent-dir", intentDirectory],
        { encoding: "utf8", windowsHide: true }
      )
    ).toContain(prepared.intentId);
    writeFileSync(join(intentDirectory, intentFiles[0]), "changed");
    expect(() =>
      execFileSync(
        process.execPath,
        [script, "retain", ...args, "--intent-dir", intentDirectory],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      )
    ).toThrow();
    expect(transport.readHead(ref)).toBe(payloadCommit);
  }, 60_000);
});
