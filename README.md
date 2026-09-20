# Daily Paper

Daily literature triage centered on Zotero, with a separate profile pipeline and a persisted daily recommendation pipeline.

## Supported operation: cloud only

**Daily Paper runs without a user computer supporting the service.** Since the 2026-09-19 decision, GitHub-hosted Actions is the execution environment for background jobs and CI. Windows/Local Mode installation, local SQLite storage, Zotero Desktop API, local schedulers, desktop notifications, and Obsidian filesystem workflows are retired. Remaining local code and old instructions are legacy material, not supported setup or recovery paths.

The cloud services have distinct responsibilities:

| Responsibility | Runtime / dependency |
|---|---|
| Source retrieval, enrichment, LLM labels/summaries, recall, rerank, notification | GitHub Actions: [daily.yml](.github/workflows/daily.yml), using external network APIs |
| Zotero sync and manual profile maintenance | GitHub Actions: [profile.yml](.github/workflows/profile.yml), using Zotero Web API |
| Durable library, profiles, recommendations, feedback, run/notification state | Managed PostgreSQL/Neon |
| Authenticated dashboard and short read/write APIs | Cloudflare Worker + Cloudflare Access |
| Optional Cron/retry dispatch | Worker dispatches the same GitHub daily workflow |
| Tests, dependency audit, Worker build and preview | GitHub Actions: [ci.yml](.github/workflows/ci.yml), [cloudflare-preview.yml](.github/workflows/cloudflare-preview.yml) |

GitHub executes the jobs; Cloudflare, PostgreSQL, Zotero, paper sources, LLM providers, and notification providers remain network services. Runner-local test databases, loopback smoke tests, and build artifacts are disposable CI resources and do not require an application on the user's computer.

## Project documentation

- [Current integrated and production state](docs/PROJECT_STATE.md)
- [Current architecture and retired local components](docs/ARCHITECTURE.md)
- [Planned, in-development, and experimental work](docs/ROADMAP.md)
- [Accepted decisions and rationale](docs/DECISIONS.md#dpo-011--cloud-only-operation-and-local-mode-retirement)

The latest remote `origin/master` is the authoritative integrated code baseline. A draft PR is not integrated, and integrated code alone does not prove deployment or healthy production.

## Configure and operate through the cloud

1. Configure managed PostgreSQL and a GitHub Actions environment named `production`. Store credentials in service Secrets, not a local `.env` or the repository.
2. Set GitHub Secrets `DATABASE_URL`, `ZOTERO_ID`, `ZOTERO_KEY`, and the credential for the selected LLM provider. For DeepSeek, use `DEEPSEEK_API_KEY` with Variables `LLM_PROVIDER=deepseek`, `LLM_BASE_URL=https://api.deepseek.com`, and `LLM_MODEL=deepseek-v4-flash`. See the [Actions configuration runbook](docs/cloud-mode-a-github-actions.md) and [LLM configuration](docs/deepseek-official-llm.md).
3. Configure source scopes, including `ARXIV_CATEGORY_SCOPES`, in the workflow's GitHub Environment Variables. `PUBMED_QUERY_SCOPE` has a focused genomics default in code; the workflow must explicitly forward any new configurable variable before it can affect a job.
4. For a new database, run **Cloud profile maintenance** with `operation=sync`. Use the Access-protected `/collections` page to select at least one primary or secondary collection, then run `operation=refresh` for bootstrap validation. Daily execution also refreshes the profile before recall using already-synced library data and stored feedback; it does not sync Zotero each day.
5. **Cloud daily recommendations** runs on the committed schedule (08:15 `Asia/Shanghai`; actual start can be delayed). Manual execution requires a strict UTC business date `runDate=YYYY-MM-DD`; follow the [guarded manual fallback](docs/production-daily-manual-fallback.md) to preserve idempotency.
6. Configure optional WeCom or SMTP credentials in GitHub. Notifications follow persisted results; a delivery failure does not roll back the feed. View workflow results and the authenticated `/operations` page for warnings and retry eligibility.

The workflows explicitly use `DEPLOYMENT_MODE=cloud`, `ZOTERO_TRANSPORT=web`, `OBSIDIAN_ENABLED=false`, and `SCHEDULER_DESKTOP_NOTIFICATION_ENABLED=false`. They validate/generate the PostgreSQL client and deploy its migration history on the runner. Long jobs do not call the Worker daily/MVP APIs.

## Dashboard and release boundary

OpenNext runs the Next.js dashboard and short APIs in a Cloudflare Worker using the same PostgreSQL database. Cloudflare Access and application JWT checks protect the owner-only service. The Worker does not run migrations or the daily pipeline.

The [Worker preview workflow](.github/workflows/cloudflare-preview.yml) builds and smoke-tests on a GitHub-hosted Ubuntu runner without production credentials; it **does not deploy**. [PR #47](https://github.com/linyuan701/daily-paper/pull/47) proposes GitHub-operated production release/rollback, and [PR #45](https://github.com/linyuan701/daily-paper/pull/45) proposes a Site frontend; both are unmerged as of 2026-09-20. This architecture freeze does not deploy or integrate either implementation. The [Worker runbook](docs/cloud-mode-a-workers.md) records deployment requirements and this gap; a local Wrangler installation is not a supported operations dependency.

The [recovery runbook](docs/production-backup-recovery.md) also retains historical workstation commands. GitHub-hosted export/restore automation and private encrypted storage still need a reviewed implementation; local backup tools are not a supported recovery dependency.

## Validation and maintenance

Use GitHub CI for the supported acceptance path: tests, TypeScript checks, secret scans, dependency audit, disposable PostgreSQL migration/repository checks, and Worker build/preview checks. Existing SQLite-based fixtures remain until a reviewed code cleanup removes them; they do not make SQLite a supported production database.

## Known boundaries

- External providers can fail; source/stage failures are recorded and partial runs may finish with warnings. No local fallback is supported.
- The application is single-user; Cloudflare Access supplies the owner boundary rather than application tenancy.
- Integrated recall is lexical/token overlap and reranking is explainable linear/semi-linear. BM25, dense embeddings, and hybrid retrieval are not integrated.
- Local-mode defaults, schemas, scripts, and tests still exist in source. This support decision does not claim they have been deleted or change production by itself. User data and applied migration history remain protected.
- Current production health and unverified deployments are recorded only in [project state](docs/PROJECT_STATE.md).

## Directory highlights

- `src/app`: dashboard and thin API handlers
- `src/modules`: profile, ingestion, ranking, feedback, and daily orchestration
- `src/db`: repositories and cloud database clients
- `src/lib`: configuration, logging, errors, and shared types
- `prisma/postgresql`: supported PostgreSQL schema and migration history
- `.github/workflows`: background operations and CI
- `prisma/schema.prisma`, `prisma/migrations`, local-only scripts: retained legacy code; see the [retirement inventory](docs/ARCHITECTURE.md#retired-local-components)
