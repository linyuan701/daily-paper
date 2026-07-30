# Daily Paper

Daily literature triage MVP centered on Zotero, with two coupled pipelines:
- profile pipeline (low-frequency): Zotero sync, collection priorities, profile snapshot refresh
- daily pipeline (high-frequency): ingestion, enrichment, dedup, summary/labels, recall + rerank

## Stack
- Next.js + TypeScript
- Prisma
- SQLite by default for local MVP (`DATABASE_URL` can point to PostgreSQL)

## Local Setup
1. Install dependencies:
   - `npm install`
2. Create `.env` from `.env.example`:
   - required: `DATABASE_URL`, `ZOTERO_KEY`, `ZOTERO_ID`
   - optional: source scopes, LLM/journal integration keys, scheduler settings
   - `PUBMED_QUERY_SCOPE` defaults to a focused genomics/omics/regulatory-genomics query; generic AI terms are only included when paired with those domains, so override it only if you intentionally want broader PubMed intake
3. Run schema and generate client:
   - `npm run prisma:migrate`
   - `npm run prisma:generate`
4. Validate environment:
   - `npm run check:env`
5. Start app:
   - `npm run dev`
6. Health check:
   - `GET http://localhost:3000/api/health`

## End-to-End MVP Runbook

### Preferred single-trigger path
Use the integrated route:
- `POST /api/jobs/mvp-flow`
- optional body:
  - `syncMode`: `"full"` or `"incremental"` (default `"incremental"`)
  - `runDate`: `YYYY-MM-DD` (UTC day for ingestion)
  - `sources`: subset of `["biorxiv","arxiv","pubmed","journal"]`

This orchestrates:
1. Zotero sync
2. collection priority read/effective summary
3. manual profile refresh (new active snapshot)
4. daily pipeline (ingest -> enrich -> dedup -> summary/labels -> recall -> rerank)
5. dashboard feed snapshot readback

### Manual route-by-route path
1. Sync Zotero:
   - `POST /api/zotero/sync` with `{ "mode": "incremental" }`
2. Review/update collection priorities:
   - `GET /api/zotero/collections/priorities`
   - `PUT /api/zotero/collections/priorities`
3. Refresh profile:
   - `POST /api/profile/refresh`
4. Ingest daily candidates (per source):
   - `POST /api/ingestion/runs`
5. Run ranking:
   - `POST /api/ranking/recall`
   - `POST /api/ranking/rerank`
6. Open dashboard:
   - `/`
   - data API: `GET /api/recommendations/daily`
7. Store user feedback and label edits:
   - `POST /api/feedback/actions`
   - `PUT /api/candidates/content`

Dashboard triage replays the append-only feedback log into three independent Web projections:
`saved`, `promoted`, and `dismissed`. A paper can therefore be both saved and promoted; dismissing it
clears both positive projections until a later Save or Promote action. The existing Obsidian note
format still has one scalar `status`, so it cannot fully represent `saved + promoted`. Obsidian
bidirectional feedback sync is not implemented and is not implied by the Web projection.

## Scheduler Jobs
- `POST /api/jobs/daily`: run daily recommendation pipeline
- `POST /api/jobs/monthly-reminder`: profile-refresh reminder check
- `POST /api/jobs/mvp-flow`: full local MVP orchestration

CLI wrappers:
- `npm run job:daily`
- `npm run job:daily:cloud` (Cloud Mode direct Node job)
- `npm run job:monthly-reminder`
- `npm run job:scheduler-loop`

Scheduler env knobs:
- `DAILY_RECOMMENDATION_LIMIT` — strict integer `1`–`30`, default `20`; controls final rerank selection and summary/persisted feed/notification cardinality without shrinking the Recall Top 100 or rerank candidate pool
- `APP_BASE_URL`
- `SCHEDULER_DAILY_UTC_HOUR`
- `SCHEDULER_MONTHLY_UTC_DAY`
- `SCHEDULER_MONTHLY_UTC_HOUR`
- `SCHEDULER_POLL_MS`

## Cloud Mode daily execution

Cloud Mode keeps the Windows/SQLite path intact and runs the persisted daily pipeline directly in GitHub Actions against an empty managed PostgreSQL database. The committed workflow is `.github/workflows/daily.yml`; it does not call the Next.js or Cloudflare daily API.

The Cloud CLI accepts `DAILY_RECOMMENDATION_LIMIT` through its process environment with the same strict validation as Local Mode. The production workflow mapping remains intentionally unchanged while the v0.2 scheduled-notification acceptance gate is open, so its effective value stays at the default `20` until that separate deployment setting is approved.

`DAILY_RECOMMENDATION_LIMIT` is the pipeline generation limit. The Dashboard `limit=1..30` URL parameter is only a visible-item limit for recommendations already present in the selected feed: **显示数量不会改变每日生成数量**. A Dashboard URL can neither change the scheduler environment nor generate missing recommendations for a historical run.

Setup summary:

