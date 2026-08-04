# Production backup, recovery, and rollback

This runbook covers the single-user Cloud Mode deployment: GitHub Actions runs the daily and profile jobs, Cloudflare Workers serves the Access-protected dashboard and interactive APIs, and Neon PostgreSQL is the cloud source of truth. Local SQLite and a real Obsidian vault are outside this procedure.

Use this runbook for a planned production migration, credential compromise, application rollback, or database recovery drill. Keep all evidence outside the repository on an encrypted volume. Evidence can contain account, branch, endpoint, role, host, and research-data metadata even when it contains no password.

## Safety rules

- Name an incident commander and database operator. Record an explicit approval before changing production routing, secrets, roles, branches, or workflow state.
- Freeze every writer before a backup used as a migration gate or before recovery: the daily workflow, the manual profile workflow, and Access-authenticated Worker writes. Do not remove Cloudflare Access or create a public bypass while troubleshooting.
- Never run `prisma migrate dev`, `prisma db push`, `pg_restore --clean`, `pg_restore --create`, or an in-place Neon restore against production under this runbook.
- Restore logical backups only into a separately identified, verified-empty database. A different password or endpoint hostname alone does not prove that the target is separate; verify Neon project, branch, endpoint, and database IDs in the Console.
- Commands below intentionally do not drop databases, delete branches, revoke roles, overwrite backup files, force-push Git refs, or delete plaintext working files. Perform retirement only after cutover evidence, retention requirements, and a second-person review are complete.
- Never paste a connection URL or token into a command argument, transcript, issue, or committed file. Load secrets into the current process through a hidden prompt or an approved secret manager, then close the shell when finished.

## Recovery objectives and private evidence

Freeze these values for each installation before an incident:

| Contract | Operator value |
|---|---|
| Maximum tolerated data loss (RPO) | `<RPO_DURATION>` |
| Maximum tolerated service interruption (RTO) | `<RTO_DURATION>` |
| Neon history/instant-restore window | `<NEON_RESTORE_WINDOW>` |
| Neon snapshot cadence and retention | `<SNAPSHOT_CADENCE>` / `<SNAPSHOT_RETENTION>` |
| Encrypted logical-export cadence | `<PG_DUMP_CADENCE>` |
| On-site encrypted-export retention | `<ON_SITE_RETENTION>` |
| Independent/off-site encrypted-export retention | `<OFF_SITE_RETENTION>` |
| Recovery drill cadence | `<DRILL_CADENCE>` |
| Evidence directory and owner | `<PRIVATE_ENCRYPTED_EVIDENCE_LOCATION>` / `<OWNER>` |

Do not claim an RPO shorter than the newest independently usable recovery point. Neon PITR can provide a finer point inside the configured history window; a `pg_dump` export recovers only to the dump snapshot. Keep both when the required RPO and provider-independence demand it.

## 1. Contain and quiesce production

For an incident, first deny new interactive traffic with the existing Cloudflare Access application (for example, an incident-only deny policy). Keep `/api/health/live` as the only optional public exception. Do not disable Access in a way that exposes the Worker.

Disable both database-writing workflows. `profile.yml` is manual-only, but disabling it prevents an accidental dispatch during recovery.

```powershell
$RecoveryRepository = Read-Host "GitHub repository (OWNER/REPO)"
if ($RecoveryRepository -notmatch '^[^/\s]+/[^/\s]+$') { throw "Expected OWNER/REPO" }

gh workflow disable daily.yml --repo $RecoveryRepository
if ($LASTEXITCODE -ne 0) { throw "Could not disable daily.yml" }
gh workflow disable profile.yml --repo $RecoveryRepository
if ($LASTEXITCODE -ne 0) { throw "Could not disable profile.yml" }

gh run list --repo $RecoveryRepository --workflow daily.yml --status in_progress
gh run list --repo $RecoveryRepository --workflow profile.yml --status in_progress
```

Disabling a workflow does not prove that an already-running job stopped. Review the listed run IDs, wait for completion when safe, or cancel each approved run explicitly with `gh run cancel <RUN_ID> --repo <OWNER/REPO>`. Record the run IDs and final states. Confirm in Neon monitoring that no application sessions are still writing before taking the gate backup.

For a planned migration, use the same quiescence boundary during the final backup and migration window. Do not rely only on GitHub concurrency: the Worker supports interactive writes.

