# Daily Paper ChatGPT Site

Development prototype based on GitHub `origin/master@d8552a0468a5970ee530195726f6c96e04b286b3`.
This directory is the authoritative Site source proposed for integration into the
Daily Paper GitHub repository. A future Sites source repository is a publication
mirror of an exact reviewed GitHub revision, never a second business backend.

**Status: implemented and fixture-verified, not deployed and not production-verified.**
The existing owner-private Site was inspected but not overwritten. No production
feedback, Cloudflare policy, database, schedule, notification or secret was changed.

## Architecture

```text
ChatGPT sign-in + existing owner-private Site policy
  → browser (HTML/CSS/ES modules; no tokens)
  → Sites Worker BFF (owner authorization, CSRF, fixed route allowlist)
  → HTTPS + Cloudflare Access service credentials
  → existing Daily Paper Worker / API / service layer
  → existing PostgreSQL

GitHub Actions → ingestion / profile refresh / recall / rerank / notification
```

There are no database, Zotero, filesystem, scheduler or provider dependencies in
the hosted Worker. No D1/R2 binding is declared. The build emits a single
Cloudflare-compatible ESM Worker at `dist/server/index.js` with a default fetch
handler. Only the build and isolated tests use Node. Test fixtures are not bundled.

## Pages and API use

| Page | Function | Existing backend API |
|---|---|---|
| `/` | Latest feed, latest run, source status, profile overview | recommendations/daily, operations/runs, profile/snapshot |
| `/papers[?runId=…]` | Top 20 in stored order; latest-action feedback hydration | recommendations/daily, feedback/logs |
| `/paper?runId=…&id=…` | Original/Chinese abstract, reasons, Recall/Rerank evidence, corrections | ranking/recall, ranking/rerank, feedback/actions, candidates/content |
| `/profile` | Active snapshot, positive labels, negative signals, consumption evidence, refresh status | profile/snapshot, profile/refresh |
| `/operations` | Recent runs/stages/source degradation, Site API status, Worker build identity | operations/runs, site/capabilities |
| `/history[?runId=…]` | Recent run navigation and feedback logs | operations/runs, recommendations/daily, feedback/logs |

Paths above are relative to `/api/`. The BFF route map lives in `src/proxy.mjs`.
The browser never chooses an upstream host, path or credential. GitHub daily run
metadata is read separately over `api.github.com`; its SHA is not a Worker SHA and
is not claimed to match a persisted DB run.

Save/Dismiss/Promote use the existing latest-triage-action semantics. Dismissed
entries disappear from the feed but remain reachable through feedback history.
The Site does not add independent saved/promoted booleans from unmerged PR #22.
Writes are never automatically retried. An uncertain write instructs the user to
inspect history. Label corrections send only changed label subobjects; drafts
are retained until a matching readback and retained if edited during an in-flight
save. Recall/Rerank evidence is displayed only when stored run IDs match the feed.

## Additive backend contracts

- `DailyRecommendationRecord.abstractNote`: existing stored abstract, optional.
- `ProfileSnapshotSummary.positiveLabels`: up to 24 unique labels drawn from the
  100 highest-weight persisted item signals, not a new interest/ranking model.
- `ProfileSnapshotSummary.feedbackIntegration`: whitelisted persisted consumption
  counters and negative signal evidence. Absent evidence means unknown, not zero.
- `GET /api/site/capabilities`: contract version, supported feedback actions,
  refresh-execution=false and optional injected Worker build SHA/time.
- `GET /api/site/dashboard`: compatibility aggregation for the existing live
  read-only Site. DTO v1 is documented in `docs/site-dashboard-api.md`. It reads
  persisted results and validates their linkage; it never recalculates scores.
- Optional scoped machine authorization in `verifyCloudflareAccess`. It grants
  exactly the Site read routes, POST feedback and PUT content; never job dispatch,
  POST refresh, reranking, ingestion or collection/journal administration.

No schema, migration, ranking weights, profile/negative-feedback algorithm,
scheduler, notification or ingestion changes are included.

## Authentication and secrets

Sites server configuration (never `NEXT_PUBLIC_*`, HTML, JS or hosting manifest):

`runtime-env.example` documents the server configuration names using placeholders.
Configure actual values through Sites; do not commit a filled-in copy.

| Name | Treatment |
|---|---|
| DAILY_PAPER_API_ORIGIN | Fixed HTTPS Worker origin; no path/query/userinfo |
| DAILY_PAPER_ACCESS_CLIENT_ID | Sites secret |
| DAILY_PAPER_ACCESS_CLIENT_SECRET | Sites secret |
| DAILY_PAPER_SITE_ALLOWED_EMAIL | Server-only exact owner authorization setting |
| DAILY_PAPER_GITHUB_REPOSITORY | Server configuration; owner/repo only |
| DAILY_PAPER_GITHUB_READ_TOKEN | Optional Sites secret, read-only Actions access |

