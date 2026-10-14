# Preserve ETL inside a resumable release orchestrator

Accepted October 14, 2026 for #42. Keep the existing authoritative SQLite catalog and static JSON browser exports. Define explicit ETL stages inside a resumable delivery orchestrator rather than combine import, deployment and publication acknowledgement into one transaction or replace storage as a prerequisite.

Import success and publication success are separate durable facts: a deployment failure must not erase accepted source history, reset first-added dates or force a second import. GitHub remains authoritative for code/reviews, with GitLab Pages as the planned deployment destination. The [stage contracts](../weekly-stage-contracts.md) define retries, private recovery state and the preserved manual path; they specify future orchestration behavior without activating it.
