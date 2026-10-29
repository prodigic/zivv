import { selectedGmailLoadFile } from "./recovery-gmail-selected-load-executor.js";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

/** Write evidence before committing the ledger that refers to it. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  selectedGmailLoadFile(path, bytes);
  const temporary = `${path}.${randomUUID()}.tmp`;
  selectedGmailLoadFile(temporary, bytes);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx");
    selectedGmailLoadFile(temporary, bytes);
    writeFileSync(descriptor, bytes);
    selectedGmailLoadFile(temporary, bytes, "install");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    selectedGmailLoadFile(path, bytes);
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      selectedGmailLoadFile(temporary, bytes, "unlink");
      unlinkSync(temporary);
    } catch {
      /* Preserve write failure. */
    }
    throw error;
  }
}
