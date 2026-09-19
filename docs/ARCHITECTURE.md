# Daily Paper integrated architecture

Implementation baseline verified before the architecture freeze: `origin/master@c2551aacbcb5f6b878d77103192ffd641a29ecf1`, checked 2026-09-20. PR #44 formalizes the cloud-only support decision DPO-011 separately from code presence: legacy local code remains integrated but is no longer a supported runtime. Historical designs and experimental workspaces are not architecture evidence. Later integrated implementation must be reconciled explicitly.

## System topology

Daily Paper is a single-user literature-triage application with two coupled data flows:

```text
Zotero sync → collection priority + tag semantics → profile snapshot
                                                        ↓
source retrieval → enrichment → normalize/dedup → labels → profile refresh
                                                        ↓
                                      recall → rerank → summaries
                                                        ↓
                              persisted feed → notification/dashboard
                                                        ↓
                                      feedback → later profile refresh
```

The profile and daily pipelines remain separate services. The daily pipeline now performs a scheduled profile refresh immediately before recall so prior feedback and current Zotero state are bound to the recall snapshot.

### Cloud execution boundary

GitHub-hosted Actions runners execute the background pipelines and network calls to paper sources, Zotero Web API, LLM/enrichment providers, notification providers, and PostgreSQL. Cloudflare Workers provides the authenticated dashboard and short APIs against the same network database. A browser is the user's interaction surface; no user-PC application, database, local API, or always-on scheduler supports this runtime.

`daily.yml` and `profile.yml` explicitly select cloud mode, Zotero Web transport, and disabled Obsidian/desktop capabilities. Cloud configuration rejects incompatible local capabilities. Source/provider failure is surfaced through existing failure and partial-result contracts, not repaired by falling back to a local service.

Zotero sync is a separate manual profile-workflow operation. The daily pre-recall refresh consumes the already-persisted Zotero library and feedback, not a fresh Zotero sync.

## Source retrieval and candidate freshness

`src/modules/scheduler/daily-pipeline.ts::runDailyRecommendationPipeline` invokes `src/modules/ingestion/factory.ts::createDailyIngestionService`. The default aggregate run includes bioRxiv, arXiv, PubMed, and configured journal feeds.

`DefaultDailyIngestionService::runAggregatedIngestion` fetches configured sources concurrently and isolates per-source failures. At least one successful source can produce a partial ingestion stage and allow the pipeline to continue.

Freshness is source-specific rather than one universal publication-date rule:

- PubMed uses the requested UTC day and prefers indexed/EDAT evidence.
- arXiv uses configured category scopes and watermark/date-range retrieval with bounded paging and retry handling.
- bioRxiv and journal feeds use persistent first-seen/cursor state with bounded overlap for initial or recovery intake.

`src/modules/ingestion/new-today.ts::resolveUtcDayWindow` resolves an explicit UTC business date; without one it selects the previous UTC day. Adapters normalize external identifiers and basic metadata before persistence.

## Enrichment, normalization, and representation

`DefaultJournalEnrichmentService::enrichRun` adds journal metadata through the configured enrichment provider and cache. Entry-level failures make the stage partial rather than discarding all candidates.

`DefaultCandidateNormalizationService::runForIngestionRun` groups records by DOI, normalized title/URL, normalized title, then source/external ID. It selects a richer canonical record and retains merged source provenance.

`DefaultCandidateOutputService::generateLabelsForRun` creates structured content-recall and research-type labels. After ranking, `generateSummariesForRun({ selectedOnly: true, limit: 20 })` generates four-field output only for selected recommendations. Provider failure and user-corrected content have explicit persistence states.

## Zotero profile construction

The profile flow comprises:

- `src/modules/zotero-sync/**`: Zotero item and collection synchronization.
- `src/modules/collections/**`: primary, secondary, and excluded collection boundaries with inherited priorities and child overrides.
- `src/modules/tagging/tag-parser.ts::parseZoteroTagSemantics`: Unicode star attention (`⭐` or `★`), structured `#` content tags, and other tags.
- `src/modules/profile-build/profile-build.service.ts::DefaultProfileBuildService.buildSnapshot`: immutable active profile snapshots.

