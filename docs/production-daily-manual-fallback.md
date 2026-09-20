# Production daily manual fallback

> Acceptance closure: UTC business date `2026-07-30` completed successfully. Do not dispatch or restore that date again. The commands below are retained as the audited acceptance record and must be updated to a new approved business date before any future use.

> **Cloud-only operation (DPO-011):** Use the GitHub Actions web interface for manual dispatch and log inspection. The dated PowerShell/`gh` transcript below is historical evidence, not a requirement to install a local CLI or run a local scheduler. Apply the same active-run checks, approved UTC date, and persisted idempotency rules through GitHub.

This runbook is for a delayed GitHub scheduled run only. It never accepts a caller-supplied `runId`; the persisted daily pipeline derives and reuses the business run from the UTC business date and the fixed production source set.

## One-time protection before acceptance

In **Settings → Environments → production → Deployment branches and tags**, restrict deployments to the selected branch `master`. This Environment rule is the authoritative protection against an older workflow file being run from `codex/v0.3-*` or another branch. The current workflow also rejects any ref other than `refs/heads/master`, but that code cannot protect an older branch that does not contain the guard yet.

Do not add a `runId` input. Do not run the production daily workflow from a v0.3 branch.

## 2026-07-31 morning acceptance (Beijing time)

The intended UTC business date is **2026-07-30**.

1. At **08:15 CST (Asia/Shanghai)**, open the repository's **Actions** tab, select **Cloud daily recommendations**, and inspect the run list. Do not manually dispatch yet. From an authenticated terminal, `gh workflow view daily.yml --web` opens the same page without a hard-coded account name.
2. Between **08:30 and 08:45 CST**, refresh the page. A scheduled run with status `queued` or `in_progress` means: wait; manual fallback is forbidden. If a same-date manual run is already active, stop as well—never create a second manual run.
3. Only if there is still no `queued` or `in_progress` scheduled run, click **Run workflow** once.
4. In **Use workflow from**, select **Branch: master**. Never select a `codex/v0.3-*` branch.
5. Enter `2026-07-30` in **UTC business date YYYY-MM-DD**. Check every digit; an empty, malformed, or impossible date is rejected and never falls back to another date.
6. Click the green **Run workflow** button once. Do not double-click, open a second tab, or start another CLI dispatch.
7. Open the new run. The preflight must show `accepted` before the production job starts. If it reports `already_running`, the workflow exits successfully without entering the production Environment; do not trigger again.
8. In the production job, record only `businessDate`, `runId`, business status/disposition, recommendation count, and notification `deliveryStatus`. Do not copy secrets or provider error details.

Expected idempotent outcomes:

- A live same-date run causes the manual preflight or business lease to exit safely without running a second pipeline.
- A persisted `complete` or `complete_with_warnings` run returns `already_succeeded` and reuses its `runId`.
- A recoverable failed, partial, or stale run resumes with its original `runId` and the first incomplete stage.
- The rerank stage upserts one stable rerank run per business `runId`, replacing that run's result rows rather than creating another recommendation set.
- A persisted notification state of `SENT` causes later execution of the same `runId` to report `deliveryStatus=skipped`, `reason=already_sent`, and `deduplicated=true` without calling WeCom or SMTP again.
- The production job's business-date concurrency gate is acquired before any step, including migration. After a queued same-date follower acquires the gate, a persisted-run check runs before `prisma migrate deploy`; terminal `SENT`, `SENDING`, or legacy-suppressed runs emit a bounded `daily_notification` no-op and skip both migration and the daily job.
- Feed and message preparation completes before notification delivery acquires a persisted `SENDING` claim. If execution then stops after the provider may have accepted the message but before `SENT` is stored, later retries conservatively skip with `reason=delivery_outcome_unknown`; an operator must reconcile that run rather than retry blindly.
- A provider failure also retains `SENDING`, because acceptance can be ambiguous. Only a configuration-based skip made before any provider attempt releases the claim for a later retry.
- Terminal runs created before notification state existed are migrated to `LEGACY_SUPPRESSED`; their delivery history is unknowable, so retries conservatively skip notification with `reason=legacy_suppressed` instead of risking a duplicate.

