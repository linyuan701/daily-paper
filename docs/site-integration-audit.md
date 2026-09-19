# ChatGPT Site integration audit — 2026-09-19

## Authority and observed state

Fetched `origin` before inspection. The integrated baseline is
`d8552a0468a5970ee530195726f6c96e04b286b3` from
<https://github.com/linyuan701/daily-paper>. The original dirty checkout is an
experimental archive and was not modified. This implementation branch is
TRUSTED_DEVELOPMENT, not integrated or deployed backend code.

PR #44 changes cloud-only support documentation, not runtime behavior. PR #43
changes arXiv reliability. PRs #21/#22/#24/#25 are an unmerged dashboard/feedback
stack; independent save/promote state is NOT the current production contract.
PR #28 proposes monitoring. None are imported into this change.

The remote `codex/site-read-worker-release` branch has a separate read-only Site
adapter, but is not merged into master and has no open PR in the inspected list.
The existing owner-private Site has version 3 and server-side Access/GitHub secret
names configured. This is deployment metadata, not proof that its source is
integrated. Secret values are masked by Sites and were not read or copied.

Live evidence: Worker `/api/health/live` returned 200; anonymous
`/api/recommendations/daily` returned an Access login redirect. GitHub daily run
35421549513 ran the baseline SHA on 2026-09-19 for business date 2026-09-18,
completed with warnings, persisted 20 recommendations, and sent email. A green
Actions conclusion does not imply all sources were healthy.

## Existing web → API → service → Site

| Existing capability | Existing HTTPS API | Service / PostgreSQL | Site surface |
|---|---|---|---|
| Latest selected feed, source filters | GET /api/recommendations/daily?selectedOnly=true[&runId=…] | DailyRecommendationService, persisted rerank results | Dashboard, Today, History |
| Persisted recall explanation | GET /api/ranking/recall?runId=… | RecallRankingService | Paper detail |
| Persisted rerank explanation | GET /api/ranking/rerank?runId=… | RerankService | Paper detail |
| Save / Dismiss / Promote | POST /api/feedback/actions | FeedbackService, append-only logs | Paper actions |
| Feedback history | GET /api/feedback/logs?runId=…&limit=500 | FeedbackService | Triage hydration, History |
| Label / summary correction | PUT /api/candidates/content | CandidateOutputService + feedback logs | Paper correction form |
| Active profile | GET /api/profile/snapshot | ProfileBuildService, immutable snapshot | Profile |
| Refresh status | GET /api/profile/refresh | ProfileRefreshService | Profile, Dashboard |
| Recent runs, stages, source degradation | GET /api/operations/runs?limit=10 | OperationsService, persisted stages | Operations, History |
| DB availability | GET /api/health/ready | Worker readiness query | Connection status |

The current web also exposes collection priorities, journals and guarded workflow
retry. They remain in the original web; phase-one Site does not dispatch jobs or
alter collection/journal configuration. Cloud POST profile refresh is explicitly
unavailable; the Site must show status, not pretend to execute it.

## Gaps and minimal contracts

1. Master verifies an owner email JWT, whereas server-to-server Access service
   assertions identify a `common_name`. Add an opt-in, exact method/path service
   grant using a separate configured audience and client identity. Preserve owner
   authentication. No broad bearer-token bypass, admin routes, or scheduler grant.
2. Browser writes require same-origin JSON. Use a same-origin Site BFF with its
   own Origin and Fetch-Metadata checks, then an authenticated HTTPS server request
   with the backend Origin. Do not enable wildcard CORS or forward user headers.
3. The feed omits the stored original abstract. Add an optional `abstractNote`
   field; use existing recall/rerank GETs for full persisted scores and weights.
4. Profile summary discards persisted `feedbackIntegration`. Add a whitelisted,
   optional read projection (unknown when absent), plus persisted positive labels.
   Never infer consumption just because a log predates `builtAt`.
5. Operations has no deployment SHA. Add an authenticated read-only capabilities
   endpoint reporting an injected Worker build SHA/time or null. GitHub Actions
   run SHA is separately obtained through GitHub HTTPS and must never be presented
   as the Worker deployment SHA or matched to a DB run without evidence.
6. The master Cloudflare workflow builds/previews but does not release production.
   Backend adoption needs review/merge and a GitHub/cloud release path; this task
   must not deploy a patched Worker from the user's computer or merge PR #44.

## Recommended architecture and frozen scope

ChatGPT owner-private access → Site browser → Site Worker BFF → Cloudflare Access
service authentication → existing Daily Paper Worker APIs → existing services →
PostgreSQL. GitHub Actions retains all ingestion, profile computation, ranking,
scheduling and notification. Site has no database client or storage bindings.

Only the Site server receives Access client ID/secret and optional GitHub read
token through Sites runtime secrets. Upstream origin must be HTTPS, fixed in
server configuration, and never supplied by a browser. Redirects are rejected;
upstream HTML/auth failures are reported without reflecting their contents.

Primary owns all edits. Independent integration review is read-only. No schema,
migration, ranking weight, dismiss algorithm, profile build algorithm, pipeline,
notification, or production data change belongs in this implementation.

The private Site's existing access policy is preserved. A Sites deployment is a
live private publication, not a staging URL; do not call it an isolated preview.
Do not replace a working private publication with a disconnected prototype.

## Validation boundary

Fixture tests prove routing, CSRF, auth scope, projection and mutation round trips;
they do not prove production writes. Live reads and an explicitly selected real
feedback operation must be verified through the final cloud route before this
Site can replace the existing web. Missing credentials, unreleased contracts or
unavailable Sites build tooling remain explicit blockers, never local fallbacks.