Only items in effective primary or secondary collections are eligible. Primary collection weight is 1.0 and secondary is 0.7. Attention weight is `1 + attentionLevel × 0.6`; recency contributes a smaller tiered component. Items are divided into recent-core, stable-long-term, and background segments. Structured tags are preferred as item representation, with title/abstract fallback.

`ProfileRefreshService::runScheduledRefresh` runs at the recall stage of the daily pipeline. The resulting snapshot ID is passed to recall, preventing recall from silently using a different active snapshot.

## Recall and rerank

`src/modules/ranking/recall/recall-ranking.service.ts::DefaultRecallRankingService.runRecall` selects up to 100 candidates. The integrated implementation is lexical and explainable: it combines token/profile overlap, content-tag overlap, research-type preference, source scope, profile-conditioned topic alignment, context penalties, and bounded dismiss similarity penalties. The stored field named `semanticScore` is currently token overlap, not embedding inference.

`src/modules/ranking/rerank/rerank.service.ts::DefaultRerankService.runRerank` selects up to 20. It combines recall, recent/stable/high-attention profile overlap, labels, research type, collection/source/journal signals, recency, and user-corrected output. It persists final score, feature values/weights, and reason codes. The dismiss penalty is already reflected in recall; rerank records that reason without applying the penalty twice.

BM25, dense embeddings, hybrid fusion, retrieval evaluation, global paper identity, and archive-only candidate-quality logic are not part of this integrated architecture.

## Feedback and learning loop

`src/app/api/feedback/actions/route.ts` records save, dismiss, and promote actions. `src/app/api/candidates/content/route.ts` persists label or summary corrections and corresponding feedback logs. The dashboard folds the latest action for a run and hides dismissed cards.

At profile refresh:

- the latest triage action per paper identity produces bounded negative signals when it is dismiss;
- a later save/promote cancels that dismiss state;
- label edits can boost research-category preferences for the refresh interval; and
- feedback metadata and bounded negative representations are stored in the profile summary.

Save/promote do not currently provide a direct positive ranking weight. Summary edits, click/read behavior, and keyword hints are not an online learning model.

## Daily orchestration and stage recovery

The persisted stage order is:

```text
ingestion → enrichment → normalization → representation
→ profile refresh + recall → rerank → summary
```

`src/modules/pipeline-status/**` stores stage outcomes and finds the first incomplete stage for resume. Ingestion and enrichment may be partial warnings; downstream failures remain recoverable. Attempt fencing prevents a stale runner from writing after another attempt acquires the same business run.

The business request key is derived from sorted sources and UTC business date. A unique key, persisted attempt/lease state, stage rows, and stable rerank request key provide business idempotency. GitHub Actions concurrency is an additional queue, not the final idempotency boundary.

## Persistence boundaries

PostgreSQL is the supported production store. Source still contains two independent Prisma roots:

| Mode | Schema | Migration history | Runtime |
|---|---|---|---|
| Retired Local Mode | `prisma/schema.prisma` | `prisma/migrations/**` | Legacy SQLite client and existing test dependencies; no production support |
| Supported cloud runtime | `prisma/postgresql/schema.prisma` | `prisma/postgresql/migrations/**` | PostgreSQL/Neon and Node/Worker clients |

Changing only `DATABASE_URL` does not switch schema providers. Applied migrations are append-only operational history; production uses `prisma migrate deploy`, never `migrate dev`.

Existing schema-parity tests are a code dependency until a reviewed cleanup replaces them. They are not an ongoing requirement to deliver Local Mode features. Do not delete or rewrite migration history as part of retiring local support.

## Scheduling and production execution

`.github/workflows/daily.yml` is both the native scheduled path and guarded manual fallback. It validates the UTC business date, checks persisted state before migrations, conditionally deploys PostgreSQL migrations, then runs `scripts/run-daily-cloud.ts`. Its concurrency group includes the business date and does not cancel an active run.

`wrangler.jsonc` configures a Cloudflare Cron. `custom-worker.ts::scheduled` calls `src/cloudflare/daily-scheduler.ts::handleDailySchedule`, which dispatches the same GitHub workflow at `master` with an explicit business date, a bounded timeout, sanitized logging, and no Cloudflare automatic retry. The GitHub native schedule is the second clock into the same persisted execution path.