1. Create a Neon database in a region near the instance owner. The first personal instance uses AWS Frankfurt (`eu-central-1`), but no provider region is hardcoded.
2. Create a GitHub Actions environment named `production`.
3. Add required secrets: `DATABASE_URL`, `ZOTERO_ID`, `ZOTERO_KEY`, and `LLM_API_KEY`.
4. Optionally add `LLM_MODEL`, `LLM_API_BASE_URL`, `NOTIFICATION_DASHBOARD_URL`, WeCom, and SMTP settings.
5. Run **Cloud daily recommendations** manually once, optionally with a strict `runDate` (`YYYY-MM-DD`).
6. Keep or edit the template schedule, which defaults to 08:15 `Asia/Shanghai` (UTC 00:15).

The workflow validates/generates the PostgreSQL client, applies the independent cloud migration history, and then invokes the existing `job:daily:cloud` CLI. Notification settings are optional; failures do not roll back persisted results. See [Cloud Mode A GitHub Actions runbook](docs/cloud-mode-a-github-actions.md) for the full Secrets/Variables, schedule, retry, and exit-code contract.

An empty Cloud Mode database must build its low-frequency profile before recall can succeed. Run the separate **Cloud profile maintenance** workflow with `operation=sync`, use the Access-protected `/collections` page to select at least one primary or secondary collection, and then run the workflow again with `operation=refresh`. This workflow is manual-only and does not run the daily pipeline.

## Cloud Mode dashboard on Cloudflare Workers

OpenNext can deploy the dashboard and short interactive APIs to Cloudflare Workers. The Worker reads the same Neon database but never runs migrations or the daily pipeline.

```text
npm run cf:typegen
npm run cf:build
npm run test:cloudflare
npm run cf:preview
npm run cf:deploy
```

Before deployment, add `DATABASE_URL` as a Worker secret and enable Cloudflare Access on the production `daily-paper.<account-subdomain>.workers.dev` route. The committed Wrangler config enables only the production `workers.dev` URL; preview URLs remain disabled. The Worker also validates the Access JWT issuer, audience, signature, and configured owner email. Only `/api/health/live` may receive an exact public Access exception; readiness and every dashboard/API route remain protected. A later custom domain changes routing and Access configuration, not application or database code. See [Workers deployment](docs/cloud-mode-a-workers.md), the [original dependency audit](docs/cloud-mode-a-dependency-audit.md), and the [v0.2 dependency risk register](docs/production-dependency-risk.md).

The Access-protected `/operations` page and `/api/operations/runs` show recent persisted daily runs, stage outcomes, source degradation, timestamps, sanitized errors, and retry eligibility. Optional retry/resume dispatch requires `OPERATIONS_GITHUB_OWNER`, `OPERATIONS_GITHUB_REPO`, `OPERATIONS_GITHUB_REF`, and the Worker secret `OPERATIONS_GITHUB_TOKEN`. Use a fine-grained token restricted to this repository with Actions write permission. The API accepts only a stored retryable `runId`, checks its fixed daily request key, and dispatches the fixed `daily.yml` with the stored `runDate`; it cannot execute shell commands, delete history, or create a different idempotency key.

## Validation Commands
- tests: `npm run test`
- typecheck: `npm run typecheck`
- production build: `npm run build`
- OpenNext Worker build: `npm run cf:build`
- Cloudflare generated-artifact contract: `npm run test:cloudflare` (run after `cf:build`)

If `next build` fails in Windows sandboxed environments with `EPERM ... Application Data`, run build with an isolated home/profile:

```powershell
$root=(Resolve-Path .).Path
$fakeHome=Join-Path $root '.codex-home'
$fakeAppData=Join-Path $fakeHome 'AppData\Roaming'
$fakeLocal=Join-Path $fakeHome 'AppData\Local'
New-Item -ItemType Directory -Force -Path $fakeAppData,$fakeLocal | Out-Null
$env:HOME=$fakeHome
$env:USERPROFILE=$fakeHome
$env:HOMEDRIVE=$fakeHome.Substring(0,2)
$env:HOMEPATH=$fakeHome.Substring(2)
$env:APPDATA=$fakeAppData
$env:LOCALAPPDATA=$fakeLocal
npm run build
```

## Known Limitations
- External integrations depend on real credentials/network (`ZOTERO_KEY`, source APIs, optional LLM/enrichment APIs).
- Providers are honest about unavailability; they degrade gracefully and record failure metadata.
- Daily ingestion is currently source-triggered; orchestration runs configured sources sequentially and aggregates outcomes.
- Single-user MVP data model and UI; no auth/tenant partitioning yet.
- Ranking remains explainable linear/semi-linear by design; no opaque model training in MVP.

## Extension Points
- Swap SQLite for PostgreSQL via `DATABASE_URL`.
- Replace unavailable provider adapters with real production integrations.
- Add richer source scopes and additional ingestion adapters.
- Introduce stronger multi-source joint-run orchestration if needed.
- Extend feedback consumption logic during profile refresh with stricter controls or weighting.

## Directory Highlights
- `src/app`: pages and thin API handlers
- `src/modules`: business modules (`zotero-sync`, `collections`, `profile-build`, `ingestion`, `ranking`, `feedback`, `scheduler`)
- `src/db/repositories`: Prisma-backed repository layer
- `src/lib`: config, logging, errors, shared utilities/types
- `prisma/schema.prisma`: current schema and relations
