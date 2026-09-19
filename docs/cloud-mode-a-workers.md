# Cloud Mode A: Cloudflare Workers deployment

> **Classification: deployment/operational reference.** Code presence and this runbook do not prove current deployment. See `docs/PROJECT_STATE.md` for production status and evidence gaps.

Cloud Mode A deploys the Next.js dashboard and short interactive APIs to Cloudflare Workers through OpenNext. GitHub Actions remains the only cloud daily-job runner and connects directly to Neon. The Worker never runs migrations or the seven-stage daily pipeline. Its independent Cron handler only dispatches the existing GitHub workflow; see `docs/scheduler-reliability.md`.

## Runtime topology

```text
GitHub Actions daily CLI ----write----> Neon PostgreSQL
                                          ^
                                          |
Owner browser -> Cloudflare Access -> OpenNext Worker
                                          |
                                  read + interactive writes
```

The Worker uses `@prisma/adapter-neon` with the generated client's explicit `@prisma/client/wasm.js` entrypoint from `prisma/postgresql/schema.prisma`. The artifact contract rejects native query engines and filesystem-backed compiler references in the Worker bundle. The Node PostgreSQL client and migration history used by Actions remain separate from the Worker entrypoint. SQLite code is retained legacy material; Local Mode support is retired under DPO-011.

## Build and preview on GitHub

Use **Cloudflare Worker preview contract** (`.github/workflows/cloudflare-preview.yml`), which runs for pull requests and supports manual dispatch. It uses GitHub-hosted Ubuntu and Node 22, installs the lockfile, builds OpenNext, checks the generated/final bundle, scans for secrets, and runs workerd HTTP smoke tests without production credentials.

The runner's temporary workerd process and loopback HTTP address are CI fixtures, not a server on the user's computer. Windows setup, native workerd troubleshooting, local `.dev.vars`, and a local Wrangler installation are not supported operations prerequisites.

### Release automation gap

The integrated preview workflow **does not deploy or roll back a production Worker**. A GitHub-operated release/rollback workflow remains planned in `ROADMAP.md`. Configuration and acceptance requirements below describe that deployment boundary; they are not evidence that a production release workflow or a credentialed acceptance run exists.

Database-backed acceptance must use a disposable PostgreSQL database in an explicitly configured cloud test environment. Verify recommendations, feedback persistence, liveness, readiness success/failure, and sequential requests there. Never replace the absent release workflow with a dependency on the user's local machine.

### Historical acceptance evidence

GitHub Actions run `30249599589` built OpenNext on `ubuntu-latest`, started workerd, rendered the dashboard, returned liveness 200, failed readiness safely without a database binding, and checked capability and mutation guards. Historical Windows preview failures are no longer a supported-runtime acceptance gap.

That checkpoint did not verify a remote deployment, Access policy, database-backed readiness, or persisted feedback. Current deployment evidence is maintained in `PROJECT_STATE.md`; successful preview CI alone cannot supply it.

## Cloudflare configuration

1. Create a Worker deployment using this repository and `wrangler.jsonc`.
2. Configure the pooled Neon runtime URL as the Worker secret `DATABASE_URL` in the cloud service. Keep release credentials in the reviewed GitHub/Cloudflare secret stores, not a local file.
3. Deploy the Worker named `daily-paper`. With `workers_dev=true`, its first-release URL is `https://daily-paper.<account-subdomain>.workers.dev`. `preview_urls=false` remains explicit so no per-version preview hostname becomes a bypass.
4. In Workers & Pages, select `daily-paper`, open **Settings > Domains & Routes**, and click **Enable Cloudflare Access** for the production `workers.dev` route.
5. In the generated Access policy, allow only the intended owner email. Configure the actual address in Cloudflare, never in source. Do not add `Everyone`, arbitrary valid email, or a public-domain allow rule to the protected application.
6. Copy the Access application audience tag and configure Worker variables `POLICY_AUD`, `TEAM_DOMAIN` (`https://<team-name>.cloudflareaccess.com`), and `ACCESS_ALLOWED_EMAIL`. The address is deployment data and must not be committed.
7. Keep the dashboard, APIs, and `/api/health/ready` protected. Configure a separate exact public destination/exception only for `/api/health/live` when public liveness is required.
8. Once the GitHub release workflow is implemented and authorized, build/deploy there using the repository's `cf:deploy` command, then verify the outer Access policy and the Worker's application-level JWT validation. This step is currently a workflow gap, not an instruction to deploy from a user PC.

