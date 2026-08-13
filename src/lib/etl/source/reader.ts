import { existsSync, readFileSync, statSync } from "fs";
import { basename, isAbsolute, join } from "path";
import type { SourceFileInfo } from "@/types/data.js";
import type { ETLInputConfig, SourceBundle } from "../pipeline/types.js";

export function readSourceBundle(
  projectRoot: string,
  config: ETLInputConfig = {}
): SourceBundle {
  const inputDir = config.inputDir ?? join(projectRoot, "data");
  const eventsPath = resolveSourcePath(inputDir, config.eventsPath ?? config.eventsFile ?? "events.txt");
  const venuesPath = resolveSourcePath(inputDir, config.venuesPath ?? config.venuesFile ?? "venues.txt");
  const aliasesPath = config.aliasesPath
    ? resolveSourcePath(inputDir, config.aliasesPath)
    : join(inputDir, "venue-aliases.json");

  const eventsContent = readRequired(eventsPath);
  const venuesContent = readRequired(venuesPath);
  const aliases = readOptionalJson(aliasesPath);

  return {
    eventsContent,
    venuesContent,
    sourceFiles: {
      events: describeSource(eventsPath, eventsContent),
      venues: describeSource(venuesPath, venuesContent),
    },
    aliases,
  };
}

function resolveSourcePath(baseDir: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? configuredPath : join(baseDir, configuredPath);
}

function readRequired(filepath: string): string {
  if (!existsSync(filepath)) throw new Error(`Source file not found: ${filepath}`);
  return readFileSync(filepath, "utf-8");
}

function readOptionalJson(filepath: string): Record<string, string> {
  if (!existsSync(filepath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(filepath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function describeSource(filepath: string, content: string): SourceFileInfo {
  const stats = statSync(filepath);
  return {
    filename: basename(filepath),
    size: stats.size,
    lastModified: stats.mtime.getTime(),
    lineCount: content.split("\n").length,
    checksum: stableChecksum(content),
  };
}

export function stableChecksum(data: string): string {
  let hash = 0;
  for (let index = 0; index < data.length; index += 1) {
    hash = (hash << 5) - hash + data.charCodeAt(index);
    hash |= 0;
  }
  return `sha256-${Math.abs(hash).toString(16)}`;
}
