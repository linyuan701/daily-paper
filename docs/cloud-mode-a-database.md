# Cloud Mode A database contract

> **Classification: technical/operational reference.** PostgreSQL is the only supported production store under [DPO-011](DECISIONS.md#dpo-011--cloud-only-operation-and-local-mode-retirement). SQLite sections describe retained legacy code and test dependencies, not a supported installation. See `docs/PROJECT_STATE.md` and `docs/ARCHITECTURE.md` for current state and scope.

## Scope

PR 2 originally added PostgreSQL persistence without changing the SQLite schema/history or importing local data. Local runtime support has since been retired. Supported deployment uses the explicit PostgreSQL commands in GitHub workflows, not the old local setup workflow.

The PostgreSQL baseline is derived from the repository's current logical model. Pre-existing Local schema and migration changes remain user-owned and are not staged by PR 2; the SQLite history is neither rewritten nor flattened. The database contract verifies that the Cloud schema covers the Local model names and that its committed baseline has no drift.

The first personal instance uses Neon. Region selection is an operator choice: the initial instance may use AWS `eu-central-1` (Frankfurt), while other users should choose a Neon region near their primary location. No region is encoded in application code or shared configuration.

## Independent Prisma roots

| Mode | Schema | Migrations | Generated Client |
|---|---|---|---|
| Local | `prisma/schema.prisma` | `prisma/migrations/**` | `src/generated/prisma` |
| Cloud | `prisma/postgresql/schema.prisma` | `prisma/postgresql/migrations/**` | `src/generated/prisma-postgresql` |

The Cloud history starts with one PostgreSQL baseline generated from an empty database. It is intentionally independent from the incremental SQLite history. Neither provider is replaced dynamically in a shared schema.

## Commands

```text
npm run prisma:cloud:validate
npm run prisma:cloud:generate
npm run prisma:cloud:migrate:deploy

npm run test:db-contract
```

Cloud commands read the Neon connection string from `DATABASE_URL`. Use a direct PostgreSQL connection URL for migration deployment when the provider distinguishes direct and pooled endpoints. Never commit the URL or echo it in logs.

GitHub `daily.yml` and `profile.yml` select cloud mode and run the explicit PostgreSQL commands above. Local `setup`/`doctor` instructions are retired and are not a cloud prerequisite.

## Contract and integration testing

The no-credential database contract verifies both providers, distinct Client outputs, schema parity, PostgreSQL migration drift, and PostgreSQL-specific SQL. It does not connect to a database.

Those existing dual-schema checks are implementation dependencies until reviewed cleanup, not a continuing Local Mode feature-parity commitment. Supported PostgreSQL integration acceptance uses the disposable database service in GitHub CI.

The real migration and repository CRUD test is opt-in and reads only `TEST_POSTGRES_DATABASE_URL`. It creates a randomly named isolated PostgreSQL schema, deploys the Cloud migration history, exercises create/read/update through a repository, then removes only that validated test schema. If the variable is absent, the test is skipped and must be reported as not verified against Neon.

## Empty start and retired import proposal

The first Cloud database starts empty. Zotero items and interest profiles are rebuilt through the normal synchronization and profile pipelines. The existing SQLite file and its verified backup remain untouched.

The old SQLite-to-PostgreSQL import proposal in `docs/cloud-mode-a-migration-plan.md` is abandoned under DPO-011, not scheduled work or a prerequisite. Existing local data and backups remain untouched. Any future user-requested import needs its own source/target and data-safety contract.
