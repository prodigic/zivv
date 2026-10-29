import { join, resolve } from "node:path";

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
