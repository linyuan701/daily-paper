# Site integration validation — 2026-09-19

Historical initial-prototype record. For the 2026-09-20 capability-gate outcome,
formal dashboard contract, current deployment observations and unresolved
production integration, see [current integration record](site-production-integration.md).
The old plugin/sign-in blockers below are not current runtime limitations.

Baseline: `origin/master@d8552a0468a5970ee530195726f6c96e04b286b3`.
Implementation: `codex/chatgpt-site-frontend`, IN DEVELOPMENT / NOT_DEPLOYED.

## Executed

- Root `npm test`: 26 notifier/workflow tests + 426 Vitest tests passed.
  15 PostgreSQL integration tests skipped because no disposable PostgreSQL URL
  was configured. Existing local SQLite tests used their disposable fixtures;
  no SQLite production runtime or fallback was introduced.
- `npm run test:site`: build, syntax checks and 19 Node tests passed. Covers
  fixed upstream routing, owner authorization, CSRF, query/method rejection,
  payload limits, redirect/HTML/secret reflection rejection, uncertain mutations,
  feedback write/readback, correction payload preservation and draft retention.
- Final `npm run typecheck` passed, including Worker type generation/checking.
- GitHub CI on implementation revision `61b9e5706675916ca6bc8ce7fa4b2d029cb18b78`:
  [ephemeral PostgreSQL migrations and 11 integration tests passed](https://github.com/linyuan701/daily-paper/actions/runs/35441994026/job/105894285428),
  as did [Site build/tests](https://github.com/linyuan701/daily-paper/actions/runs/35441994088),
  [Linux workerd build/smoke tests](https://github.com/linyuan701/daily-paper/actions/runs/35441994065),
  and secret scanning. These jobs do not access production data.
- Wrangler dry-run accepted the self-contained Site Worker: 51.78 KiB uncompressed,
  15.24 KiB gzip, no bindings. No deployment was performed.
- Independent read-only integration review: no actionable findings remaining.
  Findings fixed: partial-label evidence preservation, failure/delayed-write draft
  retention, backend 5xx uncertainty, and owner JWT compatibility with scoped AUD.
- Browser checks on synthetic fixtures: Dashboard, Top 20 navigation, detail,
  persisted Recall/Rerank features, Save round trip, Dismiss filtering, label-only
  correction and readback, Profile positive/negative evidence, refresh status,
  Operations stages/source failures, and feedback history. Desktop and 390px
  layout inspected. These are fixture checks, not production claims.
- Worker public health returned 200; anonymous recommendation API redirected to
  Cloudflare Access. GitHub daily run 35421549513 is complete_with_warnings with
  20 persisted recommendations and notification delivery sent.

The first root test invocation found the Site's Node test files through Vitest
and failed with two empty-suite errors. Vitest now excludes `sites/**`; Site tests
run through `test:site` and their own CI. The corrected root test gate passed.

The initial GitHub CI rejected the nested `.env.example` filename under its
existing tracked-file guard. The placeholder-only template was renamed to
`runtime-env.example`; the security guard was not weakened. Site tests, secret
scanning, and the Linux workerd build/smoke check passed on the initial revision.

The corrected revision's general quality job still fails at the production
dependency audit, before configuration/tests/build. It reports `@prisma/config`,
`deepmerge-ts`, `nodemailer`, and `prisma` outside the frozen vulnerability baseline.
[The master SHA's earlier CI](https://github.com/linyuan701/daily-paper/actions/runs/32106067180)
already failed this gate for the first, second and fourth packages. This change
does not modify dependency versions, the lockfile or the audit checker. The current
additional `nodemailer` finding applies to the same locked dependencies; it was
not present in that older log. No vulnerability baseline was relaxed. The full
GitHub quality/build gate is therefore not established.

## Not established

- A real Site preview/new private publication. No version was saved or deployed.
- Production Site service-token access to the master API contract.
- Production feedback write, content correction, or their readback.
- Deployed owner-web regression checks after backend adapter release.
- The four PostgreSQL tests outside the CI job's two targeted integration suites
  remain unrun; local root tests skipped all 15 without a disposable database.
- Worker production SHA/time or full source health from authenticated APIs.
  Current daily success retains warnings.

## Blockers and preserved state

The Sites plugin skill was available at the beginning of the task. Its local
directory and required execution-profile/build/package helper scripts disappeared
during the audit. Searches under installed plugin roots found no replacement;
native Sites metadata tools remained available. An asynchronous request asked the
user to restore the plugin. No manual publishing workaround was used.

The existing Site's normal ChatGPT sign-in was attempted using the existing owner
account. The callback returned to a sign-in gate instead of an authenticated
page. No bypass token was created, no auth policy was weakened, and no credentials
were exposed in source. This is an observed login failure, not a diagnosed cause.

The baseline backend lacks the machine-auth contract and production release
workflow needed for the new frontend. Changes remain reviewable code; production
Access, Worker, PostgreSQL, schedules, notifications and existing Site publication
were not changed. The original dirty Windows checkout was not modified.
