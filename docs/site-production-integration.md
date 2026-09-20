# #45 production integration — 2026-09-20

Status: IN DEVELOPMENT. Keep the PR Draft. Runtime capability gate A is established;
the #45 application production read/write gate is a separate, still-open gate.

## Source and deployed versions

- Fetched authoritative master: `d8552a0468a5970ee530195726f6c96e04b286b3`.
- #45 starting revision: `739b5e253723ab3742c6214d5e0a861f04e23719`.
- Deployed dashboard adapter source: remote `codex/site-read-worker-release`,
  `9f660d264d845d831993c4738c42ce6ff3f4928b`.
- Cloudflare deployment API, inspected 2026-09-20, reports deployment
  `435c8f11-f0ca-4719-8fdb-79137d3f2c22`, version
  `a36410a9-ed06-461c-a882-e31c4cf9121b`, 100%, deployed 2026-09-13T12:23:20Z.
  Its message explicitly identifies 9f660d2 and the isolated patched build.
- Existing private Site remains version 4, owner-only policy revision 1 (one owner,
  no external visitors). No #45 replacement has been published in this phase.

The deployed Worker uses an older business baseline (`dd78ae8`) plus the read
adapter, while Actions already execute master. A release must isolate adapter
changes or explicitly review this baseline difference; simply uploading a full
master build is not proof that unrelated production behavior was preserved.

## Contract reconciliation

| Concern | Existing live dashboard v1 | #45 formal frontend |
|---|---|---|
| Feed | Latest validated run, max 20 stored selected results | Existing daily feed, also supports historical runId |
| Ranking | Stored Recall/Rerank reasons and scores, linkage checks | Existing separate Recall/Rerank GET APIs; checks matching IDs |
| Profile | Active and ranking snapshots, persisted consumption evidence | Active snapshot, positive labels, persisted feedback evidence, refresh status |
| Operations | Last 10 runs and four source projections | Existing operations API plus separate GitHub run metadata |
| Feedback history | Latest 100 global logs, explicit truncation/unknown states | Existing filtered logs API, bounded to 500 |
| Writes | None | Existing POST feedback/actions and PUT candidates/content |
| Authentication | SITE_READ audience/client, exact dashboard GET | SITE_API audience/client, exact method/path allowlist |

The dashboard service/factory, narrow profile getter, projection tests and route
are now in #45. The v1 response remains compatible; nonempty query parameters
are explicitly rejected (400) rather than silently ignored. Missing persisted
evidence remains null/unknown. No ranking, feedback learning or profile refresh
algorithm was imported. The two projection formats intentionally remain distinct
compatibility DTOs; neither computes business scores.

The old read credentials only authorize `GET /api/site/dashboard`, even when the
new service grant is configured. The original owner audience remains valid.
The formal frontend reuses #45's existing APIs and has no hidden endpoint.

## Exact additional Access scope

Keep the existing owner policy. For the explicit SITE_API audience and exact
service principal, authorize these HTTP contracts only:

| Method | Path |
|---|---|
| GET | /api/recommendations/daily |
| GET | /api/ranking/recall |
| GET | /api/ranking/rerank |
| GET | /api/profile/snapshot |
| GET | /api/profile/refresh |
| GET | /api/feedback/logs |
| GET | /api/operations/runs |
| GET | /api/site/capabilities |
| GET | /api/site/dashboard |
| POST | /api/feedback/actions |
| PUT | /api/candidates/content |

Cloudflare Access path applications enforce the identity boundary; the Worker
additionally enforces exact methods. No wildcard whole-API service grant, Bypass
policy, readiness route, refresh execution, retry/dispatch or admin endpoint is
included. Browser requests go only to the same-origin Site proxy. No CORS
relaxation, browser credentials or direct database connection is needed.

## Capability-gate eight-file audit

| Gate file | Disposition |
|---|---|
| docs/sites-capability-gate-2026-09-20.md | Prior evidence remains on its remote branch; summarized here, not imported as application code |
| sites/capability-gate/README.md | Relevant package/runtime contract documented in the formal Site README |
| overlay/app/api/capability-gate/route.ts | Not imported; one-shot diagnostic API |
| overlay/app/capability-gate/page.tsx | Not imported; existing private diagnostic remains in deployed version 4 |
| overlay/lib/server/capability-gate.ts | Not imported; formal proxy already enforces owner and server-secret boundaries |
| scripts/package.mjs | Imported as the thin official packager launcher, with artifact verification |
| scripts/verify-package.mjs | Adapted for dependency-free Worker output and all-artifact secret-value scanning |
| tests/gate.check.mjs | Not copied; formal artifact/proxy/authorization tests cover production boundaries |

