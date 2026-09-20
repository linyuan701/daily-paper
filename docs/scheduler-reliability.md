# Scheduler reliability

> **Classification: operational design/runbook reference.** It describes intended scheduler mechanics. Deployment and current runtime health are tracked separately in `docs/PROJECT_STATE.md`.

> **Cloud-only execution (DPO-011):** The supported clocks dispatch GitHub-hosted jobs. Validation commands below describe runner steps, not a local installation requirement. Windows scheduling and local fallback are retired; GitHub CI provides build/preview validation. The Worker production release workflow remains a tracked gap.

The production daily trigger has two independent clocks but one existing GitHub Actions execution path:

```text
Cloudflare Cron (primary, 15 0 * * * UTC)
  -> Worker scheduled() handler
  -> POST GitHub workflow_dispatch for daily.yml on master
  -> required runDate input
  -> PR #29 concurrency and persisted idempotency

GitHub native schedule (backup, retained in daily.yml)
  -> the same business-date concurrency and persisted idempotency
```

The Worker never imports or runs the daily pipeline, database migrations, ranking, recommendation, or notification providers. It makes one bounded GitHub API request and calls `controller.noRetry()` so a failed Cron event is not retried by the handler. A failure never falls back to running the pipeline in Cloudflare.

## Business date contract

The Worker uses `controller.scheduledTime`, not the time at which a delayed Worker invocation actually starts. The shared rule from PR #29 resolves the previous UTC calendar day. For example, the Cron occurrence at `2026-07-31T00:15:00Z` dispatches `runDate=2026-07-30`.

The dispatch request is fixed to:

- repository: `linyuan701/daily-paper`;
- workflow: `daily.yml`;
- ref: `master`;
- input: a required, validated `runDate` in `YYYY-MM-DD` format.

There is no missing-date or implicit-today fallback.

## Authentication and manual Cloudflare setup

Do not send the token to Codex and do not save it in a repository file, GitHub Actions Variable, GitHub artifact, or Wrangler `vars`.

1. In GitHub, create a fine-grained personal access token for resource owner `linyuan701`.
2. Select only the `daily-paper` repository.
3. Grant the minimum repository permission **Actions: Read and write**. GitHub may add read-only Metadata automatically.
4. Set an expiry and record a private rotation reminder outside this repository.
5. In Cloudflare Dashboard, open **Workers & Pages -> daily-paper -> Settings -> Variables and Secrets**.
6. Add an encrypted secret named `DAILY_SCHEDULER_GITHUB_TOKEN`. Paste the token there once and do not expose it in logs or build configuration.
7. Only after this PR is merged and the Worker is deliberately deployed, verify **Settings -> Triggers -> Cron Triggers** shows `15 0 * * *` (UTC). The committed `wrangler.jsonc` is the source of truth; do not create a second Dashboard-only Cron.
8. Verify Workers Logs are enabled. The committed configuration enables observability, and the scheduled handler emits one sanitized JSON record per occurrence.

This PR does not perform steps 5-8, deploy the Worker, or install the Cron Trigger.

## Failure and observability contract

The only log fields are `scheduledTime`, `targetBusinessDate`, `dispatchStatus`, `httpStatusCategory`, and `duration` (milliseconds). The Worker never logs the token, authorization header, request body, response body, URL, or upstream error message.

| Result | `dispatchStatus` | HTTP category |
| --- | --- | --- |
| Any 2xx | `success` | `2xx` |
| 401 or 403 | `auth_error` | `4xx` |
| 404 | `workflow_not_found` | `4xx` |
| 429 | `rate_limited` | `4xx` |
| Other response, including 5xx | `dispatch_failed` | matching category |
| Network/timeout | `dispatch_failed` | `network` |
| Missing Worker secret | `dispatch_failed` | `not_attempted` |

## Native schedule backup and PR relationships

The GitHub native schedule remains in `.github/workflows/daily.yml`; this PR does not edit or remove it. It can create a late backup run. When Cloudflare dispatch wins first, PR #29 gives both runs the same `businessDate` concurrency group. The late native run queues as a follower, then the persisted guard sees the existing terminal notification state and safely skips migration and daily execution. If the native schedule is already active when dispatch arrives, PR #29's preflight rejects the duplicate dispatch as a safe no-op.

PR #29 is therefore a hard prerequisite and is the owner of concurrency, business-run idempotency, and notification deduplication. This scheduler PR owns only the independent trigger. PR #28 is the monitoring/observability follow-up for the existing daily workflow; it does not replace either trigger or the PR #29 safety gate. If PR #28 changes shared workflow tests before this PR merges, rebase and rerun the combined follower coverage.

## Safe validation

These commands do not deploy or dispatch production work:

```powershell
npm run cf:typegen
npm run typecheck
npm run typecheck:worker
npm test
npm run build
npm run cf:build
npm run cf:dry-run
npm run cf:secret-scan
npm run test:cloudflare
```

Do not run `npm run cf:deploy`, do not invoke the local scheduled endpoint with a real token, and do not manually run `daily.yml` as part of this PR.
