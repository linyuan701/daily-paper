# Cloud Mode A: GitHub Actions daily job

## Real acceptance status

This checkout has no configured Git remote and no GitHub or Neon credentials. The workflow has therefore not been manually dispatched against Neon. Real ingestion, persisted stages/recommendations/summaries, same-date `already_succeeded`, database uniqueness, and remote log redaction are not claimed as accepted.

When credentials are available, dispatch the workflow twice with the same explicit `runDate`. Verify migrations and the first pipeline result, inspect non-secret database counts, verify the second result is `already_succeeded` with no duplicate run/recommendations, confirm unset notifications are skipped, and inspect logs for all secret values. Record only date, run ID, statuses, and counts here.

Cloud Mode runs the existing persisted daily CLI on a standard GitHub-hosted Node runner. It connects directly to the user's Neon PostgreSQL database; it does not call a Cloudflare or Next.js daily API.

## Empty-database profile bootstrap

The daily pipeline intentionally does not rebuild the low-frequency interest profile. For a new empty Neon database:

1. Run **Cloud profile maintenance** with `operation=sync`. The first incremental request automatically performs the existing full Zotero sync because no successful library version exists.
2. Deploy and sign in to the Access-protected Dashboard, open `/collections`, and mark at least one collection as `primary` or `secondary`. The root default remains `excluded`.
3. Run **Cloud profile maintenance** again with `operation=refresh`.
4. Run or rerun **Cloud daily recommendations**. A prior partial run resumes from its first incomplete stage under the same persisted `runId`.

The profile workflow has no schedule and never calls the daily pipeline. Its logs contain only IDs and aggregate counts, not collection names, Zotero keys, credentials, or database URLs.

## 1. Create the PostgreSQL database

Create an empty Neon PostgreSQL database. The first personal instance uses AWS Frankfurt (`eu-central-1`) because its primary use is in Europe. This region is not an application default: choose a Neon region near the instance owner (for example, Frankfurt for Europe or Singapore for East Asia).

Keep the complete TLS-enabled connection string private. The workflow runs `prisma:cloud:migrate:deploy` before the daily CLI, so the first run creates the schema from `prisma/postgresql/migrations/**`. It never reads, changes, or imports the Local Mode SQLite database.

## 2. Configure the GitHub production environment

In the repository, create an Actions environment named `production`. Add these required environment secrets:

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `ZOTERO_ID` | Zotero user or group identifier |
| `ZOTERO_KEY` | Zotero Web API key |
| `DEEPSEEK_API_KEY` | DeepSeek official API key, created manually in the GitHub Environment |
| `NVIDIA_API_KEY` | NVIDIA NIM API key, created manually in the GitHub Environment |

Add these environment variables as needed:

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `deepseek`; selects the DeepSeek official credential |
| `LLM_BASE_URL` | `https://api.deepseek.com` |
| `LLM_MODEL` | `deepseek-v4-flash` |
| `NOTIFICATION_DASHBOARD_URL` | Optional dashboard URL included in notifications |

The DeepSeek key must be added manually; the repository contains no credential. The workflow maps only `DEEPSEEK_API_KEY` to the runtime `LLM_API_KEY` when `LLM_PROVIDER=deepseek`, with no cross-provider Secret fallback. `LLM_BASE_URL` takes precedence over the deprecated `LLM_API_BASE_URL` Variable, and trailing slashes are normalized. With `LLM_PROVIDER=deepseek`, omitted base/model values use the exact values above, while any different endpoint or model is rejected before provider calls.

Use [DeepSeek official generative LLM configuration](./deepseek-official-llm.md) for the exact runtime contract and the isolated manual smoke test. Base URLs must be HTTP(S) URLs without embedded credentials, query parameters, or fragments.

For a controlled rollback to NVIDIA, set `LLM_PROVIDER=nvidia`, `LLM_BASE_URL=https://integrate.api.nvidia.com/v1`, and `LLM_MODEL=deepseek-ai/deepseek-v4-flash`; the workflow then selects only `NVIDIA_API_KEY`. For a generic provider, set `LLM_PROVIDER=openai-compatible` and use the legacy `LLM_API_KEY` Secret. Prefer `LLM_BASE_URL`; an existing `LLM_API_BASE_URL` Variable remains supported only when the canonical name is unset.

## 3. Optional notifications

No notification setting is required. If all optional settings are absent, the persisted recommendation job still succeeds and notification delivery reports `skipped`.

- WeCom: `WECOM_BOT_WEBHOOK_URL`.
- SMTP: `NOTIFICATION_SMTP_HOST`, `NOTIFICATION_SMTP_PORT`, `NOTIFICATION_SMTP_SECURE`, `NOTIFICATION_SMTP_USER`, `NOTIFICATION_SMTP_PASS`, `NOTIFICATION_SMTP_FROM`, and `NOTIFICATION_SMTP_TO`.

The workflow maps `NOTIFICATION_SMTP_FROM/TO` to the application's existing `NOTIFICATION_EMAIL_FROM/TO` environment names. WeCom is attempted first; SMTP is the fallback. Delivery failure is logged without provider error bodies and does not roll back recommendations or change the persisted pipeline result.

## 4. Schedule and manual runs

`.github/workflows/daily.yml` defaults to 08:15 in `Asia/Shanghai`:

```yaml
schedule:
  - cron: "15 8 * * *"
    timezone: "Asia/Shanghai"
```

This is UTC 00:15 and deliberately avoids the top of the hour. To change it, edit both the POSIX cron and the IANA timezone in your own repository. The schedule only runs from the default branch and GitHub may delay scheduled jobs during high load.

GitHub's current schedule syntax and IANA timezone behavior are documented in [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule).

For a manual run, `runDate` is required and must be an exact, valid UTC calendar date in `YYYY-MM-DD` form. Missing or invalid input fails before source calls and never falls back to another day. Use the guarded procedure in [Production daily manual fallback](./production-daily-manual-fallback.md); production dispatch is restricted to `master`.

## 5. Execution and retry semantics

The workflow order is:

```text
checkout -> Node 22 -> npm ci -> cloud config check
-> PostgreSQL validate/generate -> migrate deploy -> job:daily:cloud
```

The CLI may also be invoked locally against an explicitly configured Cloud environment:

```text
npm run job:daily:cloud
npm run job:daily:cloud -- --run-date 2026-07-27
```

The database request key and stage rows, not Actions concurrency, provide business idempotency. A successful run is reused, an active lease is not stolen, a stale lease is reclaimed on the same `runId`, and a downstream failure resumes after successful ingestion. Retry a failed workflow with **Re-run jobs** or use `workflow_dispatch` with the same date.

## 6. Result and secret boundaries

`complete`, `already_succeeded`, `already_running`, and non-retryable `partial` return exit code 0. `already_running` is a safe no-op for competing production workflows. Retryable `partial`, `failed`, invalid arguments, and configuration/factory failures return exit code 1. The CLI prints only bounded business and notification status fields.

Do not add pull-request triggers to the production workflow. Do not echo environment objects, database URLs, provider responses, webhook URLs, or SMTP errors. The workflow grants `contents: read`; only the secret-free preflight job additionally gets `actions: read` to detect same-date active runs. The production job uses a non-cancelling, business-date concurrency group with `queue: max` (up to 100 pending runs). That job-level gate applies before every production step. Once a queued follower acquires it, a persisted business-run check occurs before migration and skips both `prisma migrate deploy` and the daily job when the same run is already `SENT`, `SENDING`, or legacy-suppressed.
