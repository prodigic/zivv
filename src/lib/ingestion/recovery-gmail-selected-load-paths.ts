import { join, resolve, sep } from "node:path";

export const selectedLoadHistoryLayout = {
  encryptedCatalog: { prefix: "history-catalog-", chunks: 128 },
  guardedJournal: { prefix: "history-journal-", chunks: 64 },
  inventory: { prefix: "history-inventory-", chunks: 8 },
} as const;
export const selectedLoadHistoryManifestFilename = "history-manifest.json";
export const selectedLoadCompletionIntentFilename = "completion-intent.json";

export function isSelectedLoadHistoryFilename(name: string): boolean {
  if (name === selectedLoadHistoryManifestFilename) return true;
  return Object.values(selectedLoadHistoryLayout).some(({ prefix, chunks }) => {
    if (!name.startsWith(prefix)) return false;
    const match = /^([0-9]{3})\.bin$/.exec(name.slice(prefix.length));
    return !!match && Number(match[1]) < chunks;
  });
}

function selectedLoadHistoryStagedFilename(path: string) {
  const match =
    /^(history-[a-z0-9.-]+|completion-intent\.json)-stage\/\1(?:\.\d+\.[a-f0-9]{16}\.tmp){1,2}$/.exec(
      path
    );
  const name = match?.[1];
  return name &&
    (isSelectedLoadHistoryFilename(name) ||
      name === selectedLoadCompletionIntentFilename)
    ? name
    : undefined;
}

/** Recognize a target or matching installer alias within one exact load root. */
export function selectedLoadHistoryAliasTarget(
  path: string
): string | undefined {
  const match = /^(recovery-gmail-load\/[a-f0-9]{64}\/)(.+)$/.exec(path);
  if (!match) return undefined;
  const name = match[2]!;
  if (
    isSelectedLoadHistoryFilename(name) ||
    name === selectedLoadCompletionIntentFilename
  )
    return path;
  const staged = selectedLoadHistoryStagedFilename(name);
  return staged ? match[1] + staged : undefined;
}

interface SelectedLoadPaths {
  operator: string;
  directory: string;
  report: string;
  snapshot: string;
  keyName: string;
}
/** Identify exact private temporary families without granting filesystem authority. */
export function selectedLoadTemporaryTarget(
  path: string,
  context: SelectedLoadPaths
): string | undefined {
  const absolute = resolve(path),
    suffix = /^(?:\.\d+\.[a-f0-9]{16}\.tmp){1,2}$/;
  for (const name of [
    "execution-baseline.json",
    "load-result.json",
    "resume-intent.json",
    context.keyName,
  ]) {
    const stage =
      name === context.keyName
        ? join(context.directory, "key-stage")
        : join(context.directory, name + "-stage");
    const prefix = join(stage, name);
    if (
      absolute.startsWith(prefix) &&
      suffix.test(absolute.slice(prefix.length))
    )
      return name === context.keyName
        ? join(context.operator, name)
        : join(context.directory, name);
  }
  const chunk =
    /^(.*[\\/])(resume-snapshot-[0-9]{3}\.bin)-stage[\\/]\2((?:\.\d+\.[a-f0-9]{16}\.tmp){1,2})$/.exec(
      absolute
    );
  if (chunk && resolve(chunk[1]!) === resolve(context.directory))
    return join(context.directory, chunk[2]!);
  const directory = resolve(context.directory);
  const history = absolute.startsWith(directory + sep)
    ? selectedLoadHistoryStagedFilename(
        absolute
          .slice(directory.length + 1)
          .split(sep)
          .join("/")
      )
    : undefined;
  if (history) return join(context.directory, history);
  const successor =
    /^(resume-successor-([0-9]{5})\.json)-stage[\\/]\1((?:\.\d+\.[a-f0-9]{16}\.tmp){1,2})$/.exec(
      absolute.slice(directory.length + 1)
    );
  if (
    successor &&
    Number(successor[2]) >= 1 &&
    Number(successor[2]) <= 10000 &&
    absolute ===
      resolve(
        context.directory,
        successor[1] + "-stage",
        successor[1] + successor[3]
      )
  )
    return join(context.directory, successor[1]!);
  const snapshot = resolve(context.snapshot),
    report = resolve(context.report);
  if (
    absolute.startsWith(snapshot) &&
    /^\.\d+\.[a-f0-9]{16}\.tmp$/.test(absolute.slice(snapshot.length))
  )
    return snapshot;
  if (
    absolute.startsWith(report) &&
    /^\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
      absolute.slice(report.length)
    )
  )
    return report;
  return undefined;
}
