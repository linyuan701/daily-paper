# Cloud Mode A migration plan

> **Classification: historical migration plan.** It does not maintain current integration or production status. See `docs/PROJECT_STATE.md`; use the focused operational runbooks for current procedures.

> **Local portions retired (2026-09-19):** DPO-011 cancels this plan's ongoing Windows/Local Mode support, SQLite import roadmap, local installer work, Obsidian filesystem scope, and rollback through Local scheduling. These passages are abandoned proposals, not current instructions. Preserve user data and applied migrations; use the [cloud architecture](ARCHITECTURE.md) and [cloud recovery runbook](production-backup-recovery.md) for supported operations.

Implementation update (2026-07-27): PR 4 is merged. The first release uses an Access-protected production `workers.dev` route with preview URLs disabled; production account deployment and credentialed Neon/Cloudflare acceptance remain pending. Obsidian plugin work has not started.

Status: PR 1–PR 4 are approved, implemented, and merged. Production account deployment and credentialed acceptance remain in progress.

## Guardrails

- Preserve all pre-existing working-tree changes as user-owned.
- Keep Windows Local Mode working after every PR.
- Never edit already-applied SQLite migration SQL.
- Never run `prisma migrate dev` against user data or a cloud production database.
- Never put database contents, SQLite files, backups, logs, generated Obsidian notes, credentials, personal URLs, or provider payloads in Git or Actions artifacts.
- Keep profile and daily pipelines separate; keep recall and explainable rerank separate.
- Make cloud capabilities explicit; do not rely on missing environment variables to disable unsafe routes.
- Use expand/contract database changes so a prior Worker can serve during rollback.

## Phase and PR sequence

### PR 1 — deployment mode and configuration contract

Goal: add mode-aware validation without enabling PostgreSQL or public cloud execution.

Primary-agent coordination files:

```text
src/lib/config/env.ts
.env.example
.gitignore
package.json
package-lock.json
```

Configuration-installer files:

```text
scripts/check-env.mjs
scripts/doctor.mjs
scripts/setup.mjs
scripts/check-env/doctor/setup tests
```

Expected behavior:

- absent mode remains Local for backward compatibility;
- Local requires `file:` and retains current setup/doctor/scheduler behavior;
- Cloud requires PostgreSQL URL, Zotero Web transport, and hard-disables local filesystem/desktop capabilities;
- Local `setup` remains Windows-specific;
- Cloud setup is a non-destructive preflight and never creates or migrates a remote database implicitly;
- `.dev.vars*`, `.wrangler`, `.open-next`, local env variants, and generated cloud state are ignored.

Rollback: remove mode-aware code and examples. No database state is changed.

Approved inputs for this PR: absent mode remains Local; the first cloud provider is Neon but its Frankfurt region is not hardcoded; the cloud database starts empty; owner identity stays in Cloudflare Access rather than application config; workflow timezone/schedule remains a later `.github/workflows/daily.yml` deployment setting.

### PR 2 — PostgreSQL schema, client, and repository compatibility

Goal: prove the same domain model and repository behavior on disposable PostgreSQL while retaining SQLite.

Primary-agent-owned files:

```text
prisma/postgresql/schema.prisma
prisma/postgresql/migrations/**
prisma/schema parity tooling
src/db/prisma/client.ts (or the frozen replacement factory)
provider-specific generate/validate/migrate scripts
database integration-test configuration
```

Required experiments before settling the interface:

1. Generate both clients without changing repository DTO behavior.
2. Test `Json`, JSON defaults, enums, timestamps, booleans, cascades, unique constraints, and indexes.
3. Run all interactive/batch transaction repositories on PostgreSQL.
4. Validate the `requestKey` unique race with two PostgreSQL clients.
5. Replace source-seen and feedback event read-before-create races with atomic conflict handling and test with two PostgreSQL connections.
6. Add a fenced lease across the whole pipeline, atomic stage claims, heartbeat/stale recovery, and protection from a former owner completing after lease loss.
7. Make successful ingestion immutable to downstream failure: commit candidates, cursor/seen state, and ingestion success atomically; retry only the failed downstream stage and never delete persisted feedback.
8. Prove the Workers adapter/client in a minimal `workerd` request before integrating Next.js.
9. Prove that no request-bound connection object is reused across Worker requests.