Cloudflare's one-click Workers Access feature is supported directly on production `workers.dev` routes. The application does not rely on that outer route alone: middleware validates `Cf-Access-Jwt-Assertion` against the account JWKS, expected issuer, application audience, and configured owner email. Missing Access variables, a missing/invalid token, or an unexpected email fails closed with a sanitized 403.

Worker Static Assets use `run_worker_first=true`, so prerendered dashboard HTML and other static application assets cannot bypass the Next middleware. The middleware source lives at `src/middleware.ts`, matching this repository's `src/app` layout.

The daily workflow does not call the Worker, so PR 4 adds no Cloudflare service token. A later headless client or monitor must use a dedicated Access service token rather than a browser cookie.

## API capability matrix

| Surface | Cloud Mode A policy |
|---|---|
| `/`, `/collections`, `/journals` | Worker-compatible; Access-protected. Local Obsidian and live feed-health controls are hidden. |
| `GET /api/recommendations/daily`, `GET /api/feedback/logs` | Worker-compatible authenticated reads. |
| `GET /api/candidates/content`, `PUT /api/candidates/content` | Worker-compatible; PUT requires same-origin JSON and strict summary/label input. |
| `POST /api/feedback/actions` | Worker-compatible; same-origin JSON, bounded metadata, and candidate/run association. |
| `GET/POST/PUT /api/journals/pool` | Worker-compatible; guarded writes. Cloud URLs require HTTPS and reject literal local/private targets. Live probing is disabled. |
| `GET/PUT /api/zotero/collections/priorities` | Worker-compatible; guarded and validated PUT. |
| `GET /api/profile/refresh`, `GET /api/profile/snapshot` | Worker-compatible persisted status reads. |
| `GET /api/ranking/recall`, `GET /api/ranking/rerank`, `GET /api/ingestion/runs`, `GET /api/ingestion/dedup` | Worker-compatible persisted-result reads. |
| `GET /api/zotero/sync`, `GET /api/zotero/tags/parse` | Worker-compatible status reads without Zotero credentials in the Worker. |
| `GET /api/health/live` | Public only under an exact Access bypass; constant liveness only. |
| `GET /api/health/ready` and legacy `GET /api/health` | Database readiness; protected and sanitized. |
| daily/MVP/monthly job endpoints | Cloud-disabled; use GitHub Actions. |
| ingestion, enrichment, normalization, recall, rerank, summary generation, profile build, Zotero sync/tag mutation methods | Cloud-disabled Node job responsibilities. |
| Obsidian export, journal bootstrap/health probing, profile reminder mutation | Cloud-disabled. Historical local endpoints are not supported fallback operations. |

No route emits permissive CORS headers. Cloud writes require JSON, a matching `Origin`, same-origin Fetch Metadata when present, bounded bodies, and route validation. Server errors do not return stack traces, connection URLs, provider bodies, or secrets.

## Secrets, acceptance, and rollback

The Worker requires the `DATABASE_URL` secret plus non-secret Access values `POLICY_AUD` and `TEAM_DOMAIN`; `ACCESS_ALLOWED_EMAIL` should be treated as private deployment configuration. It does not receive Zotero, LLM, SMTP, WeCom, Obsidian, Windows, or daily-job secrets.

Before deployment, the GitHub release path must pass repository CI and Worker build/preview checks. A preview with a disposable PostgreSQL database must exercise recommendations, feedback persistence, liveness, readiness success/failure, and sequential requests. Without the workflow or credentials, record these as not executed rather than passed.

Rollback the Worker to the last verified Cloudflare version or disable its production `workers.dev` route while retaining Access deny rules. Worker rollback does not reverse PostgreSQL migrations.

## Later custom-domain migration

A custom domain is optional for the first personal instance. To add one later, configure a Worker Custom Domain, place the same Access owner-only policy in front of it, update `NOTIFICATION_DASHBOARD_URL`, and retest Origin/JWT boundaries. The Worker code, Neon schema, daily workflow, recommendations, and feedback data do not change. Keep the `workers.dev` route Access-protected during transition, then set `workers_dev=false` only after the custom hostname is verified so it cannot remain as a bypass.
