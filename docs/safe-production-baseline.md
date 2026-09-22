# Safe production baseline: Site dashboard v1

Pre-merge audit, 2026-09-26: **IN DEVELOPMENT / NOT DEPLOYED**. This candidate restores the existing
read-only Site contract on current secure master. It does not integrate #45 or
authorize a production deployment. The supported runtime remains Workers plus
PostgreSQL/Neon and GitHub-hosted background jobs.

## Verified baseline and production evidence

- Rebased onto fetched master: `ae315b944fdefd08f1e73d7fa7bf8450bbbd942e`
  (includes merged #48). Original implementation base was
  `dc4b650027f8637407e09151c13494bf7e0490e8`. Rebase had no conflicts; #48's
  release controller, tests and runbook remain identical to current master.
- Re-fetched historical reference: `9f660d264d845d831993c4738c42ce6ff3f4928b`
  (`codex/site-read-worker-release`), not an ancestor of master.
- Cloudflare deployment and version reads on 2026-09-22 UTC confirmed version
  `a36410a9-ed06-461c-a882-e31c4cf9121b`, deployment
  `435c8f11-f0ca-4719-8fdb-79137d3f2c22`, 100% traffic. Version annotation is
  `9f660d2`, with an isolated-dependencies/NextServer-patch message. This is
  annotation plus repository evidence, not an attestation of old build bytes.
- Fresh GitHub [read-only rollback dry-run](https://github.com/linyuan701/daily-paper/actions/runs/35751615777)
  against that same version/deployment finished `read_only_verified`.
  Authenticated dashboard returned 200 with `schemaVersion=1`; liveness returned
  200. Before/after deployment and traffic were identical. No version was uploaded.
- The merged #48 controller's [production rollback dry-run](https://github.com/linyuan701/daily-paper/actions/runs/36226619007)
  on 2026-09-26 additionally verified the exact same production credential pair:
  dashboard 200 with numeric schemaVersion=1, daily recommendations 302 with
  `access_denied` / `cloudflare_access_login_redirect`, and liveness 200.
  Sanitized evidence reports `read_only_verified` with the same version,
  deployment and 100% traffic before and after. This PR preserves that probe.
- Anonymous live dashboard and daily-recommendations GETs returned 302 to Access;
  public liveness returned 200. No private response data or credentials are stored
  in this document or test fixtures.
- Runtime: compatibility date `2026-07-27`, `nodejs_compat`; Cron `15 0 * * *`.
  Bindings remain ASSETS; the three existing cloud-mode plain-text variables;
  and ACCESS_ALLOWED_EMAIL, DAILY_SCHEDULER_GITHUB_TOKEN, DATABASE_URL, POLICY_AUD,
  SITE_READ_ACCESS_CLIENT_ID, SITE_READ_POLICY_AUD, TEAM_DOMAIN secret bindings.
  No binding/configuration/policy is created or changed by this PR.

## Production source versus master: scope reconciliation

| Area | Audit result and candidate treatment |
| --- | --- |
| Dashboard endpoint and aggregation | Missing from master; restore the v1 read projection and bounded evidence parser. Projection matches the historical source, because its consumed read contracts are unchanged. |
| Profile repository | Master has newer triage-feedback support. Add only `getSnapshotForDashboard(id?)` with a narrow `findFirst/select`; retain every master getter, mapper and write method. No #45 positive-label or profile DTO additions. |
| Recall/rerank repositories | Master adds negative-feedback parsing and explicit profile selection for ranking execution. Dashboard uses only unchanged `getLatestRecallRun` / `getLatestRerankRun` result reads. Do not replace these repositories. |
| Operations, daily feed, feedback logs | Their dashboard-facing repository/service contracts are unchanged between the historical source and master; reuse current implementations directly. |
| Access | Restore only dedicated `SITE_READ_*` audience/client and exact GET path; keep owner authentication and reject any service `common_name` as an owner session. No `SITE_API_*` scope from #45. |
| Ranking/profile/ingestion algorithms | Historical source predates master changes. Keep master in full; this PR neither reverts nor imports algorithm changes. Background Actions already execute master. |
| Dependencies and release gates | Keep master's package manifests, lockfile, audit baseline and GitHub release/rollback workflows byte-for-byte. Never build from the old dependency tree. |
| Runtime boundary | Prisma schemas/migrations, Worker entrypoint, Cron/dispatch, bindings/runtime config and notification implementation are unchanged. |

The source comparison is intentionally not a claim that all master behavior is
identical to the old deployed Worker. It establishes that the missing Site reads
can be restored without importing the old business baseline or #45. The first
controlled deployment still needs its normal reviewed SHA, health probes and
rollback anchor. Canonical ledgers with earlier dates are historical evidence;
the fetched code and current deployment reads above govern this candidate.

## Formal API contract

`GET /api/site/dashboard` returns JSON with `status: "ok"`, `schemaVersion: 1`,
`observedAt`, `currentRun`, `recentRuns`, `profile`, `ranking`, `recommendations`,
`feedback`, and `limitations`.

- Reads latest 10 aggregated runs, the active profile, latest 100 global feedback
  logs, and the latest run's persisted recall/rerank/feed. A distinct ranking
  profile is fetched by exact snapshot ID, including superseded snapshots.
- Recommendations are at most 20 selected items ordered by stored rank. Every
  item includes candidateId/rank/finalScore/title/publishedAt/sources, identifiers
  (doi/pmid/arxivId/bioRxivId), topic/researchType, nullable summary/journal, stored
  recall/rerank reasons and score components. The service never runs scoring.
- `ranking` includes recall/rerank summaries, the ranking profile,
  `usesActiveProfile`, `recommendationLink` (`matched`/`unknown`), and
  `recommendationsUnavailableReason` (null, `no_run`,
  `run_not_finished_or_failed`, or `ranking_evidence_unconfirmed`).
- Recommendations require a terminal complete/complete_with_warnings/partial
  run, successful persisted recall/rerank stage IDs, matching run/profile IDs,
  generation times and selected candidates' rank/score. Missing/inconsistent
  evidence yields `recommendations: null`, never a previous successful feed.
- Profiles expose id/status/builtAt/sourceLibraryVersion/itemsCount, segment
  counts, research-type preferences and persisted feedback evidence. Missing
  legacy evidence is null; explicit zero/empty signals remain zero/empty.
  Dismiss evidence is limited to 50 valid stored references (feedback ID,
  candidate ID, effectiveAt). Private library text/representations are excluded.
- Feedback consumption markers are `true` only for a matching stored signal;
  absence is `null`, not proof of non-consumption. Logs expose only IDs, action,
  time and those markers; no old/new value or arbitrary metadata JSON.
- `observedAt` is read completion, `builtAt` is profile build time, and
  recommendation `generatedAt` means rerank start. Reads are not an atomic DB
  snapshot. SHA/GitHub run ID remain null and trigger remains unknown.
- Query parameters remain ignored, matching production v1: they cannot select
  history, widen the limits or change the read scope. #45's new query rejection
  policy is deliberately not imported.
- Route responses use `Cache-Control: private, no-store` and
  `Vary: Cf-Access-Jwt-Assertion`. Failed authentication returns 403; read failures
  return sanitized 500 / `SITE_DASHBOARD_READ_FAILED`. Non-GET methods, including
  HEAD/OPTIONS, return 405 with `Allow: GET` after any middleware rejection.

## Access contract

The existing owner audience and normalized owner email continue working. On
exactly dashboard GET, the dedicated SITE_READ audience also permits the owner
human JWT or a signed app JWT with the configured exact service `common_name`,
expiry and no nonempty email. Issuer, audience, RS256 signature and JWT temporal
checks still use JOSE and the team's JWKS. Both SITE_READ values must be set.

No client-ID/secret request headers are trusted by the Worker; Cloudflare Access
must validate them and issue its assertion. Any present `common_name` prevents
owner/admin authentication, even if the assertion also claims the owner email.
The Site grant never authorizes daily recommendations, profile APIs, readiness,
feedback, refresh, retry, sync, other paths or non-GET methods. Dashboard route
authentication also runs on loopback, without the existing preview bypass.

Production already has these two SITE_READ bindings and its path-specific Access
application. This PR requires no new secrets or Access configuration. The Site
Client Secret stays in the Site server and GitHub production secret store; it
is not introduced into the Worker or frontend.

## Validation and release qualification

Tests cover the unchanged v1 projection, incomplete/stale linkage, separate
profiles, missing legacy evidence, strict read-only repository integration,
client cleanup after settled reads, secret/error projection and real RS256
verification through middleware and route. The same signed fixture credential
that gets v1 is denied on `/api/recommendations/daily`; malformed service/owner
claims, issuer/audience/expiry, methods and path variants are denied.

The existing Linux workerd smoke additionally checks anonymous dashboard,
unsigned service headers and protected daily API rejection. Existing release
workflow validates the exact scanned package and verifies that smoke preserves
its immutable bytes. Full CI includes production audit, source/history secret
scan, application build/tests/typecheck and disposable PostgreSQL checks.

Final test counts, independent review, immutable candidate SHA and CI links are
recorded on the Draft PR. Production authenticated success above tests the old
live Worker; candidate success is fixture/CI evidence until a separately
authorized GitHub deployment. A green candidate is suitable for the first
controlled deploy/rollback acceptance target, not proof that exercise occurred.
