import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import * as admission from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import * as installation from "../../lib/ingestion/operator-installation.js";

function cleanupFixture(directory: string): void {
  const suffix = relative(resolve(tmpdir()), resolve(directory));
  if (
    !suffix ||
    suffix.startsWith("..") ||
    isAbsolute(suffix) ||
    !suffix.startsWith("zivv-capture-lease-deadline-")
  )
    throw new Error("Unsafe lease fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
}

describe("capture lease deadline calculation", () => {
  it("recomputes acquisition and renewal TTL after slow physical guard work", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "zivv-capture-lease-deadline-")
    );
    let journal: WeeklyRunJournal | undefined;
    try {
      let now = Date.now();
      const deadline = now + 60_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      journal = new WeeklyRunJournal(directory);
      // Exercise the real SQLite transactions while replacing only the pure
      // deadline query. This creates no recovery scope or capture permission.
      vi.spyOn(admission, "recoveredGmailCaptureLeaseTtl").mockImplementation(
        (ttl) => Math.min(ttl, deadline - now - 1000)
      );
      const writable = installation.assertOperatorInstallationWritable;
      vi.spyOn(
        installation,
        "assertOperatorInstallationWritable"
      ).mockImplementation((path, operation) => {
        writable(path, operation);
        now += 1500;
      });
      const lease = journal.acquire("prodigic/zivv/production");
      expect(lease.expiresAtEpochMs).toBeLessThanOrEqual(deadline);
      const renewed = journal.renew(lease);
      expect(renewed.expiresAtEpochMs).toBeLessThanOrEqual(deadline);
      journal.release(renewed);
    } finally {
      vi.restoreAllMocks();
      journal?.close();
      cleanupFixture(directory);
    }
  });
});