Rollback: stop cloud generation/deploy and leave the PostgreSQL database intact for diagnosis. Local continues using existing schema/history. Do not delete or down-migrate production automatically.

### PR 3 — direct daily CLI and GitHub Actions workflow

Goal: run the existing seven-stage pipeline on a standard Linux/Node runner.

Likely new files:

```text
scripts/run-daily-cloud.ts
.github/workflows/daily.yml
focused CLI/workflow contract tests
```

Shared files requiring primary ownership:

```text
package.json
package-lock.json
job result/exit-code contract
```

Workflow requirements:

- `schedule` plus `workflow_dispatch` with a required, strictly validated UTC `runDate` for manual dispatch;
- Node 22, `npm ci`, explicit PostgreSQL schema/client;
- protected production environment with `contents: read`; `actions: read` is scoped only to the secret-free preflight job;
- business-date production concurrency group, `cancel-in-progress: false`, and bounded queue wait;
- measured timeout;
- validate/generate the independent PostgreSQL client and run `prisma migrate deploy`, never `migrate dev`;
- direct job execution, not `/api/jobs/daily`;
- distinct complete/partial/failed conclusions;
- safe retry using DB request key and stale-run recovery;
- job summary contains counts/status/run ID only;
- job-side WeCom/SMTP after persisted results; desktop and Obsidian disabled;
- no raw env, connection URL, headers, LLM prompt/response, webhook, or SMTP error body in logs.

Add a separate profile workflow only if the user approves its cadence in the frozen scope.

Rollback: disable the workflow in GitHub, retain database results, and continue Local scheduling. Re-enable only after the failed run state is reconciled.

Implemented scope: the workflow directly invokes the persisted CLI, uses a 120-minute Actions timeout, and relies on database request keys/stage recovery for safe reruns. Provider-level deadline budgeting and ambiguous LLM POST charge policy remain later hardening work; they are not silently claimed by this PR.

### PR 4 — OpenNext Worker Web/API compatibility and private preview

Goal: prove only the interactive web responsibility in a private preview. Do not enable an unauthenticated production URL.

Likely files:

```text
open-next.config.ts
wrangler.jsonc
next.config.ts
cloudflare-env.d.ts or type-generation configuration
.github/workflows/deploy-cloud.yml
Worker preview smoke tests
```

Shared manifests and ignore files remain primary-owned. Work includes:

- OpenNext and Wrangler dependencies/scripts;
- current pinned compatibility date and `nodejs_compat`;
- PostgreSQL Worker adapter and request-safe client;
- cloud route capability matrix;
- feedback path decoupled from Obsidian;
- liveness/readiness split;
- same-origin UI behavior preserved;
- compressed bundle-size check;
- Linux OpenNext build and `workerd` preview tests.

Preview/deploy workflow order after the PR 5 production security gate is satisfied:

```text
validate/test -> PostgreSQL migration status/backup gate -> migrate deploy -> OpenNext build -> preview smoke -> deploy
```

For non-additive migrations, use an expand/contract release over multiple deploys. Do not assume rolling back Worker code reverses the database.

Rollback: Cloudflare version rollback to last verified Worker; retain compatible expanded schema. Disable Cloud routes if DB compatibility is uncertain.

### PR 5 — authentication, request integrity, SSRF, and first production enablement

Goal: make the instance safe to expose.

Work includes:

- documented/automated Cloudflare Access application setup where feasible;
- owner allowlist and preview protection;
- same-origin/Fetch Metadata or CSRF enforcement on all writes;
- explicit route capability guard;
- least-privilege GitHub and Cloudflare API tokens;
- distinct migration/runtime credentials where supported;
- security tests for anonymous, cross-origin, wrong-mode, and service-token requests;
- log-redaction tests, including transformed/URL-encoded credentials;
- no permissive CORS;
- authenticated journal administration plus SSRF protection for feed URLs: HTTPS/hostname policy, private/link-local/metadata/IPv6 rejection, DNS and every redirect revalidation, response size/type/time limits, and focused bypass tests;
- Access protection and application-level JWT validation verified before accepting the production `workers.dev` route.

Rollback: block public routes at Access first, then revert application changes. Never temporarily expose the unauthenticated Worker to debug it.

