# Source and ranking diagnostics

The source-ranking audit is an explicit, read-only maintenance command. It is not imported by the Dashboard, API routes, scheduler, ingestion adapters, ranking services, or Worker entrypoints.

Run it against an explicitly selected SQLite database and, optionally, a persisted run:

```powershell
npx tsx scripts/source-ranking-audit.mjs --db <sqlite-path> --run-id <run-id> --top-n 20
```

The command opens SQLite in read-only/query-only mode and verifies the database size, modified time, and SHA-256 before and after the audit. It never emits raw titles, abstracts, personal labels, or database candidate IDs. Candidate identifiers in the JSON report are deterministic 12-character SHA-256 prefixes scoped to the selected run.

## Report contents

- Source funnel counts for fetched, accepted, normalized, represented, recall candidate, rerank candidate, and final selected stages.
- Inclusive counts plus fractional attribution for canonical papers with multiple source provenances.
- Per-source mean and median feature scores.
- Journal metric states: observed, unavailable, enrichment failure, not applicable to a preprint, and unknown/unattempted.
- Recall Top 100, rerank Top 30, and final-selection source shares.
- Diagnostic-only `speciesContext` and `researchContext` labels. These labels do not participate in ranking.
- Current, journal-quality-zero, journal-quality-half, and missing-quality-neutral counterfactuals.
- Reliability fields that identify score-reproduction drift or a mismatch between the persisted selection and the replay baseline.

Counterfactuals must not be used to authorize a ranking change when `baselineMatchesPersistedSelection` is false. Missing journal metrics, source composition, and content-context labels are evidence for diagnosis only; the command does not change weights, source quotas, ranking gates, ingestion, or persisted application data.
