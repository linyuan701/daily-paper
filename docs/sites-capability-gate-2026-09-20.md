# Sites capability gate — 2026-09-20

## Decision and boundaries

**A: the deployed private Site safely reads the live external Worker API.**
Retain the server-side-proxy architecture. This result proves the scoped read
path, not write permissions, long-term reliability, or production readiness of
PR #45. No business write canary was executed.

Authoritative integrated GitHub baseline remains
`d8552a0468a5970ee530195726f6c96e04b286b3`, fetched at the start of this task.
PR #45 remains OPEN / DRAFT at
`739b5e253723ab3742c6214d5e0a861f04e23719`, unchanged this round.
The independent implementation lives on `codex/sites-capability-gate`.

## Real deployment

- Private live Site: https://daily-paper-observatory.zzy19990821.chatgpt.site
- Diagnostic page: https://daily-paper-observatory.zzy19990821.chatgpt.site/capability-gate
- Native Sites deployment returned `succeeded` at `2026-09-20T10:10:49.230288Z`.
- Saved Site version: 4; runtime environment revision: 6.
- Published source mirror SHA: `43c51a8efe2bc4ed1908fd8f099b2c4922d269bd`.
- The existing owner-only access policy and original pages were preserved.
- This is a real owner-private live deployment, not a separate staging preview.
  The native `current_preview_url` was absent before deployment.

GitHub holds the authoritative three-file additive overlay. The existing Sites
source repository was cloned for publication and received only those three files.
No original Site source, dependency, lockfile, auth helper, or page was replaced.

## Observed cloud requests

The owner used normal ChatGPT sign-in, without a bypass token. At
`2026-09-20T10:11:33.742Z`, the deployed server rendered:

| Check | Actual result |
|---|---|
| Owner identity | Both dispatch ID and email present; exact server owner match |
| Access client ID and secret | Both present in server runtime |
| Independent canary secret | Runtime SHA-256 proof exactly matched a separately computed expected proof |
| Anonymous GET `/api/site/dashboard` | 302 to a Cloudflare Access login origin |
| Service-authenticated GET `/api/site/dashboard` | 200 JSON; `status=ok`, `schemaVersion=1`; about 6.6 seconds |
| Service-authenticated GET `/api/health/ready` | 302 to Cloudflare Access; outside existing service grant |
| Deployed `/api/capability-gate` | Worker logs independently confirmed HTTP 200 with normal ID-bearing browser identity |
| Anonymous Site diagnostic request | HTTP 401 sign-in page, no diagnostic/secret metadata |
| Anonymous request with fabricated identity headers | HTTP 401 sign-in page, no diagnostic/secret metadata |

After signing out and recovering the login challenge described below, a second
normal signed-in gate run at `2026-09-20T10:18:11.057Z` repeated the same results:
dashboard 302 without credentials, dashboard 200 with credentials (about 6.2
seconds), ready 302, and the identical independently verified canary proof.

The authenticated success and rejected anonymous control establish that the
existing service credential passes the permitted Access/Worker read path.
The ready endpoint denial is expected evidence of narrow authorization, not an
outbound-network failure. No Cloudflare Access application or policy was changed.
`/api/site/capabilities` from #45 is not required or assumed deployed.

The live dashboard endpoint is **not in origin/master**. Its contract and exact
service grant are present in the remote unmerged branch
`codex/site-read-worker-release@9f660d264d845d831993c4738c42ce6ff3f4928b`.
Runtime success proves deployment behavior; it does not prove the Worker runs
that exact SHA. The actual Worker deployment SHA remains unverified. This
integration/deployment discrepancy must be reconciled before expanding #45.

## Actual build and deploy contract

The installed official Sites 0.1.65 skill and scripts were restored and read.
Their required path was verified against the existing Site:

1. `configure-execution-profile.mjs` selects the ignored `portable` build profile.
2. `build-site.mjs` delegates to the existing package build script:
   `npm run build` -> `node scripts/run-framework.mjs build` -> Vinext/Vite.
3. Server output: `dist/server/index.js`, browser assets in `dist/client`, and
   `dist/.openai/hosting.json`; no database bindings or new migrations.
4. Push exact source to the Sites-returned source branch, then read full HEAD SHA.
5. `package-site.mjs` -> official `package-site.sh` ->
   `prepare-site-build.cjs` -> validated archive rooted at `dist/`.
6. Native `save_site_version` with the archive and exact source SHA, then
   `deploy_private_site_version`; terminal result was `succeeded`.