### PR 6 — installer, import, docs, and acceptance

Goal: make one-user/one-instance deployment reproducible without source edits except the explicitly chosen schedule limitation.

Likely deliverables:

```text
cloud doctor/preflight
optional SQLite-to-PostgreSQL import tool
deployment runbook
GitHub Secrets/Variables checklist
Cloudflare Access/Secrets checklist
backup/restore and upgrade guide
README corrections
full acceptance automation
```

The import tool is opt-in and requires an explicit source and target. It refuses a non-empty target unless a separate reviewed resume mode exists. It creates no public artifact and prints counts, not records.

Rollback: keep the Local installation and SQLite backup. Cloud import never overwrites or deletes the source database.

## Files expected to change across implementation

This is a planning inventory, not authorization.

| Area | Candidate files |
|---|---|
| shared config | `src/lib/config/**`, `.env.example`, `.gitignore` |
| setup/doctor | `scripts/check-env.mjs`, `scripts/setup.mjs`, `scripts/doctor.mjs`, tests |
| database | new PostgreSQL schema/history, `src/db/prisma/client.ts`, focused repository integration tests |
| job | new direct CLI, `package.json`, daily workflow |
| Worker | `next.config.ts`, OpenNext/Wrangler config, deploy workflow |
| route security/capability | middleware or shared guard plus affected route tests |
| cloud-safe feedback/health | feedback factory/route and health/status routes/tests |
| documentation | README and cloud deployment/upgrade/import docs |

## Files and logic not expected to change

- existing SQLite migration SQL;
- Windows scheduled-task PowerShell definitions, except documentation or mode preflight if proven necessary;
- Recall/BM25/vector and rerank formulas;
- collection priority, star, recency, structured tag semantics;
- feedback consumption timing in profile refresh;
- source-specific freshness algorithms;
- recommendation reason evidence generation;
- Chinese summary prompt/content design unless a cloud-blocking defect is proven;
- Dashboard visual redesign;
- direct Obsidian vault format and templates;
- D1, Cloudflare Workflows, Queues, SaaS tenancy, billing, or public registration.

## Optional SQLite to PostgreSQL import

The importer must be a separate maintenance command, not `setup`.

Preconditions:

1. verified SQLite backup and integrity check;
2. source opened read-only;
3. target provider/schema/migration version verified;
4. target empty or explicit resumable import session;
5. notifications and live job execution disabled during import.

Procedure:

1. create an import run record outside user content tables or a local checkpoint;
2. stream rows in foreign-key order while preserving primary IDs;
3. normalize Prisma JSON/date/boolean representations without changing content;
4. load parent tables before relation/join/log tables;
5. verify per-table counts, unique identifiers, foreign keys, latest active profile, latest daily run, stage rows, summaries, recommendation evidence, and feedback;
6. run read-only feed/profile queries against PostgreSQL;
7. produce a local redacted report;
8. leave SQLite untouched.

Do not use Prisma provider switching or cross-provider `migrate diff` as a data-copy mechanism. Prisma states that migration SQL is provider-specific and cross-provider histories are not interchangeable.

## Release and rollback strategy

| Failure | Immediate action | Data action | Local impact |
|---|---|---|---|
| Actions daily failure | stop/retry after state inspection | reclaim only audited stale lease | none |
| PostgreSQL migration failure | stop deploy | provider restore/resolve procedure; no `migrate dev` | none |
| Worker build/preview failure | do not deploy | none | none |
| Worker production regression | roll back Worker version | keep expand-compatible schema | none |
| Access misconfiguration | default deny/block hostname | none | none |
| notification failure | report warning | keep completed recommendation | none |
| LLM partial | retain ranking/feed | resume summary stage | none |
| import mismatch | stop import | discard/recreate target only with explicit approval; retain source | none |

## Required user decisions before PR 1

1. PostgreSQL vendor/region and whether it supplies pooled and direct URLs.
2. Empty cloud database or optional import of current SQLite data.
3. Cloudflare Access login method/allowlisted identity.
4. Schedule policy: fixed template schedule, edited workflow cron, or external dispatcher.

Decisions about `read` feedback, settled-partial exit status, profile-refresh cadence, and deploy mechanism must be frozen before the PR that owns each contract.
