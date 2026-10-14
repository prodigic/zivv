import { setImmediate } from "node:timers/promises";
import { afterEach } from "vitest";

// Synchronous SQLite, Git and filesystem fixtures can otherwise chain through
// promise microtasks long enough to starve Vitest's progress-RPC acknowledgements.
// Yield between every case; keep timeouts and unhandled-error reporting enforced.
afterEach(async () => {
  await setImmediate();
});