## 2. Pre-migration identity, status, and backup gate

No production migration proceeds until every gate in this section is recorded as passed.

### 2.1 Load the source URL without displaying it

Run PowerShell 7 from the reviewed known-good repository SHA. The following prompt avoids shell history and screen echo. The value remains in this process environment, so close the shell after the operation.

```powershell
$RecoverySecret = Read-Host "Production source DATABASE_URL" -AsSecureString
$RecoverySecretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RecoverySecret)
try {
  $env:RECOVERY_SOURCE_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($RecoverySecretPtr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($RecoverySecretPtr)
  $RecoverySecret.Dispose()
}
if ([string]::IsNullOrWhiteSpace($env:RECOVERY_SOURCE_DATABASE_URL)) { throw "Source URL is empty" }
```

### 2.2 Prove identity and provider health

In the Neon Console, record privately:

- account/organization, project ID and region;
- production branch ID and name, endpoint ID, database name, and role name;
- configured history retention and snapshot state;
- current Neon operation state and the [Neon service status](https://neonstatus.com/) at the gate time;
- approved application SHA, PostgreSQL migration SHA, current Cloudflare Worker version ID, and last successful daily/profile run IDs.

Capture database identity without printing the connection URL:

```powershell
$RecoveryEvidenceRoot = Read-Host "Existing absolute directory on an encrypted volume"
if (-not (Test-Path -LiteralPath $RecoveryEvidenceRoot -PathType Container)) { throw "Evidence directory does not exist" }
$RecoveryEvidenceRoot = (Resolve-Path -LiteralPath $RecoveryEvidenceRoot).Path
$RecoveryStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$RecoveryIdentityFile = Join-Path $RecoveryEvidenceRoot "source-identity-$RecoveryStamp.csv"
if (Test-Path -LiteralPath $RecoveryIdentityFile) { throw "Refusing to overwrite $RecoveryIdentityFile" }

& psql $env:RECOVERY_SOURCE_DATABASE_URL -X --csv -v ON_ERROR_STOP=1 --command @'
SELECT current_database() AS database_name,
       current_user AS role_name,
       inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       pg_is_in_recovery() AS is_replica,
       pg_current_wal_lsn()::text AS current_wal_lsn,
       now() AT TIME ZONE 'UTC' AS captured_at_utc;
'@ | Set-Content -LiteralPath $RecoveryIdentityFile -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Source identity query failed" }
```

Compare this output with the expected Neon Console identity. Stop if the project, branch, endpoint, database, role, region, or PostgreSQL major version is unexpected.

### 2.3 Record migration, schema, constraint, and count baselines

Set Prisma's required variable only in this process and record the current migration state:

```powershell
$env:DATABASE_URL = $env:RECOVERY_SOURCE_DATABASE_URL
$RecoveryMigrationFile = Join-Path $RecoveryEvidenceRoot "source-prisma-status-$RecoveryStamp.txt"
if (Test-Path -LiteralPath $RecoveryMigrationFile) { throw "Refusing to overwrite $RecoveryMigrationFile" }
& npx prisma migrate status --schema prisma/postgresql/schema.prisma *> $RecoveryMigrationFile
if ($LASTEXITCODE -ne 0) { throw "Production migration status is not clean; review before continuing" }
```

Capture these SQL result sets from the quiesced source as CSV evidence. Store the full outputs, not only screenshots.

```sql
SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
ORDER BY started_at, migration_name;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

SELECT conname, conrelid::regclass::text AS child_table,
       confrelid::regclass::text AS parent_table, convalidated
FROM pg_constraint
WHERE contype = 'f'
ORDER BY child_table, conname;

SELECT 'ZoteroItemRaw' AS table_name, count(*)::bigint AS row_count FROM "ZoteroItemRaw"
UNION ALL SELECT 'ZoteroCollection', count(*)::bigint FROM "ZoteroCollection"
UNION ALL SELECT 'ProfileSnapshot', count(*)::bigint FROM "ProfileSnapshot"
UNION ALL SELECT 'DailyIngestionRun', count(*)::bigint FROM "DailyIngestionRun"
UNION ALL SELECT 'DailyCanonicalCandidate', count(*)::bigint FROM "DailyCanonicalCandidate"
UNION ALL SELECT 'DailyRecommendationResult', count(*)::bigint FROM "DailyRecommendationResult"
UNION ALL SELECT 'CandidateFeedbackLog', count(*)::bigint FROM "CandidateFeedbackLog"
UNION ALL SELECT 'JournalFeedSource', count(*)::bigint FROM "JournalFeedSource"
ORDER BY table_name;
```

Also record the latest successful sync, profile, daily run, recommendation date, and feedback timestamps needed to judge freshness. Counts are evidence, not a substitute for application-level sampling.

### 2.4 Establish provider and portable recovery points

Prefer both protections:

1. In Neon's **Backup & Restore** page, create or identify a named pre-migration snapshot, or create a new child branch at the approved timestamp/LSN. Use a multi-step/new-branch recovery point. Do not use one-step restore on the production branch. Record snapshot/branch IDs, timestamp/LSN, status, retention/expiry, and a read-only preview query result.
2. Create a PostgreSQL custom-format logical export, immediately encrypt it, and copy the encrypted artifact plus checksum to the approved independent location.

Neon PITR/branch recovery is fast and preserves a point inside the provider's retained history, but is tied to the Neon account, project, feature availability, and restore window. A logical export is portable and provider-independent, but its RPO is the dump snapshot and a large restore can take longer. Neither a Worker version nor a Git commit is a database backup.

Use PostgreSQL client tools of the same major version as the source, or a newer `pg_dump` that supports the source. Create the plaintext working archive only on an encrypted volume. GnuPG prompts for an encryption passphrase; store that passphrase in the approved secret manager, separately from the artifact.

```powershell
$RecoveryDumpFile = Join-Path $RecoveryEvidenceRoot "daily-paper-$RecoveryStamp.dump"
$RecoveryEncryptedFile = "$RecoveryDumpFile.gpg"
$RecoveryPlainHashFile = "$RecoveryDumpFile.sha256"
$RecoveryEncryptedHashFile = "$RecoveryEncryptedFile.sha256"
$RecoveryTocFile = "$RecoveryDumpFile.toc.txt"
@($RecoveryDumpFile, $RecoveryEncryptedFile, $RecoveryPlainHashFile, $RecoveryEncryptedHashFile, $RecoveryTocFile) |
  ForEach-Object { if (Test-Path -LiteralPath $_) { throw "Refusing to overwrite $_" } }

& pg_dump --format=custom --file=$RecoveryDumpFile $env:RECOVERY_SOURCE_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

& pg_restore --list $RecoveryDumpFile > $RecoveryTocFile
if ($LASTEXITCODE -ne 0) { throw "The dump archive cannot be listed" }
(Get-FileHash -Algorithm SHA256 -LiteralPath $RecoveryDumpFile).Hash |
  Set-Content -LiteralPath $RecoveryPlainHashFile -Encoding ascii

& gpg --symmetric --cipher-algo AES256 --output $RecoveryEncryptedFile $RecoveryDumpFile
if ($LASTEXITCODE -ne 0) { throw "Backup encryption failed" }
(Get-FileHash -Algorithm SHA256 -LiteralPath $RecoveryEncryptedFile).Hash |
  Set-Content -LiteralPath $RecoveryEncryptedHashFile -Encoding ascii
```

The gate passes only after all of the following are true:

- `pg_dump` exited successfully, `pg_restore --list` can read the archive, and warnings were reviewed;
- the encrypted artifact exists at the approved independent location and its SHA-256 matches after copying;
- the GnuPG passphrase can be retrieved by an authorized operator;
- the private manifest records artifact size, both checksums, source identity, capture time, tool versions, repository SHA, migration status, counts, and retention class;
- the Neon recovery point reports ready and its timestamp/LSN is inside the required RPO;
- quiescence remains in force and the migration owner explicitly signs the gate.

Do not automatically delete the plaintext archive. After the encrypted copy has been independently verified and the operation owner approves cleanup, remove the plaintext through the organization's reviewed secure-cleanup procedure. Retention expiry is also manual: never prune the only known-good backup or branch automatically.

## 3. Logical restore into a verified-empty database

Use this path for an independent restore or drill. For a Neon PITR recovery, restore to a new branch in the Console, preview the point-in-time data, and start at [section 4](#4-verify-the-restored-database); do not layer `pg_restore` on top of a PITR database.

### 3.1 Create and identify the isolated target

In Neon, create a separate recovery project or branch and then a new database named for the incident/drill. `createdb` and the Neon Console fail when a same-named database already exists; never repurpose the production database. Record the target project, branch, endpoint, database, and role IDs. Keep it unrouted and do not place its URL in GitHub or the Worker yet.

Load the target URL with a hidden prompt as in section 2.1, using `RECOVERY_TARGET_DATABASE_URL`. Then apply these gates:

```powershell
if ([string]::IsNullOrWhiteSpace($env:RECOVERY_TARGET_DATABASE_URL)) { throw "Target URL is empty" }
if ($env:RECOVERY_TARGET_DATABASE_URL -eq $env:RECOVERY_SOURCE_DATABASE_URL) { throw "Source and target URLs are identical" }
$RecoveryExpectedDatabase = Read-Host "Exact new recovery database name"
if ([string]::IsNullOrWhiteSpace($RecoveryExpectedDatabase) -or $RecoveryExpectedDatabase -match '^<.*>$') {
  throw "A concrete recovery database name is required"
}

$RecoveryActualDatabase = (& psql $env:RECOVERY_TARGET_DATABASE_URL -X -A -t -v ON_ERROR_STOP=1 `
  --command "SELECT current_database();").Trim()
if ($LASTEXITCODE -ne 0 -or $RecoveryActualDatabase -ne $RecoveryExpectedDatabase) {
  throw "Target database identity mismatch"
}

$RecoveryUserTableCount = (& psql $env:RECOVERY_TARGET_DATABASE_URL -X -A -t -v ON_ERROR_STOP=1 `
  --command "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE';").Trim()
if ($LASTEXITCODE -ne 0 -or [int64]$RecoveryUserTableCount -ne 0) {
  throw "Target is not empty; restore is blocked"
}
```

Separately compare the recorded Neon IDs. Stop if the target is the production project/branch/database, if a production hostname routes to it, or if any application secret already references it.

### 3.2 Verify, decrypt, inspect, and restore

Copy the encrypted artifact and its checksum to an encrypted working volume. Refuse any checksum mismatch or pre-existing output file.

```powershell
$RecoveryEvidenceRoot = Read-Host "Existing absolute directory on an encrypted working volume"
if (-not (Test-Path -LiteralPath $RecoveryEvidenceRoot -PathType Container)) { throw "Evidence directory does not exist" }
$RecoveryEvidenceRoot = (Resolve-Path -LiteralPath $RecoveryEvidenceRoot).Path
$RecoveryEncryptedFile = (Resolve-Path -LiteralPath (Read-Host "Encrypted .dump.gpg path")).Path
$RecoveryEncryptedHashFile = (Resolve-Path -LiteralPath (Read-Host "Encrypted SHA-256 file path")).Path
$RecoveryPlainHashFile = (Resolve-Path -LiteralPath (Read-Host "Decrypted archive SHA-256 file path")).Path
$RecoveryStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")

$RecoveryEncryptedExpectedHash = (Get-Content -LiteralPath $RecoveryEncryptedHashFile -Raw).Trim()
$RecoveryEncryptedActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $RecoveryEncryptedFile).Hash
if ($RecoveryEncryptedActualHash -ne $RecoveryEncryptedExpectedHash) { throw "Encrypted backup checksum mismatch" }

$RecoveryRestoreDump = Join-Path $RecoveryEvidenceRoot "restore-working-$RecoveryStamp.dump"
if (Test-Path -LiteralPath $RecoveryRestoreDump) { throw "Refusing to overwrite $RecoveryRestoreDump" }
& gpg --decrypt --output $RecoveryRestoreDump $RecoveryEncryptedFile
if ($LASTEXITCODE -ne 0) { throw "Backup decryption failed" }

$RecoveryPlainExpectedHash = (Get-Content -LiteralPath $RecoveryPlainHashFile -Raw).Trim()
$RecoveryPlainActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $RecoveryRestoreDump).Hash
if ($RecoveryPlainActualHash -ne $RecoveryPlainExpectedHash) { throw "Decrypted archive checksum mismatch" }

& pg_restore --list $RecoveryRestoreDump
if ($LASTEXITCODE -ne 0) { throw "Decrypted archive cannot be listed" }
```

Review the archive source and object list. A PostgreSQL archive can contain executable database definitions; restore only a trusted artifact. Then restore in one transaction. `--no-owner` and `--no-privileges` make the recovery role own restored objects and avoid replaying source grants. Deliberately omit `--clean` and `--create`.

`pg_dump` exports one database, not cluster roles. Provision the intended target role separately before restore. The role in `RECOVERY_TARGET_DATABASE_URL` becomes the owner of restored objects; if a distinct cutover role is required, apply only its reviewed grant/ownership baseline and verify it before cutover.

```powershell
$RecoveryRestoreLog = Join-Path $RecoveryEvidenceRoot "pg-restore-$RecoveryStamp.log"
if (Test-Path -LiteralPath $RecoveryRestoreLog) { throw "Refusing to overwrite $RecoveryRestoreLog" }

& pg_restore --exit-on-error --single-transaction --no-owner --no-privileges `
  --dbname=$env:RECOVERY_TARGET_DATABASE_URL $RecoveryRestoreDump *> $RecoveryRestoreLog
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed; the single transaction was rolled back" }
```

Do not delete the decrypted working archive automatically. Secure it and follow the reviewed manual cleanup step only after verification.

## 4. Verify the restored database

Verification is a release gate, not an observational check. Save every result with UTC time, target IDs, artifact hash, tool versions, and operator.

1. **Migration history:** compare every `_prisma_migrations` row with the source baseline. There must be no row with `finished_at IS NULL` unless it is explicitly rolled back, no unexpected migration name/checksum, and no failed migration log requiring resolution.
2. **Schema:** compare the sorted public table list and the reviewed schema/migration SHA with the baseline. A matching `prisma migrate status` is required, but remember that `migrate deploy` does not detect arbitrary schema drift.
3. **Data:** compare the critical table counts from section 2.3 and sample known recent sync, profile, daily-run, recommendation, feedback, and journal rows. A PITR point intentionally earlier than the source baseline must instead match the approved point-in-time expectations.
4. **Foreign keys:** compare the full foreign-key list and require every restored foreign key to be validated. Because `pg_restore --exit-on-error --single-transaction` created constraints in the same successful transaction, a constraint creation or data-load error cannot be treated as partial success.
5. **Application evidence:** from a non-production preview protected by Access, verify liveness, readiness, recommendation reads, one approved reversible test write, a second sequential request, and sanitized failure behavior. Do not point the production hostname at the target yet.

Useful failure queries:

```sql
SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs
FROM "_prisma_migrations"
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at;

SELECT conname, conrelid::regclass::text AS child_table,
       confrelid::regclass::text AS parent_table, convalidated
FROM pg_constraint
WHERE contype = 'f' AND NOT convalidated;
```

From the exact known-good repository SHA associated with the recovery point, run status, deploy, and status again against the recovery target only:

```powershell
$env:DATABASE_URL = $env:RECOVERY_TARGET_DATABASE_URL
& npx prisma migrate status --schema prisma/postgresql/schema.prisma
$RecoveryStatusBeforeDeploy = $LASTEXITCODE
if ($RecoveryStatusBeforeDeploy -ne 0) {
  Write-Warning "Review pending/diverged migration output before any deploy"
}

$RecoveryDeployApproval = Read-Host "Type the exact recovery database name to approve migrate deploy"
if ($RecoveryDeployApproval -ne $RecoveryExpectedDatabase) { throw "Migration approval mismatch" }
& npx prisma migrate deploy --schema prisma/postgresql/schema.prisma
if ($LASTEXITCODE -ne 0) { throw "migrate deploy failed; do not cut over" }
& npx prisma migrate status --schema prisma/postgresql/schema.prisma
if ($LASTEXITCODE -ne 0) { throw "Post-deploy migration status is not clean" }
```

For an exact logical restore at the matching SHA, `migrate deploy` should normally be a no-op. Pending migrations require a separate compatibility and backup review. Never use `migrate resolve` merely to make the status green.

## 5. Coordinated database cutover and secret rotation

Keep workflows disabled and Access in incident deny mode. Preserve the old database and old credential until the new target is verified through every consumer.

1. In Neon, create a new credential/role for the verified target with only the privileges required by the frozen deployment. Do not reuse the credential suspected in an incident. The current contract uses one `DATABASE_URL` for Actions migration/job access and Worker runtime access, so that role must satisfy both; splitting migration and runtime URLs is a separately reviewed configuration change, not an incident-time improvisation.
2. Update the GitHub **production Environment** `DATABASE_URL` secret first. Confirm the Environment name, repository, secret update time, target branch/database identity, and protected approvers; never expose the value in logs.
3. Update the Worker `DATABASE_URL` secret second. Before the command, verify `wrangler.jsonc` names Worker `daily-paper` and that the authenticated Cloudflare account is the intended account. `wrangler secret put` prompts for the value instead of accepting it on the command line:

   ```powershell
   $RecoveryWorkerName = Read-Host "Exact production Worker name"
   if ($RecoveryWorkerName -ne "daily-paper") { throw "Unexpected Worker name" }
   & npx wrangler secret put DATABASE_URL --name $RecoveryWorkerName
   if ($LASTEXITCODE -ne 0) { throw "Worker DATABASE_URL update failed" }
   ```

4. With Access still enforced, verify `/api/health/live`, authenticated `/api/health/ready`, the dashboard, representative reads, and an approved reversible write against the target. Record the active Worker version ID. Confirm the GitHub Environment secret metadata is updated; exercise the first GitHub database-writing workflow only in the approved cutover window.
5. Restore the owner-only Access policy and route traffic to the verified Worker. Enable `profile.yml`, then `daily.yml`, and watch the first controlled run. Do not replay a date until its restored run state and idempotency outcome have been reviewed.
6. Only after both GitHub and Worker verification passes, revoke the old database credential in Neon. Revocation is a separate approved manual action; retain the old branch/database according to `<POST_CUTOVER_RETENTION>` without routing traffic to it.

Rotate other potentially exposed secrets one provider at a time, keeping old and new credentials concurrently valid where the provider supports it. Update the consumer, verify it, then revoke the old value:

| Secret family | Consumer/location | Verification before revocation |
|---|---|---|
| Zotero ID/API key | GitHub production Environment | Approved profile sync returns only expected IDs/counts; no key in logs |
| LLM key/base URL | GitHub production Environment (`DEEPSEEK_API_KEY` primary and retained `NVIDIA_API_KEY` rollback Secrets; `LLM_PROVIDER`, `LLM_BASE_URL`, and `LLM_MODEL` Variables) | Approved candidate summary/label operation succeeds; provider usage is attributable while logs expose no credential |
| SMTP user/password/from/to | GitHub production Environment | Approved test notification reaches only the expected recipient; logs remain redacted |
| WeCom webhook | GitHub production Environment | Approved test reaches the expected bot/room; revoke the old webhook afterward |
| Cloudflare API token/account ID | Deployment secret store or operator secret manager | Least-privilege identity can inspect/deploy only the intended account and Worker |
| Cloudflare Access service tokens | Cloudflare Zero Trust and authorized headless clients | New token passes the intended Access application; old token fails after revocation |
| Access audience/team domain/owner identity | Worker variables plus Cloudflare Access policy | Wrong audience/email fails closed; intended owner passes; no `Everyone` or public-domain allow rule exists |
| Operations GitHub token | Worker secret `OPERATIONS_GITHUB_TOKEN` | Fine-grained token is repository-scoped with Actions write only; an approved retry dispatches the fixed `daily.yml`, then the old token is revoked |

The current Worker should receive `DATABASE_URL`, its Access/runtime configuration, and—only when Operations retry is enabled—the repository-scoped `OPERATIONS_GITHUB_TOKEN` secret plus non-secret owner/repository/ref variables. Zotero, LLM, SMTP, WeCom, Obsidian, and Windows scheduler secrets remain outside the Worker.

## 6. Application and deployment rollback

> **Database compatibility boundary:** rolling back a Worker, a Cloudflare deployment, or a GitHub ref never reverses a PostgreSQL migration or restores data. A previous Worker may be unsafe after a contract migration. Freeze traffic and writers if compatibility is uncertain; use an expand/contract release or a separately verified database recovery. Never infer database rollback from a green application rollback.

### 6.1 Cloudflare Worker version rollback

Record the current deployment and the last verified version ID before acting:

```powershell
$RecoveryWorkerName = Read-Host "Exact production Worker name"
if ($RecoveryWorkerName -ne "daily-paper") { throw "Unexpected Worker name" }
& npx wrangler deployments list --name $RecoveryWorkerName
if ($LASTEXITCODE -ne 0) { throw "Could not list Worker deployments" }
```

Confirm in the Cloudflare dashboard that the version ID belongs to the intended Worker/account, predates the regression, has compatible bindings, and is database-compatible. Rollback immediately creates a new deployment at 100% traffic, so require explicit approval and specify the version ID; do not rely on Wrangler's implicit previous-version choice.

```powershell
$RecoveryVersionId = Read-Host "Approved known-good Cloudflare version ID"
if ([string]::IsNullOrWhiteSpace($RecoveryVersionId) -or $RecoveryVersionId -match '^<.*>$') {
  throw "A concrete version ID is required"
}
$RecoveryRollbackApproval = Read-Host "Type daily-paper to approve immediate rollback"
if ($RecoveryRollbackApproval -ne "daily-paper") { throw "Rollback approval mismatch" }
& npx wrangler rollback $RecoveryVersionId --name daily-paper --message "Approved recovery rollback; see private incident record"
if ($LASTEXITCODE -ne 0) { throw "Worker rollback failed" }
```

Verify the active version ID, Access enforcement, readiness, representative reads/writes, and logs. Cloudflare-connected resources and the Neon database are not rolled back with Worker code. If the version is no longer retained or bindings are incompatible, rebuild from a reviewed known-good Git tag through the normal test/deploy process; do not improvise an in-place database change.

### 6.2 GitHub Actions rollback and schedule control

Disable `daily.yml` and `profile.yml` as shown in section 1 before changing a ref. A scheduled workflow executes from the default branch; rolling back only a feature branch does not change the schedule. Restore the known-good code and workflow to the default branch with a reviewed revert/rollback pull request. Do not force-push or reset the protected default branch.

An LLM-provider rollback does not require a code rollback. With workflows disabled, restore `LLM_PROVIDER=nvidia`, `LLM_BASE_URL=https://integrate.api.nvidia.com/v1`, and `LLM_MODEL=deepseek-ai/deepseek-v4-flash`; the workflow then selects the retained `NVIDIA_API_KEY`. The generic `openai-compatible` provider remains available through the legacy `LLM_API_KEY` Secret. Prefer the canonical `LLM_BASE_URL` Variable; the legacy `LLM_API_BASE_URL` Variable is used only when the canonical name is unset. Review both base Variables before re-enabling and verify the provider with its isolated manual smoke workflow before any daily run.

For an approved manual recovery run, `gh workflow run --ref` accepts a branch or tag, not an arbitrary raw SHA. If the evidence has only a SHA, first create a reviewed immutable recovery tag or protected branch pointing to it through the repository's normal change controls. Then dispatch the workflow version at that ref:

```powershell
$RecoveryRepository = Read-Host "GitHub repository (OWNER/REPO)"
$RecoveryKnownGoodRef = Read-Host "Reviewed known-good tag or branch"
if ($RecoveryRepository -notmatch '^[^/\s]+/[^/\s]+$' -or [string]::IsNullOrWhiteSpace($RecoveryKnownGoodRef)) {
  throw "Repository and reviewed ref are required"
}
gh workflow run daily.yml --repo $RecoveryRepository --ref $RecoveryKnownGoodRef --field "runDate=<REVIEWED_YYYY-MM-DD>"
if ($LASTEXITCODE -ne 0) { throw "Workflow dispatch failed" }
```

Replace `<REVIEWED_YYYY-MM-DD>` before execution and confirm that the restored database does not already contain a conflicting successful or active run. A re-run uses the workflow/ref associated with that run; verify its SHA before using **Re-run jobs**. Keep the schedule disabled until the default-branch rollback, database compatibility, secrets, and first controlled run all pass. Re-enable explicitly:

```powershell
gh workflow enable profile.yml --repo $RecoveryRepository
if ($LASTEXITCODE -ne 0) { throw "Could not enable profile.yml" }
gh workflow enable daily.yml --repo $RecoveryRepository
if ($LASTEXITCODE -ne 0) { throw "Could not enable daily.yml" }
```

## 7. Cutover rollback and preservation

- **Before production cutover:** leave the failed recovery target isolated. Preserve its logs and IDs. Do not delete it automatically; expire it only after the incident owner approves the evidence/retention record.
- **After cutover, before old credential revocation:** freeze writers again, verify schema compatibility and the absence of unreconciled new writes, then an approved operator may point both consumers back to the retained old database using the same GitHub-first/Worker-second sequence.
- **After new writes or old credential revocation:** do not switch back casually. Reconcile data and credentials under a new recovery plan. A stale database can appear healthy while losing feedback, configuration, or completed run state.
- Keep old database branches, encrypted exports, manifests, and checksums for their approved retention periods. Deletion is never an automatic rollback step.

## 8. Recovery drill and RPO/RTO evidence template

Copy this template into the private encrypted evidence location for every drill or incident. Do not commit completed copies.

```text
Record ID: <INCIDENT_OR_DRILL_ID>
Classification: <PLANNED_MIGRATION|DRILL|INCIDENT>
Commander / DB operator / reviewer: <NAMES_OR_APPROVED_IDS>
Started UTC / declared recovered UTC: <TIMESTAMPS>
Approved RPO / RTO: <DURATIONS>

Source identity:
  Neon org/project/region: <IDS>
  branch/endpoint/database/role: <IDS>
  PostgreSQL version and WAL LSN: <VALUES>
  repository SHA / migration SHA: <SHAS>
  Worker name/version ID: <VALUES>
  last successful daily/profile run IDs: <VALUES>

Recovery point:
  method: <NEON_PITR|NEON_SNAPSHOT|PG_DUMP>
  timestamp/LSN/snapshot/branch ID: <VALUES>
  provider restore-window status: <VALUE>
  encrypted artifact location/size/SHA-256: <VALUES>
  decrypted SHA-256 and pg_restore TOC reviewed: <YES_NO_AND_REVIEWER>

Target identity:
  Neon org/project/region: <IDS>
  branch/endpoint/database/role: <IDS>
  empty-database gate evidence: <FILE_AND_RESULT>

Verification:
  _prisma_migrations comparison/status: <FILE_AND_RESULT>
  schema/table comparison: <FILE_AND_RESULT>
  foreign-key count/list/unvalidated count: <FILE_AND_RESULT>
  critical source/target row counts: <FILE_AND_RESULT>
  sampled latest sync/profile/daily/recommendation/feedback rows: <RESULT>
  migrate deploy result and final status: <FILE_AND_RESULT>
  preview liveness/readiness/read/write/second-request checks: <RESULTS>
  Access wrong-identity and intended-owner checks: <RESULTS>

Cutover and rollback:
  GitHub Environment DATABASE_URL updated UTC: <TIMESTAMP>
  Worker DATABASE_URL updated UTC / version ID: <VALUES>
  old DB credential revoked UTC: <TIMESTAMP_OR_NOT_YET>
  provider secrets rotated and verified: <LIST>
  workflow disabled/enabled times and run IDs/SHAs: <VALUES>
  rollback version/ref tested: <VALUES>

Measured objectives:
  incident/data-loss cutoff UTC: <TIMESTAMP>
  selected recovery point UTC: <TIMESTAMP>
  actual RPO = cutoff minus recovery point: <DURATION_AND_PASS_FAIL>
  recovery declared UTC minus incident start UTC: <ACTUAL_RTO_AND_PASS_FAIL>

Exceptions, lost/unreconciled writes, failed checks: <DETAILS>
Follow-up owner/due date: <VALUES>
Retention/cleanup approval and earliest date: <VALUES>
Final reviewer/sign-off UTC: <VALUES>
```

## Authoritative references

- Neon: [Backup and restore](https://neon.com/docs/manage/backups), [branching and recovery](https://neon.com/docs/guides/branching-intro), and [manage databases](https://neon.com/docs/manage/databases)
- PostgreSQL: [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html), [`pg_restore`](https://www.postgresql.org/docs/current/app-pgrestore.html), and [SQL dump backup/restore](https://www.postgresql.org/docs/current/backup-dump.html)
- Prisma: [`prisma migrate deploy`](https://www.prisma.io/docs/cli/migrate/deploy) and [`prisma migrate status`](https://www.prisma.io/docs/cli/migrate/status)
- Cloudflare: [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), and [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- GitHub: [disable and enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), [`gh workflow run`](https://cli.github.com/manual/gh_workflow_run), and [workflow event SHA/ref behavior](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)