The formal daily job uses the `production` Environment and its real notification settings. WeCom is attempted first; SMTP is the fallback when WeCom is absent or fails. Therefore the code path is production SMTP-capable, but an SMTP email is not guaranteed if WeCom succeeds or the SMTP secret set is incomplete. The repository cannot inspect Environment secret values.

## PowerShell / gh CLI procedure

Authenticate and inspect active scheduled and manual runs; these commands are read-only:

```powershell
$AcceptanceRepo = gh repo view --json nameWithOwner --jq '.nameWithOwner'
$BusinessDate = "2026-07-30"
$UtcScheduleDayStart = [DateTimeOffset]::Parse("2026-07-31T00:00:00Z")
$UtcScheduleDayEnd = $UtcScheduleDayStart.AddDays(1)
$ManualWindowStart = [DateTimeOffset]::Parse("2026-07-31T00:30:00Z")
$ManualWindowEnd = [DateTimeOffset]::Parse("2026-07-31T00:45:00Z")
$ActiveStatuses = @("queued", "in_progress", "requested", "waiting", "pending")

gh auth status
$ScheduledRuns = gh run list `
  --repo $AcceptanceRepo `
  --workflow daily.yml `
  --branch master `
  --event schedule `
  --limit 20 `
  --json databaseId,status,conclusion,createdAt,displayTitle,url | ConvertFrom-Json

$ManualRuns = gh run list `
  --repo $AcceptanceRepo `
  --workflow daily.yml `
  --branch master `
  --event workflow_dispatch `
  --limit 20 `
  --json databaseId,status,conclusion,createdAt,displayTitle,url | ConvertFrom-Json

$ActiveScheduledRuns = @($ScheduledRuns | Where-Object {
  $CreatedAt = [DateTimeOffset]::Parse($_.createdAt)
  $_.status -in $ActiveStatuses -and
  $CreatedAt -ge $UtcScheduleDayStart -and
  $CreatedAt -lt $UtcScheduleDayEnd
})
$ActiveManualRuns = @($ManualRuns | Where-Object {
  $_.status -in $ActiveStatuses -and
  $_.displayTitle -eq "Daily manual $BusinessDate"
})
$ActiveForBusinessDate = @($ActiveScheduledRuns) + @($ActiveManualRuns)
$ActiveForBusinessDate | Format-Table databaseId,status,createdAt,displayTitle,url
```

If `$ActiveForBusinessDate.Count` is not zero, stop. If it is zero, the following block also enforces the 08:30–08:45 CST window before dispatching exactly once:

```powershell
if ($ActiveForBusinessDate.Count -ne 0) {
  throw "A same-date daily run is already active; manual fallback is forbidden."
}
$NowUtc = [DateTimeOffset]::UtcNow
if ($NowUtc -lt $ManualWindowStart -or $NowUtc -gt $ManualWindowEnd) {
  throw "Manual fallback is allowed only from 08:30 through 08:45 Beijing time."
}

gh workflow run daily.yml `
  --repo $AcceptanceRepo `
  --ref master `
  --field "runDate=$BusinessDate"
```

Then inspect the single manual run without dispatching another:

```powershell
gh run list `
  --repo $AcceptanceRepo `
  --workflow daily.yml `
  --branch master `
  --event workflow_dispatch `
  --limit 1 `
  --json databaseId,status,conclusion,createdAt,displayTitle,url
```

To watch it, copy that `databaseId` into:

```powershell
gh run watch <DATABASE_ID> --repo $AcceptanceRepo --exit-status
```

Never add a `runId` field, never change `--ref master`, and never run the dispatch command more than once.
