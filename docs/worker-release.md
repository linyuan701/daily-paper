# GitHub-controlled Worker release and rollback

This is a release infrastructure change only. Worker application code, Site,
ranking, profiles, ingestion, PostgreSQL, Access policies, secrets and Cron are
outside this change. Production execution is cloud-only. Local commands below
invoke GitHub; they never build or deploy production from a workstation.

## Entry points

- [Controlled release](../.github/workflows/cloudflare-deploy.yml):
  manual dispatch on master, full source commit SHA already on master, expected
  current Cloudflare deployment UUID, and mode `dry-run` (default), `upload`, or
  `deploy`. Ordinary pushes cannot deploy.
- [Controlled rollback](../.github/workflows/cloudflare-rollback.yml):
  manual dispatch on master, existing version UUID, historical deployment UUID
  that served it at 100%, expected current deployment UUID, and `dry_run=true`
  by default. Rollback installs/builds/uploads nothing.
- [Existing Worker preview](../.github/workflows/cloudflare-preview.yml):
  remains PR/manual secret-free CI and is reused by controlled releases. There
  is no second application build implementation.

The workflows must be reviewed and merged before GitHub accepts their manual
dispatch. The existing production environment permits only the master branch;
this change does not edit environment protections. Both workflows share the
`daily-paper-worker-production` concurrency group with cancellation disabled.
The API state is re-read before changing traffic; a stale input aborts. Cloudflare
does not supply an atomic compare-and-swap deployment API, so an external operator
can still race that final read. Keep all production changes in these workflows.

## One-time GitHub configuration

Configure these in the **existing production environment**. Never put values in a
PR, command argument, workflow input, artifact, issue, log or this document.

| Kind | Name | Purpose |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Account/Worker-scoped Workers Scripts edit authority sufficient for existing versions, assets and deployments; no Access editing authority required |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the existing `daily-paper` Worker |
| Secret | `WORKER_ACCESS_CLIENT_ID` | Existing Access service credential already allowed for the selected critical read |
| Secret | `WORKER_ACCESS_CLIENT_SECRET` | Matching existing Access credential |
| Variable | `WORKER_BASE_URL` | Existing HTTPS `daily-paper.<subdomain>.workers.dev` origin |
| Variable | `WORKER_CRITICAL_API_PATH` | Exact `/api/recommendations/daily` or `/api/site/dashboard`; defaults to recommendations |

The current old Site credential is limited to `GET /api/site/dashboard`; select
that path if reusing it. A generic Access service token does not necessarily pass
the Worker's application-level authorization. No policy or API permission change
is performed by this release system. If the existing credential cannot complete
the selected read, the operation fails before upload/deployment. No Worker secret
values or database credentials are required in the release job.

PR #46's dependency security repair and PR #44's cloud-only support decision are
merged in master `fca4dc7a51d6d737869648bbf50180e5f396a802`. The release
workflow audits the selected source's own lockfile; a newer secure master does
not make an older source's dependencies safe. The audit gate is never bypassed.

### First production acceptance baseline

Do not deploy current master or the unmerged #45 just to exercise this workflow.
First confirm the existing production version, deployment, 100% traffic, exact
source/build provenance, and an existing scoped critical-read credential. Record
the pre-acceptance version/deployment as the rollback target before uploading.
After a controlled acceptance deployment, use the independent rollback workflow
to restore that version and verify traffic, liveness and the same critical read.

The current release contract accepts only commits already on master. The legacy
`9f660d2` annotation alone is insufficient to authorize or reproduce that build;
an off-master historical release needs separate verified provenance and an
explicitly reviewed source-policy change. Do not weaken ancestry or dependency
checks simply to make a legacy acceptance run pass. If the old baseline cannot
be established safely, leave production unchanged and report the evidence gap.

## Release sequence

1. Choose and review a full commit already integrated on master. Specify the
   current Cloudflare deployment ID from read-only inspection. Do not infer the
   current production source from master.
2. Dispatch `cloudflare-deploy.yml` with `mode=dry-run`. GitHub performs typecheck,
   fixture regression tests, OpenNext build, generated-artifact validation,
   Wrangler dry-run, final-bundle secret scan and Linux workerd smoke. Source/history
   secret scanning and the unchanged dependency audit gate run separately.
3. The build packages the exact final scanned bundle and assets, a constrained
   no-bundle upload configuration, and a SHA-256 file inventory. Workerd smoke
   executes this actual upload package. Production receives only that same-run
   artifact; it never runs candidate source/build hooks with credentials.
