# Daily Paper roadmap

This canonical roadmap contains only non-integrated work: `PLANNED`, `IN DEVELOPMENT`, and `EXPERIMENTAL`. Presence in a workspace or draft pull request does not make a capability integrated. `docs/PROJECT_STATE.md` owns integrated and production state.

Scope as of 2026-09-19: DPO-011 supports only GitHub-hosted background execution and external cloud services. Local runtime support, Windows migration/installation/scheduling, SQLite production parity, desktop notifications, and Obsidian filesystem workflows are abandoned work, not future delivery commitments. Retained code and runner-only test fixtures do not reopen that scope.

## PLANNED

| Item | Phase | Owner | Dependency | Acceptance gate | Ref/archive evidence |
|---|---|---|---|---|---|
| Verify Cloudflare Cron deployment and GitHub dispatch path | Production Reliability | Primary to assign production/scheduler specialist | Authorized read-only Cloudflare/GitHub evidence; live mutation requires separate approval | Deployment/trigger evidence and observed safe dispatch or an explicit `UNKNOWN` disposition | Scheduler code is integrated; deployment state is `UNKNOWN` |
| Adapt backup/export/restore execution to cloud-only operations | Cloud Operations / Data Safety | Primary to assign recovery work | Private encrypted storage, retention, secrets and restore contract | Reviewed GitHub-hosted workflow and disposable recovery drill; no local operator tools or public data artifacts | Existing recovery runbook retains historical workstation commands; no integrated recovery workflow |
| Remove obsolete Local Mode code dependencies | Cloud Maintenance | Primary to coordinate | Inventory shared imports, Prisma generation, tests, scripts, and local defaults | Cloud paths and meaningful CI gates preserved; no user-data deletion or migration-history rewrite | DPO-011 changes support scope; cleanup is not yet implemented |
| Establish ranking and feedback evaluation contract | Retrieval Evaluation / Feedback Learning | Primary to coordinate ranking and feedback specialists | Frozen metrics, dataset/evidence boundaries, model/version semantics | Reproducible baseline metrics and reviewer-approved acceptance thresholds before algorithm changes | Archive contains experiments, reference-only |
| Reconcile older draft PR stack with current master | Project Governance | Primary / Coordinator | Confirm continued product intent and current-master compatibility | Each PR is rebased/reimplemented or explicitly closed through a separate decision; no automatic integration claims | Draft PRs #21, #22, #24, #25 |

## IN DEVELOPMENT

| Item | Phase | Owner/evidence | Dependency | Acceptance gate | Ref |
|---|---|---|---|---|---|
| Dashboard product experience | Product Experience | PR author `linyuan701`; delivery owner otherwise `UNKNOWN` | Current feed/UI contract | Reconcile against current master, focused tests, independent review | Draft PR #21 |
| Independent saved/promoted states | Feedback Learning | PR author `linyuan701`; delivery owner otherwise `UNKNOWN` | PR #21 branch and frozen feedback semantics | Semantic review, persistence/API tests, master integration | Draft PR #22 |
| Recommendation limits | Product Experience | PR author `linyuan701`; delivery owner otherwise `UNKNOWN` | PR #21 branch and frozen recommendation contract | Contract, UI/API tests, master integration | Draft PR #24 |
| Source/ranking diagnostics | Retrieval Evaluation | PR author `linyuan701`; delivery owner otherwise `UNKNOWN` | PR #21 branch and current persisted ranking fields | Evidence correctness, read-only safety, master integration | Draft PR #25 |
| Scheduled production monitor | Production Reliability | PR author `linyuan701`; delivery owner otherwise `UNKNOWN` | Current workflow and notification semantics | Safe monitoring contract, no production mutation, reviewer readiness | Draft PR #28 |
| arXiv pacing, body deadlines, and request diagnostics | Production Reliability | Primary / PR #43 | Existing freshness/watermark contract and CI | Focused adapter/retry/ingestion tests, independent review, merge, then healthy production evidence | Draft PR #43; not deployed |
| Site frontend and scoped API adapter | Product Experience | PR #45 | Frozen cloud API/Access contract | Independent review, CI, merge and separate deployment evidence | Draft PR #45; unmerged as of 2026-09-20 |
| GitHub-operated Worker release and rollback | Cloud Operations | PR #47 | Reviewed release contract, protected credentials, Access and PostgreSQL compatibility | Deploy/rollback from GitHub-hosted execution after merge and authorized production verification | Draft PR #47; unmerged as of 2026-09-20; current integrated workflow only builds/previews |

The support-scope decision itself is recorded in DPO-011 and PR #44. It does not implement or deploy the product and operations work listed here.

## EXPERIMENTAL

`codex/cloud-mode-a` is a read-only experimental archive. Its branch/worktree must not be rebased, merged, repaired, revived, or treated as a development baseline. Any idea below requires a new task from current `origin/master`, individual product/architecture review, and fresh validation.

| Experiment | Integrated? | Archived implementation | Promotion requirement |
|---|---|---|---|
| BM25 retrieval | No | Yes | Evaluation contract and independent current-master implementation |
| Dense embeddings / embedding cache | No | Yes | Provider/privacy/cost/cache decision plus evaluation gate |
| Retrieval and production-feedback evaluation | No | Yes | Dataset provenance, metrics, and acceptance thresholds |
| Candidate quality filtering | No | Yes | Source/quality semantics and false-positive evaluation |
| Global paper identity / cross-run suppression | No | Yes | Identity, migration, retention, and user-experience contract |
| Additional feedback/profile-learning experiments | No | Yes | Positive/negative feedback semantics and reproducible evaluation |
| Archived agent configuration | No | Yes | Superseded as authority by Agent Operating Model v1; useful only as historical reference |

No experimental row is a promise to ship. Statekeeper may move an item only when the required evidence supports the lifecycle transition.

Obsidian filesystem feedback sync and Windows setup/scheduler/backup experiments have been removed from the candidate list under DPO-011. Their historical files remain read-only references. Reopening them requires a new user product decision, not routine archive migration.
