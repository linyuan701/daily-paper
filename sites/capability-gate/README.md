# Sites runtime capability gate

Independent gate against `origin/master@d8552a0468a5970ee530195726f6c96e04b286b3`.
It does not modify PR #45, application APIs, ranking, profile, scheduling, or data.
The `overlay/` files are the GitHub-authoritative additive patch for the existing
registered Site. Copy the three files to the corresponding paths in its source
checkout; retain its existing pages, dependencies, lockfile and hosting identity.
The Sites source repository is the publication mirror, not project master.

## Actual contract

The installed official Sites 0.1.65 skills specify:

1. Run `node <plugin-root>/scripts/configure-execution-profile.mjs` in the Site
   checkout. This environment selects `portable`; it does not select production.
2. `node <plugin-root>/scripts/build-site.mjs` delegates to the project's
   `package.json` build script. The existing Site uses `npm run build` ->
   `node scripts/run-framework.mjs build` -> Vinext's Worker build.
3. Output requires `dist/server/index.js`, client assets, and
   `dist/.openai/hosting.json`. No database binding or migration is added.
4. Commit/push the exact Site source to the credential-returned source branch;
   obtain its full SHA with `git rev-parse --verify HEAD` after the push completes.
5. `node <plugin-root>/scripts/package-site.mjs PROJECT ARCHIVE` invokes the
   official `package-site.sh` and `prepare-site-build.cjs`, stages only build
   output and creates a gzip tar archive rooted at `dist/`.
6. Native `save_site_version(project_id, commit_sha, archive)` then
   `deploy_private_site_version(project_id, version_id)`; await terminal status.
   This is a private live deployment, not an isolated staging URL.

`scripts/package.mjs` is a minimal entry for step 5. On Windows it locates Git's
bundled bash for that child process only and converts drive-letter paths to
`/c/...` paths so GNU tar does not interpret a drive colon as a remote host.
It does not replace the official packager or change machine configuration.
`scripts/verify-package.mjs` checks
the Worker/manifest and rejects secret/transport code markers in browser assets.

The official npm launcher currently fails on this Windows host by resolving
`node_modules/npm/bin/npm-cli.js` relative to the Site checkout. Directly invoking
the same existing `npm run install:ci` and `npm run build` entries works. This is
a build-tool finding, not a local production fallback. No local server is needed
to use the deployed Site.

## Read-only scope and secrets

The gate requires both dispatch-provided identity headers and an exact owner
email from server-only `DAILY_PAPER_SITE_ALLOWED_EMAIL`. Keep the Site owner-only.
Existing Access secrets stay in Sites. Add only an independent random secret
`SITES_CAPABILITY_GATE_CANARY`; its SHA-256 proof can be checked against a locally
computed expected proof without exposing the secret. Neither credentials nor
upstream payloads or redirect URLs are returned or logged by the gate.

The three fixed GET requests are anonymous `/api/site/dashboard`, authenticated
`/api/site/dashboard`, and authenticated `/api/health/ready`, all at the existing
Worker origin. The live Site already uses the first endpoint. It is present in
remote branch `codex/site-read-worker-release`, not integrated master. This gate
does not claim that a deployed endpoint is merged or that its deployment SHA is
known. A blocked ready endpoint can represent the deliberately narrow Access
scope; do not widen authorization to make the test pass.

The probe never follows redirects, forwards browser credentials, retries,
writes feedback, refreshes profiles, dispatches workflows, or opens a DB client.
An authenticated 200 matching the dashboard schema plus an Access-rejected
anonymous control establishes the read path; runtime secret proof must also be
checked by the operator before acceptance. It does not establish any write path.

## Verification

Run `node --test sites/capability-gate/tests/gate.check.mjs` in Daily Paper. In the
Site checkout run its existing tests/typecheck/build, then invoke the package
validator with the absolute Site checkout. Production evidence and final decision
are recorded separately in `docs/sites-capability-gate-2026-09-20.md`.
