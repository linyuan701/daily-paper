import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const deploy = await read(".github/workflows/cloudflare-deploy.yml");
const rollback = await read(".github/workflows/cloudflare-rollback.yml");
const build = await read(".github/workflows/cloudflare-preview.yml");
const controller = await read("scripts/worker-release.mjs");

test("release and rollback only run from explicit master dispatch with shared serialization", () => {
  for (const workflow of [deploy, rollback]) {
    assert.match(workflow, /on:\s*\n  workflow_dispatch:/);
    assert.doesNotMatch(workflow, /(?:^|\n)  (?:push|pull_request|schedule|workflow_run):/);
    assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
    assert.match(workflow, /group: daily-paper-worker-production\s+cancel-in-progress: false/);
    assert.match(workflow, /environment: production/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /if: always\(\)/);
    assert.match(workflow, /path: artifacts\/worker-release\/evidence\.json/);
    assert.doesNotMatch(workflow, /secrets\.(?:DATABASE_URL|ZOTERO|LLM|NOTIFICATION)/);
    assert.doesNotMatch(workflow, /job:daily|job:profile|migrate|cf:deploy|wrangler deploy\s*$/m);
  }
});

test("release requires full commit, ancestry, secret-free shared build and defaults to dry-run", () => {
  assert.match(deploy, /default: dry-run/);
  assert.match(deploy, /git merge-base --is-ancestor "\$SOURCE_SHA" origin\/master/);
  assert.match(deploy, /uses: \.\/\.github\/workflows\/cloudflare-preview\.yml/);
  assert.match(deploy, /needs: \[validate, build, security\]/);
  assert.match(deploy, /node scripts\/production-audit-check\.mjs/);
  assert.match(deploy, /gitleaks\/gitleaks-action@[a-f0-9]{40}/);
  assert.match(deploy, /if: inputs\.mode != 'dry-run'/);
  assert.match(deploy, /npm ci --ignore-scripts/);
  assert.doesNotMatch(deploy, /secrets: inherit/);
  assert.match(deploy, /name: worker-release-\$\{\{ inputs\.commit_sha \}\}/);
  assert.match(build, /workflow_call:/);
  assert.match(build, /npm run typecheck/);
  assert.match(build, /npm run cf:build/);
  assert.match(build, /npm run cf:secret-scan/);
  assert.match(build, /versions upload --dry-run/);
  assert.match(build, /cloudflare-preview-smoke\.mjs/);
  assert.match(build, /wrangler dev --local[^\n]+--config dist\/worker-release\/wrangler\.json/);
  assert.match(build, /--var DEPLOYMENT_MODE:cloud/);
  assert.match(build, /--persist-to "\$RUNNER_TEMP\/worker-smoke-state"/);
  assert.ok(build.indexOf("worker-release-artifact.mjs verify") > build.indexOf("cloudflare-preview-smoke.mjs"));
  assert.ok(build.indexOf("worker-release-artifact.mjs verify") < build.indexOf("Upload immutable release payload"));
  assert.match(build, /path: \.build-home\/release-tools/);
  assert.doesNotMatch(build, /secrets\./);
  assert.ok(build.indexOf("npm run cf:secret-scan") < build.indexOf("worker-release-artifact.mjs"));
  assert.ok(build.indexOf("cloudflare-preview-smoke.mjs") < build.indexOf("Upload immutable release payload"));
});

test("rollback requires version, historical and current deployment, no install/build/upload", () => {
  assert.match(rollback, /version_id:/);
  assert.match(rollback, /historical_deployment_id:/);
  assert.match(rollback, /expected_deployment_id:/);
  assert.match(rollback, /default: true/);
  assert.doesNotMatch(rollback, /run:.*(?:npm|npx|wrangler|build|upload)/);
});

test("both production workflows supply the same scoped Access pair to the shared health probe", () => {
  for (const workflow of [deploy, rollback]) {
    assert.match(workflow, /environment: production/);
    assert.match(workflow, /WORKER_ACCESS_CLIENT_ID: \$\{\{ secrets\.WORKER_ACCESS_CLIENT_ID \}\}/);
    assert.match(workflow, /WORKER_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.WORKER_ACCESS_CLIENT_SECRET \}\}/);
    assert.match(workflow, /WORKER_CRITICAL_API_PATH: \$\{\{ vars\.WORKER_CRITICAL_API_PATH \}\}/);
    assert.match(workflow, /run: node scripts\/worker-release\.mjs/);
    assert.doesNotMatch(workflow, /NEGATIVE_API.*(?:SECRET|TOKEN)|SKIP.*(?:PROBE|HEALTH)/);
  }
  assert.match(controller, /probe: healthProbe\(env\)/);
  assert.match(controller, /evidence\.postflight_checks = await probe\(\)/);
  assert.match(controller, /evidence\.recovery_checks = await probe\(\)/);
});

test("controller does not force rollback, change secrets/triggers, log raw output or call business jobs", () => {
  assert.doesNotMatch(controller, /force=true|secret put|secret bulk|triggers deploy|cf:deploy|prisma|workflow_dispatch.*fetch/);
  assert.match(controller, /"versions", "upload"/);
  assert.match(controller, /"--no-bundle", "--keep-vars"/);
  assert.match(controller, /WRANGLER_OUTPUT_FILE_PATH/);
  assert.doesNotMatch(controller, /console\.(?:log|error)\((?:result|payload|response|env)/);
  assert.match(controller, /source_sha_attestation: false/);
});