The repository proves both paths are integrated. Actual Cloudflare deployment and successful dispatch require external runtime evidence and are currently `UNKNOWN` in `docs/PROJECT_STATE.md`.

CI and `cloudflare-preview.yml` run on GitHub-hosted Ubuntu. The preview workflow builds, scans, and starts disposable workerd for HTTP smoke tests; it never deploys production. A GitHub-operated Worker release/rollback workflow is still absent from the integrated baseline. PR #47 proposes that implementation; PR #45 proposes a Site frontend and scoped API adapter. Both are unmerged as of 2026-09-20. Neither is part of this integrated architecture or proven deployed by the support decision.

Cloud backup/recovery invariants remain relevant, but the old workstation export/restore commands do not satisfy this execution boundary. GitHub-hosted recovery automation and its private storage/credential contract remain planned; provider-console operations and production mutations still require their normal authorization and verification.

## Retired local components

DPO-011 retires these responsibilities as of 2026-09-19:

| Legacy surface | Disposition / supported replacement |
|---|---|
| Local Next.js server and `localhost` job/MVP endpoints | Abandoned product runtime; Worker short APIs and Actions jobs |
| SQLite production database and Windows-to-Windows data migration | Retained historical code/data, no support or parity promise; PostgreSQL is the cloud store |
| Zotero Desktop / Local API / automatic local fallback | Abandoned integration path; GitHub jobs use Zotero Web API |
| Windows setup/doctor, Task Scheduler, scheduler loop, local job wrappers | Abandoned operations path; GitHub workflows and persisted job guards |
| Windows Toast / desktop notifications | Abandoned notification path; job-side network notification providers |
| Obsidian vault export, filesystem sync, local feedback experiments | Abandoned product proposals; cloud dashboard feedback remains supported |
| Local backups/import proposals and Windows-specific build/preview workarounds | Historical reference; cloud recovery and GitHub CI are the support targets |

The code still accepts local deployment settings and defaults to local when `DEPLOYMENT_MODE` is absent. Supported cloud entry points set it explicitly. A future cleanup must inventory shared imports, Prisma generation, and test dependencies before removing local code; this documentation change does not remove those branches or alter defaults.

Retirement does not delete databases, libraries, vault files, backups, credentials, scheduled tasks, or the read-only `codex/cloud-mode-a` archive. Disposable runner test databases, loopback HTTP servers, and temporary build artifacts remain legitimate cloud CI implementation details. Cloud failure recovery uses persisted retry/restore/rollback procedures, never Local Mode scheduling.

## Notification and dashboard

After a persisted run, `scripts/run-daily-cloud.ts` builds the recommendation notification. `scripts/daily-notifier.mjs` prefers WeCom and falls back to SMTP. Notification failure does not roll back the recommendation run.

Delivery is claimed atomically. `SENT` and legacy-suppressed runs are not resent; `SENDING` represents an ambiguous outcome and is conservatively blocked from automatic duplication. A configuration skip releases its claim, while a provider failure retains the ambiguous state for operator reconciliation.

The Next.js dashboard reads the latest persisted feed. In Cloud Mode, OpenNext runs it in a Cloudflare Worker protected by Cloudflare Access, while GitHub Actions performs long-running daily work directly against PostgreSQL.

## Architectural invariants

- The verified `origin/master` implementation is authoritative over historical architecture prose.
- Profile construction and daily retrieval remain separate domain services.
- Collection selection is a profile boundary, not merely a ranking hint.
- Source freshness is explicit and source-specific.
- Recall and rerank are separate, persisted, explainable stages.
- User-corrected content is not silently overwritten.
- PostgreSQL migrations remain safe and append-only. Retained SQLite history and user data are not modified to enforce the cloud-only support policy.
- Production jobs require GitHub-hosted execution and network providers; no user-PC dependency or Local Mode fallback is supported.
- The Worker does not run migrations or the long daily pipeline.
- Production and user-data mutations require explicit authorization.