Official package entries are `dist/server/index.js`, `dist/client/`, and
`dist/.openai/hosting.json`. No D1/R2 binding. The installed official packager
successfully packaged this candidate; that is packaging evidence, not deployment.
The official Windows build wrapper's npm shim limitation is avoided by the same
package build script directly; runtime remains cloud-only.

## Production observations in this phase

Normal existing-owner Site session loaded production Top 20, active snapshot,
pipeline stages, source health and feedback evidence at approximately 10:56 UTC.
The displayed daily business date was 2026-09-19; Actions scheduled run
35490073000 used master d8552a0 and completed with separately displayed pipeline
warnings. These are observations of version 4 plus the old deployed adapter,
not a claim that #45's new proxy is already live.

Stored Recall and Rerank score tables were expanded successfully in the live Site.
The original cloud web reached its normal Cloudflare email-code sign-in screen;
an authenticated old-web UI regression was not established in this session.
This is not evidence of a web regression, and no login email was sent.

No production feedback was sent. The single-write canary remains gated on a new
deployed #45 adapter and complete read success. No profile refresh, business
workflow dispatch, notification, database mutation or Access change was made.

## Cloud release and remaining gate

The repository currently has a secret-free Linux Worker build/smoke workflow but
no production release workflow. The production GitHub environment has business
secrets, but no Cloudflare deployment token/account configuration. Existing local
Wrangler OAuth can inspect deployment metadata; it is not a configured GitHub
cloud release flow. No workstation production fallback is introduced.

Before deployment: configure a cloud release with Worker deployment authority,
preserve current bindings/settings/Cron, add the exact scoped Access authorization,
and set SITE_API audience/client without changing the old owner/read grants.
Stamp the actual release source SHA/time. Retain the previous version for rollback.

Then publish the exact reviewed Site source privately. Verify all six requested
read areas, owner/anonymous boundaries, denied readiness, desktop/mobile, and
original web/API compatibility. Only then submit one Save through the Site UI,
record the returned feedback log ID and confirm it in both Site and original API.
Never retry an uncertain response; inspect history first. Record before/after
profile and daily state; do not refresh, dispatch or notify. Use existing feedback
semantics for any required state reversal, never direct SQL.

Current replacement verdict: B. The existing Site is usable for observation; the
old web must retain feedback/corrections and other operational interactions until
the #45 production gate passes. #45's architecture remains viable but cannot be
marked Ready based on the already-passed runtime gate alone.

Login: the capability gate demonstrated normal owner login. The observed OpenAI
login security challenge occurred before application callback; it is external
authentication behavior. A historic unrepeatable challenge is not a proven code
bug, and no authentication boundary was relaxed to accommodate it.

## Validation

- Site build/syntax and 21 tests passed, including actual-value leak detection,
  denied readiness, owner/CSRF boundaries and single-attempt writes.
- Focused aggregation/route/auth tests: 63 passed, including real repository
  adapters against a strict read-only fixture that rejects mutation methods.
  Review additionally locked down localhost authentication and simultaneous
  legacy/new grants; the final complete regression includes those cases.
- Full application/Worker typecheck passed. Root regression: 26 Node tests and
  478 Vitest tests passed; 15 PostgreSQL tests skipped without a disposable test URL.
  Existing SQLite fixture tests are isolated tests, not a production fallback.
- Production dependency remediation is isolated in a separate security maintenance
  [PR #46](https://github.com/linyuan701/daily-paper/pull/46). #45 does not change
  dependency versions, lockfile or vulnerability baseline.

These tests use disposable fixtures; they are not production persistence evidence.

Independent integration review found no remaining actionable code/security issue
after preserving dashboard authentication on loopback and adding simultaneous
grant isolation coverage. Production readiness remains blocked as described above.

## Files changed in this integration pass

- Backend: `src/app/api/site/dashboard/{route.ts,route.test.ts}`;
  `src/modules/site-dashboard/{factory.ts,service.ts,service.test.ts,persisted-feedback-evidence.ts,persisted-feedback-evidence.test.ts}`;
  `src/db/repositories/profile-snapshot-repository.ts`;
  `src/lib/http/{cloudflare-access.ts,site-api-scope.ts,site-api-scope.test.ts}`; `.env.example`.
- Site: `sites/chatgpt/{README.md,package.json,public/app.js,src/proxy.mjs}`;
  `sites/chatgpt/scripts/{build.mjs,package.mjs,verify-package.mjs}`;
  `sites/chatgpt/tests/{artifact.test.mjs,proxy.test.mjs}`.
- Documentation: this file, `site-dashboard-api.md`, `site-integration-audit.md`,
  and `site-integration-validation.md` under `docs/`.

No root package/lockfile, schema/migration, ranking/profile calculation, ingestion,
scheduler, notification or daily workflow file changed in this pass.
