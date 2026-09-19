# Daily Paper project state

This is the canonical current-state ledger. It records verified integrated code separately from production status. Current integrated implementation is determined from the latest remote `origin/master`; workspaces, local branches, draft pull requests, archived experiments, and prior conversations are not integration evidence.

## Baseline

| Field | Value |
|---|---|
| Authoritative branch | `origin/master` |
| Implementation baseline verified before PR #44 | `c2551aacbcb5f6b878d77103192ffd641a29ecf1` |
| Last code/ref verification | `2026-09-20` (remote master, PRs #43–#47, integrated workflows) |
| Last production-log verification | `2026-09-19`; not a deployment check for later commits |
| GitHub repository | `linyuan701/daily-paper` |
| Verification evidence | Remote ref, current master code, merged pull requests, and GitHub Actions records |

Lifecycle values are `PLANNED`, `EXPERIMENTAL`, `IN DEVELOPMENT`, and `INTEGRATED`. Production values are `NOT_APPLICABLE`, `NOT_DEPLOYED`, `DEPLOYED`, `DEGRADED`, `ROLLED_BACK`, and `UNKNOWN`.

## Supported scope decision

The user confirmed cloud-only operation on 2026-09-19 (DPO-011): background work and CI execute on GitHub-hosted runners, using external network services; the online dashboard/API remains a Cloudflare Worker and persistent storage remains PostgreSQL/Neon. No user-PC application or always-on local service is part of the supported runtime.

Local Mode, Windows setup/scheduling/migration, SQLite production storage, Zotero Local API, desktop notifications, and Obsidian filesystem workflows are retired as support targets. Their code/data may still exist; retirement is a support decision, not a claim of code removal or authorization to delete user data. The dirty `codex/cloud-mode-a` workspace remains read-only archival material.

[PR #44](https://github.com/linyuan701/daily-paper/pull/44) records this architecture freeze; its GitHub merge record determines when it enters master. The implementation facts below are checked against the baseline above; no new runtime/deployment or cleanup is implied. PR #45's Site and PR #47's release/rollback implementations are separate unmerged work, not delivered by this decision.

## Integrated capability inventory

| Capability | Lifecycle | Production | Evidence |
|---|---|---|---|
| Agent Operating Model v1, persistent Coordinator/Reviewer/Statekeeper roles, and canonical project documentation | `INTEGRATED` | `NOT_APPLICABLE` | [PR #40](https://github.com/linyuan701/daily-paper/pull/40), merge `4b137ec96fdcd9e63574d497efbf64707c8a2a65`, `AGENTS.md`, `.codex/config.toml`, `.codex/agents/**`, and the four canonical documents |
| Zotero sync, collection priorities, and tag semantics | `INTEGRATED` | `UNKNOWN` | `src/modules/zotero-sync/**`, `src/modules/collections/**`, `src/modules/tagging/**`; no current sync-run evidence inspected |
| Profile snapshots and daily pre-recall refresh | `INTEGRATED` | `DEPLOYED` as part of the cloud daily path | `src/modules/profile-build/**`, `src/modules/scheduler/daily-pipeline.ts`; PR #39 and successful daily runs |
| Four-source daily ingestion with source-specific freshness and partial-source isolation | `INTEGRATED` | `DEGRADED` (intermittent arXiv failures in inspected September runs) | `src/modules/ingestion/**`; September 13–15 failure evidence below; September 19 has no arXiv failure in the inspected log |
| Journal enrichment, normalization, and canonical deduplication | `INTEGRATED` | `DEPLOYED` as part of the daily path | `src/modules/candidate-enrich/**`, `src/modules/normalize-dedupe/**` |
| Structured candidate labels and selected top-20 summaries | `INTEGRATED` | `DEPLOYED` as part of the daily path | `src/modules/summary/**`, `src/modules/scheduler/daily-pipeline.ts` |
| Profile-conditioned lexical recall, explainable rerank, and bounded dismiss penalties | `INTEGRATED` | `DEPLOYED` as part of the daily path | `src/modules/ranking/**`, `src/modules/feedback/negative-feedback.ts`; PRs #36, #37, #39 |
| PostgreSQL cloud persistence | `INTEGRATED` | `DEPLOYED` | `prisma/postgresql/schema.prisma`, `src/db/**`; SQLite code/history still exist but Local Mode support is retired under DPO-011 |
| Persisted stage recovery, request-key idempotency, lease fencing, and guarded manual fallback | `INTEGRATED` | `DEPLOYED` | `src/modules/pipeline-status/**`, ingestion repositories, `.github/workflows/daily.yml`; PRs #29 and #30 |
| GitHub scheduled/manual daily execution | `INTEGRATED` | `DEPLOYED` | `.github/workflows/daily.yml`; Actions run #35421549513 |
| Notification claim/deduplication with WeCom-first and SMTP fallback | `INTEGRATED` | Email path `DEPLOYED` | `scripts/daily-notifier.mjs`, `scripts/run-daily-cloud.ts`; latest run recorded `deliveryStatus=sent` |
| Cloudflare Worker dashboard and scheduled-dispatch code | `INTEGRATED` | `UNKNOWN` | `custom-worker.ts`, `src/cloudflare/daily-scheduler.ts`, `wrangler.jsonc`; deployment/dispatch not independently verified |
| Dashboard feedback, dismiss/save/promote actions, and content corrections | `INTEGRATED` | `UNKNOWN` | `src/app/api/feedback/**`, `src/app/api/candidates/content/**`, dashboard code; no current usage evidence inspected |

## Current production health

The latest verified daily run is [GitHub Actions run #35421549513](https://github.com/linyuan701/daily-paper/actions/runs/35421549513), created on 2026-09-19 against `d8552a0468a5970ee530195726f6c96e04b286b3`. The run:

- executed business date `2026-09-18`;
- completed with `complete_with_warnings`;
- persisted 20 recommendations; and
- sent the notification through email.

Known degradation:

- [PR #42](https://github.com/linyuan701/daily-paper/pull/42) integrated forwarding of `ARXIV_CATEGORY_SCOPES` into the daily workflow. The older missing-configuration finding is not the complete explanation for later failures.
- September [13](https://github.com/linyuan701/daily-paper/actions/runs/34738446333), [14](https://github.com/linyuan701/daily-paper/actions/runs/34807411049), and [15](https://github.com/linyuan701/daily-paper/actions/runs/34930238231) logs classified arXiv failure as request-stage timeout. The integrated adapter lacks successful-request pacing and full terminal attempt diagnostics; the exact external transport cause is unproven. [PR #43](https://github.com/linyuan701/daily-paper/pull/43) proposes pacing/body deadlines/diagnostics but is still unmerged.
- The September 19 log contains no arXiv failure; its visible warnings include missing EasyScholar enrichment configuration. A later run without an arXiv error does not prove that the intermittent issue or an unmerged fix is resolved.

Scheduling evidence:

- Recent daily executions are GitHub `schedule` events.
- The repository contains a Cloudflare Cron dispatcher intended to call `workflow_dispatch`, but recent run history does not prove that path is deployed or dispatching. Cloudflare deployment and dispatch status remain `UNKNOWN`.

## Active phases and development refs

| Phase/work | Lifecycle | Ref | Owner/evidence |
|---|---|---|---|
| Dashboard product experience | `IN DEVELOPMENT` | Draft PR [#21](https://github.com/linyuan701/daily-paper/pull/21) | PR author `linyuan701`; base `master` |
| Independent saved/promoted feedback states | `IN DEVELOPMENT` | Draft PR [#22](https://github.com/linyuan701/daily-paper/pull/22) | PR author `linyuan701`; base is PR #21's branch, not `master` |
| Recommendation limits | `IN DEVELOPMENT` | Draft PR [#24](https://github.com/linyuan701/daily-paper/pull/24) | PR author `linyuan701`; base is PR #21's branch |
| Source/ranking diagnostics | `IN DEVELOPMENT` | Draft PR [#25](https://github.com/linyuan701/daily-paper/pull/25) | PR author `linyuan701`; base is PR #21's branch |
| Scheduled production monitor | `IN DEVELOPMENT` | Draft PR [#28](https://github.com/linyuan701/daily-paper/pull/28) | PR author `linyuan701`; base `master` |
| arXiv request pacing and failure diagnostics | `IN DEVELOPMENT` | Draft PR [#43](https://github.com/linyuan701/daily-paper/pull/43) | Base `master`; unmerged, production recovery unverified |
| Site frontend and scoped API adapter | `IN DEVELOPMENT` | Draft PR [#45](https://github.com/linyuan701/daily-paper/pull/45) | Unmerged as of 2026-09-20; integration and deployment are not claimed |
| GitHub-controlled Worker release and rollback | `IN DEVELOPMENT` | Draft PR [#47](https://github.com/linyuan701/daily-paper/pull/47) | Unmerged as of 2026-09-20; integrated baseline still has preview-only CI |

Older draft PR references were verified on 2026-09-19; #43, #45 and #47 were rechecked on 2026-09-20. PR #44 freezes support scope and does not integrate these other branches.

Draft PRs are not integrated capabilities. Delivery ownership and continued intent beyond the recorded PR author are `UNKNOWN` until the Coordinator confirms them.

## UNKNOWN and evidence gaps

- Cloudflare Worker deployment, Cron trigger, dispatch token, and successful `workflow_dispatch` behavior.
- Exact external cause and durable recovery of intermittent arXiv request timeouts.
- GitHub-operated Worker production release/rollback workflow: absent from the integrated baseline; PR #47 is unmerged and preview CI is not deployment.
- GitHub-hosted backup/export/restore workflow and cloud recovery drill: absent/unverified; the historical workstation commands in the recovery runbook are not a cloud execution implementation.
- Removal of retained Local Mode defaults/scripts/schema/test dependencies: not implemented by the support decision. Local installation health is no longer a supported acceptance gap.
- Real production usage of dashboard feedback and content-correction endpoints.
- Whether the older draft PR stack remains intended for integration against current `master`.

See `docs/ARCHITECTURE.md` for implementation, `docs/ROADMAP.md` for non-integrated work, and `docs/DECISIONS.md` for accepted governance decisions.
