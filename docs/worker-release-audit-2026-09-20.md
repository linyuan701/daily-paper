# Worker release infrastructure audit — 2026-09-20

Status: **IN DEVELOPMENT / NOT DEPLOYED**. This task implements GitHub-controlled
Worker release/rollback; #45 application acceptance is a later task. After the
credential inventory, the user explicitly chose code, CI and read-only audit
only, with credentials configured later. No version creation, production deploy,
rollback, Access/secret/Cron modification, daily dispatch or PostgreSQL write is
authorized for this phase.

## Baselines

- Freshly fetched master: `d8552a0468a5970ee530195726f6c96e04b286b3`.
- #44 cloud-only support: OPEN/unmerged, head
  `98d516d8d67d80c714ffe30a226b4b9b1392289d`.
- #45 Site integration: OPEN/Draft/unmerged, head
  `b99443ab9dfabbe08f75c7d435332c3f429d8616`.
- #46 dependency security repair: OPEN/Draft/unmerged, head
  `adadd0765fab470fa211d6bd37262d2a11706049`.
- Original dirty `codex/cloud-mode-a` workspace remains untouched. Implementation
  uses a separate clean worktree/branch from the fetched master.

The existing `cloudflare-preview.yml` built/scanned/smoke-tested OpenNext/workerd;
it contained no production deploy. No parallel deployment workflow was found.
Wrangler is lockfile-pinned at 4.114.0; OpenNext at 1.20.2. The implementation keeps
these dependencies, the Worker entrypoint and `wrangler.jsonc` unchanged.

## Actual Cloudflare state (read-only API)

| Field | Observed value |
|---|---|
| Worker | `daily-paper` |
| Active version | `a36410a9-ed06-461c-a882-e31c4cf9121b` |
| Active deployment | `435c8f11-f0ca-4719-8fdb-79137d3f2c22` |
| Production traffic | 100% to that one version |
| Deployment time | `2026-09-13T12:23:20.027398Z` |
| Version creation time | `2026-09-13T12:22:13.081024Z` |
| Version annotation tag | `9f660d2` |
| Version annotation message | `9f660d2 Site read-only dashboard; isolated dependencies; verified NextServer patch` |
| Deployment annotation message | `Activate 9f660d2 Site read-only dashboard with isolated, patch-verified build` |
| Compatibility | `2026-07-27`, `nodejs_compat` |
| Cron | `15 0 * * *`; unchanged since `2026-08-04T14:42:02.738603Z` |
| Subdomain | enabled; preview URLs disabled |

Remote branch `codex/site-read-worker-release` resolves the claimed source prefix to
`9f660d264d845d831993c4738c42ce6ff3f4928b`. It is an older production baseline
plus the read-only Site adapter. This is **annotation plus repository evidence**,
not a GitHub release run or Cloudflare source attestation. Exact old deployed build
provenance is not upgraded by this PR. In particular, full current master must
not replace it merely to validate this infrastructure.

The preceding recovery deployment `7ae1ce3a-eb64-4eaf-8ade-415fb769bbcb` served
`5f6d12f9-7296-4c14-a60d-15417534654b` at 100% on
`2026-09-13T11:58:40.837361Z`. This historical record is not a claim that the older
version is presently a safe rollback target. A later first release should save
the currently healthy `a36410a9…` version/deployment as its rollback anchor.

Observed binding names/types (no values were printed or committed):

- assets: `ASSETS`
- plain_text: `DAILY_PAPER_RUNTIME_TARGET`, `DEPLOYMENT_MODE`,
  `NEXT_PUBLIC_DEPLOYMENT_MODE`
- secret_text: `ACCESS_ALLOWED_EMAIL`, `DAILY_SCHEDULER_GITHUB_TOKEN`,
  `DATABASE_URL`, `POLICY_AUD`, `SITE_READ_ACCESS_CLIENT_ID`,
  `SITE_READ_POLICY_AUD`, `TEAM_DOMAIN`

Authenticated local Wrangler OAuth succeeded for **read-only inspection**; this
does not establish GitHub authentication. The production GitHub environment only
allowed master and contained the existing data/provider/notification secrets.
It had no Cloudflare deployment token/account or release-probe credentials.
No local OAuth token was copied to GitHub and no secret was created/changed.

## Acceptance evidence and limits

- Real public `GET /api/health/live`: HTTP 200, JSON `{"status":"ok"}`.
- Anonymous critical reads `/api/recommendations/daily` and
  `/api/site/dashboard`: HTTP 302 to Access, as expected for protected routes.
  These are boundary observations, **not authenticated critical-API passes**.
- New orchestration tests cover upload-only, controlled deploy, known-version
  rollback, dry-run, stale/split state, binding drift, failure recovery and
  concurrent deployment safety using disposable in-memory providers.
- GitHub build/typecheck/smoke, source secret scan and CI results are recorded
  in this task's pull request after execution. Pre-existing dependency audit
  failures belong to #46; no allowances or lockfile changes are made here.
- Real Cloudflare version creation, controlled deployment, authenticated critical
  reads and actual rollback: **not executed**, per the user's narrowed scope.

Remaining production gates: review/merge this infrastructure, configure the
GitHub environment credentials/variables described in
[the runbook](worker-release.md), resolve the #46 release security gate, and review
the old-Worker versus selected-source difference. Then run GitHub dry-run and
rollback dry-run before an explicitly controlled release/recovery exercise.
Deploying/accepting #45, widening its Access scope and doing its one feedback write
remain outside this task.