4. Dispatch `mode=upload` to validate credentials and current liveness/critical
   read, save the rollback anchor, and create a Cloudflare version without
   changing traffic. Wrangler's structured output supplies its actual version
   UUID. The controller suppresses raw Wrangler output and keeps vars/secrets.
5. Dispatch `mode=deploy` to repeat all build/security gates, create a version and
   switch 100% traffic. This creates a fresh version; it does not silently reuse
   the prior upload-only run. Bindings/runtime must match the saved baseline.
6. The deployment API is read back twice around liveness and authenticated
   critical-API probes. Version ID, deployment ID, 100% traffic, Cron and subdomain
   state must match. Only GET requests are made to application endpoints.
7. A failed switch/probe attempts recovery to the saved prior version, without
   rebuilding and without overriding a concurrent deployment. Recovery also
   verifies traffic and both reads. The run stays failed even when recovery
   succeeds. Never equate a failed run with an unchanged deployment: inspect the
   final `active` evidence and any recovery failure.

The generated upload configuration contains no triggers, routes, build command,
new bindings or secret values. Only the existing ASSETS binding is explicitly
uploaded. Vars and secrets inherit from Cloudflare; names/types and non-secret
values are compared in memory. Secret values cannot be read/compared by the API.
Cloudflare's secret-rollback protection is retained: no force override is used.
The release path refuses unsupported binding types and runtime compatibility
changes until they receive a separate infrastructure review.

## Rollback sequence

Start with `cloudflare-rollback.yml`, `dry_run=true`, and three explicit UUIDs:
target version, its known historical deployment, and current production
deployment. It checks authentication, history, bindings/runtime, current 100%
traffic and current health without a write.

After inspecting that evidence, repeat with `dry_run=false`. The controller
creates a deployment pointing 100% to the existing version. If current production
is already unhealthy, an explicit real rollback records that failure and proceeds;
the restored target must still pass post-rollback health and API checks. A dry-run
never claims that an inactive target was exercised against production.

If Cloudflare rejects the historical version because secrets changed, a resource
is unavailable, or the version is no longer deployable, stop. This workflow will
not rewrite secrets, force rollback, run a migration or recreate old resources.
A timeout/cancel can interrupt recovery; the independent rollback workflow is
the recovery path. Application data is never reversed by a Worker rollback.

Example inputs for GitHub's workflow UI:

```text
release:  commit_sha=<full reviewed master SHA>
          expected_deployment_id=<observed current UUID>
          mode=dry-run
rollback: version_id=<known old UUID>
          historical_deployment_id=<deployment that served old UUID>
          expected_deployment_id=<observed current UUID>
          dry_run=true
```

## Production source evidence

Each attempt retains a sanitized `evidence.json` Actions artifact for 90 days.
It contains the workflow/control SHA, source SHA when known, artifact digest,
actual Cloudflare version/deployment UUIDs, Cloudflare deployment timestamp,
traffic, before/after state, probe status/times and recovery evidence. No raw
provider response, private API body, bindings value, credential, environment dump
or Wrangler log is uploaded.

Successful verified deployments also create a durable **GitHub Deployments**
record in the production environment, with
`payload.kind=daily-paper-worker-release/v1`. Its payload stores the exact
Cloudflare deployment and source/workflow mapping. This is separate from the
automatic Actions environment deployment record, whose ref is the workflow
controller SHA and must not be presented as the production source SHA.

Future Site/operations consumers can read the live Cloudflare deployment, require
a single version at 100%, and join its deployment/version IDs to these marked
GitHub deployment records (and Actions evidence). This PR does not change either
consumer. A rollback resolves source SHA from previous marked workflow records
when available; a legacy version remains `source_commit_sha=null`. The record's
`ref` in that case is the controller ref, explicitly **not** a production SHA.
Lookup is bounded to the most recent 1,000 production records; older mappings
remain unknown unless explicitly retrieved and verified.

Three different assertions must stay separate:

| Evidence | What it proves |
|---|---|
| Cloudflare version/deployment IDs and percentages | Which version Cloudflare actually routes production traffic to |
| Version/deployment annotation | An operator/tool's text claim; stored in artifacts as safe SHA claims and message digests |
| GitHub workflow evidence and file digest | Which checked-out SHA this workflow built/uploaded and which Cloudflare IDs were returned |

Neither annotations nor workflow records are Cloudflare-provided cryptographic
source-SHA attestation. `source_sha_attestation=false` is explicit. Never backfill
an existing Cloudflare annotation to make a legacy build appear attested.

## References

- [Cloudflare versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)
- [Create deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
- [Cloudflare rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Audit and acceptance status](worker-release-audit-2026-09-20.md)