The Site requires dispatch-supplied `oai-authenticated-user-id` and email, then
checks the configured owner. Production deployment must remain behind Sites
dispatch, which supplies authenticated identity headers; do not publish this
Worker directly on an unprotected workers.dev hostname. Keep owner-private access.

Daily Paper Worker configuration: `SITE_API_POLICY_AUD` and
`SITE_API_ACCESS_CLIENT_ID` opt in to the service grant. Leave unset to retain
owner-only behavior. Keep the existing `POLICY_AUD`, `TEAM_DOMAIN` and
`ACCESS_ALLOWED_EMAIL`. Preserve the owner policy in any path-specific Access
application; the scoped verifier also accepts the owner under that app audience.
All JWTs still require signature/issuer/audience verification. The service token
must match the exact signed `common_name` claim and have a future expiry. See
[Cloudflare application-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
and [service authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

The BFF enforces browser same-origin JSON before sending a server-origin request
to the backend. It never forwards browser cookies, authorization or Access JWTs.
It rejects redirects, bounds payloads, redacts upstream errors and uses no-store.
This does not require backend CORS relaxation.

`DAILY_PAPER_BUILD_SHA` / `DAILY_PAPER_BUILD_TIME` should be injected by the future
GitHub/cloud release process. They remain unknown until that process supplies
them; the Site never substitutes a source-code SHA for an observed deployment SHA.

## Checks and isolated development

From the repository root: `npm run test:site`. No install is needed for the Site's
dependency-free build, syntax checks and Node tests. Root `npm test` and
`npm run typecheck` cover the additive backend changes. The Site CI workflow is
credential-free and neither deploys nor triggers production jobs.

For engineering UI verification only, build and run
`node sites/chatgpt/tests/fixture-server.mjs`. It serves labelled synthetic data
on loopback and rejects outbound non-fixture requests. It is not a supported
production mode, deployment alternative, data source or user-facing deliverable.
Stop it after validation. Hosted operation never depends on this process.

## Cloud adoption gates

1. Review the backend and Site source proposal independently of PR #44. Keep #45
   Draft until production read/write validation is complete; do not merge first.
2. Release the reviewed backend through GitHub/cloud infrastructure. Master
   currently contains build/preview CI but no production Worker release workflow;
   do not replace that gap with a workstation deployment command.
3. Provision/configure scoped Access authorization while preserving the original
   owner web access. Set Site secrets and owner authorization through Sites.
   Existing Site secret names alone are not proof of compatible permissions.
4. The Sites runtime gate has passed on private version 4. Normal owner sign-in
   and server-only secrets work. OpenAI login challenges are external authentication
   behavior, not an established application callback bug. Use the same project ID.
5. Complete code, fixture, package and secret-scan checks, then publish the exact
   reviewed candidate privately through Sites. Sites deployment URLs are live
   publications, not isolated staging previews. Do not overwrite the current
   working publication with a disconnected prototype or widen its audience.
6. On that deployed candidate, verify real read contracts first, then exactly one
   approved feedback write through the Site UI and log readback through both Site
   and the original API. Verify desktop/mobile, original web and daily state.
   Neither the old v4 Site nor a direct API write substitutes for this gate.

Until these gates pass, this Site cannot replace the current cloud web.

## Official package contract

Configure the installed Sites execution profile in this directory first. Run
`npm run build` then `npm run verify:artifact`. The build emits
`dist/server/index.js`, `dist/client/` and `dist/.openai/hosting.json`.
Run `npm run package -- ABSOLUTE_SITES_PLUGIN_ROOT ABSOLUTE_SITE_PROJECT ABSOLUTE_ARCHIVE`.
The launcher invokes the installed official `scripts/package-site.mjs`; it only
adapts Windows Git Bash discovery and absolute drive paths. There is no alternate
hosting runtime. The package step also scans the artifact. Runtime secrets stay in
Sites; neither builds nor GitHub CI need actual Access secrets.

Publish a mirror of this exact GitHub source at the selected Site repository root,
push the source revision, save the matching archive/version, and deploy privately.
No one-shot gate route or canary secret is required by this production frontend.
The old `SITE_READ_*` Worker grant remains restricted to dashboard GET only;
`SITE_API_*` is a separate explicit opt-in. `/api/health/ready` remains outside both
Site service grants and is not requested by this frontend.

See `docs/site-production-integration.md` for the current evidence and blockers.
