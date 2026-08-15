import { readSourceBundle } from "../source/reader.js";
import { normalizeSourceBundle } from "../normalization/model.js";
import { buildTemporalProjections } from "../derivations/projections.js";
import type { CanonicalModel, ETLRunConfig, NormalizationStageResult, TemporalProjectionModel } from "./types.js";

export interface PurePipelineResult extends NormalizationStageResult {
  model: CanonicalModel;
  projections: TemporalProjectionModel;
}

/**
 * Execute the source -> normalized canonical -> temporal projection stages
 * without creating or changing any output files. This is the entry point for
 * snapshot and incremental-load tests.
 */
export function runPurePipeline(projectRoot: string, config: ETLRunConfig = {}): PurePipelineResult {
  const timestamp = config.processingTimestamp ?? Date.now();
  const source = readSourceBundle(projectRoot, config);
  const normalized = normalizeSourceBundle(source, { timestamp, venueAliases: source.aliases });
  const projections = buildTemporalProjections(
    normalized.model.events,
    normalized.model.artists,
    normalized.model.venues,
    config.asOfEpochMs ?? timestamp
  );
  return { ...normalized, projections };
}