Two Windows build-tool issues were observed and kept separate from cloud runtime:
the official npm launcher resolved npm's CLI relative to the checkout and failed;
the equivalent existing PowerShell `npm run install:ci` / `npm run build` entries
succeeded. The packager needs Git Bash, and GNU tar misinterprets `C:/...` as a
remote target. The small packaging entry locates Git Bash only for its child
process and converts paths before invoking the unchanged official packager.
No local runtime is involved in deployed requests.

The uploaded gzip archive was 498,137 bytes, with SHA-256
`eb585258a34f695586693ee167e02f949ea41d2061de90da9fb74b684b971671`.
Sites accepted 77 build files and normalized archive storage to tar. Source files,
local environment files and node_modules were not included.

## Secrets and access

Existing Access/GitHub secret values were not read, copied, replaced or logged.
Only two server-side secrets were added through Sites configuration:
`DAILY_PAPER_SITE_ALLOWED_EMAIL` and an independent random
`SITES_CAPABILITY_GATE_CANARY`. Actual values are absent from GitHub, the source
mirror, this report and browser output. Only the canary's one-way proof and
presence booleans are returned. The gate never returns raw upstream data,
redirect URLs, identity values, cookies or credentials.

All 77 built files were scanned for the actual runtime canary value: absent.
All 17 browser assets were checked for transport headers, server canary code and
synthetic secrets: absent. Existing setup UI intentionally displays environment
variable names; names are not secret values. The actual Access secrets remain
masked by Sites and are only consumed at runtime by the server.

## Login investigation

Normal owner sign-in succeeded on the initial attempt in this task. The existing
dashboard displayed fresh live data, and the new gate later received both identity
headers and completed its authenticated outbound read.

A separate sign-out / sign-in replay reproduced an error **before the Site
callback**: `auth.openai.com/choose-an-account` displayed
`400 Invalid content type: text/html; charset=UTF-8`. Its own Try again button
then displayed Cloudflare security verification for **auth.openai.com**.
This is the OpenAI login/security layer, not the user's daily-paper Cloudflare
Access application. It is not evidence that the Site cannot issue outbound HTTPS.
The security check completed automatically. Selecting the same existing owner
account again then returned successfully to `/capability-gate`; no CAPTCHA was
solved by the agent, no bypass token was used, and no security setting changed.

The observations point to an HTML security challenge interrupting the login
service's expected response. Cloudflare documents that challenge responses are
HTML and can disrupt fetch/XHR expectations:
https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/
This causal link is an inference: response headers and internal AuthAPI logs for
the failed request are unavailable, so the exact WAF rule/trigger is unconfirmed.
The prior turn's historical callback failure cannot be conclusively reconstructed.
No callback URL, Site access policy, or authentication requirement was changed.

Separately, Sites automatic browser-rendering requests (marked `cf-brapi-devtools`)
were observed with email but no user ID. The unchanged application's helper
requires both and correctly returned 401. Normal browser requests had both and
returned 200. This explains those rendering 401s, not every historical login error.
Do not weaken owner authentication to make automated rendering appear successful.

## Tests, review and next boundary

- Four new gate tests passed: authentication/method/origin restrictions, precise
  credential injection, no credential forwarding/reflection, anonymous control,
  and network/HTML failures.
- Existing Site: 32 dashboard/contract tests and two build tests passed.
- TypeScript check and final production build passed.
- Official archive packaging, entrypoint validation and browser secret scan passed.
- Independent read-only integration review: no actionable findings remain.
- After the second normal sign-in, the original Site again loaded its live Top 20,
  active profile and source health, with no sign-in prompt or read-error banner.
- The independent branch's shared repository CI remains blocked by the existing
  production dependency audit (`@prisma/config`, `deepmerge-ts`, `nodemailer`,
  `prisma`), as shown in run 35504104213. No dependency or audit policy changed;
  this report does not claim the full repository CI is green.
- No root application logic changed; no new database, ranking, profile, scheduler,
  ingestion or notification tests were necessary. No production feedback, refresh,
  workflow dispatch or database write occurred.

Retain #45's architectural direction, but do not mark it Ready or merge. A later
phase must reconcile the already-deployed read adapter with GitHub master and
#45's proposed contracts before adding routes or attempting an explicitly scoped
read/write canary. The current service token's proven grant is the dashboard read
only. The gate does not authorize or demonstrate write access. Switching to
WebMCP / Site Tools is not required by an external-API runtime limitation observed
here; login platform reliability remains a separate operational limitation.
