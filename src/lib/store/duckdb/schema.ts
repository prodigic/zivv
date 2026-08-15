/**
 * Build-time schema only. This module is not imported by the React entrypoint.
 * Keep the SQL stable so schema changes can be reviewed independently of data.
 */
export const DUCKDB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  schema_version VARCHAR PRIMARY KEY,
  applied_at_epoch_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  snapshot_id VARCHAR PRIMARY KEY,
  sequence BIGINT NOT NULL,
  source_date DATE NOT NULL,
  source_checksum VARCHAR NOT NULL,
  dataset_version VARCHAR NOT NULL,
  schema_version VARCHAR NOT NULL,
  processed_at_epoch_ms BIGINT NOT NULL,
  as_of_epoch_ms BIGINT NOT NULL,
  status VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_source_lines (
  snapshot_id VARCHAR NOT NULL,
  source_name VARCHAR NOT NULL,
  source_line_number BIGINT NOT NULL,
  raw_text VARCHAR NOT NULL,
  parse_status VARCHAR NOT NULL,
  PRIMARY KEY (snapshot_id, source_name, source_line_number)
);

CREATE TABLE IF NOT EXISTS artists (
  stable_key VARCHAR PRIMARY KEY,
  legacy_id BIGINT NOT NULL,
  name VARCHAR NOT NULL,
  slug VARCHAR NOT NULL,
  normalized_name VARCHAR NOT NULL,
  aliases_json VARCHAR NOT NULL,
  created_at_epoch_ms BIGINT NOT NULL,
  updated_at_epoch_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  stable_key VARCHAR PRIMARY KEY,
  legacy_id BIGINT NOT NULL,
  name VARCHAR NOT NULL,
  slug VARCHAR NOT NULL,
  normalized_name VARCHAR NOT NULL,
  city VARCHAR NOT NULL,
  address VARCHAR NOT NULL,
  created_at_epoch_ms BIGINT NOT NULL,
  updated_at_epoch_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  stable_key VARCHAR PRIMARY KEY,
  legacy_id BIGINT NOT NULL,
  slug VARCHAR NOT NULL,
  event_date DATE NOT NULL,
  venue_stable_key VARCHAR NOT NULL,
  headliner_artist_stable_key VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  created_at_epoch_ms BIGINT NOT NULL,
  updated_at_epoch_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_artists (
  event_stable_key VARCHAR NOT NULL,
  artist_stable_key VARCHAR NOT NULL,
  billing_order INTEGER NOT NULL,
  is_headliner BOOLEAN NOT NULL,
  PRIMARY KEY (event_stable_key, artist_stable_key)
);

CREATE TABLE IF NOT EXISTS event_tags (
  event_stable_key VARCHAR NOT NULL,
  tag VARCHAR NOT NULL,
  PRIMARY KEY (event_stable_key, tag)
);

CREATE TABLE IF NOT EXISTS event_projections (
  event_stable_key VARCHAR NOT NULL,
  chunk_id VARCHAR NOT NULL,
  as_of_epoch_ms BIGINT NOT NULL,
  is_upcoming BOOLEAN NOT NULL,
  PRIMARY KEY (event_stable_key, as_of_epoch_ms)
);

CREATE TABLE IF NOT EXISTS directory_projections (
  entity_stable_key VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  upcoming_event_count BIGINT NOT NULL,
  as_of_epoch_ms BIGINT NOT NULL,
  PRIMARY KEY (entity_stable_key, entity_type, as_of_epoch_ms)
);

CREATE TABLE IF NOT EXISTS search_documents (
  document_key VARCHAR PRIMARY KEY,
  entity_stable_key VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  content VARCHAR NOT NULL
);
`;

export const DUCKDB_SCHEMA_STATEMENTS = DUCKDB_SCHEMA_SQL
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean)
  .map((statement) => `${statement};`);
