import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflows = await Promise.all([
  "ci.yml",
  "cloudflare-preview.yml",
  "daily.yml",
  "deepseek-llm-smoke.yml",
  "nvidia-llm-smoke.yml",
  "profile.yml"
].map(async (name) => [
  name,
  await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
]));
const workflowByName = new Map(workflows);
const ci = workflowByName.get("ci.yml");
const preview = workflowByName.get("cloudflare-preview.yml");
const migrationCheck = await readFile(
  new URL("./ci-migration-check.mjs", import.meta.url),
  "utf8"
);

test("all workflows use current Node 24-based helper action majors", () => {
  for (const [name, workflow] of workflows) {
    assert.match(workflow, /actions\/checkout@v7/, `${name} must use checkout v7`);
    assert.match(workflow, /actions\/setup-node@v7/, `${name} must use setup-node v7`);
    assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|upload-artifact)@v[1-6]\b/);
    if (workflow.includes("actions/upload-artifact@")) {
      assert.match(workflow, /actions\/upload-artifact@v7/);
    }
  }
});

test("continuous integration is least-privileged and contains no secret context", () => {
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  const secretScan = ci.slice(ci.indexOf("  secret-scan:"), ci.indexOf("  quality:"));
  assert.match(secretScan, /permissions:\s*\n\s*contents: read\s*\n\s*pull-requests: read/);
  assert.doesNotMatch(secretScan, /pull-requests: write|actions: write|contents: write/);
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:/);
  assert.match(ci, /workflow_dispatch:/);
  assert.doesNotMatch(ci, /secrets\.|environment:\s*production|wrangler deploy|cf:deploy|WECOM|NOTIFICATION_SMTP|LLM_API_KEY/i);
  assert.doesNotMatch(ci, /job:daily|job:profile|wrangler deploy|cf:deploy/);
});

test("quality CI installs from the lockfile and covers config, tests, types, build, and database contracts", () => {
  const commands = [
    "node scripts/ci-clean-checkout.mjs",
    "npm ci",
    "node scripts/production-audit-check.mjs",
    "npm run test:config",
    "scripts/ci-workflow-contract.test.mjs",
    "npm run check:env",
    "npm run prisma:local:validate",
    "npm run prisma:cloud:validate",
    "npm run test:db-contract",
    "npm run typecheck",
    "npm test",
    "npm run build"
  ];
  let previous = -1;
  for (const command of commands) {
    const current = ci.indexOf(command);
    assert.ok(current > previous, `${command} must appear in workflow order`);
    previous = current;
  }
  assert.equal(ci.match(/node scripts\/ci-clean-checkout\.mjs/g)?.length, 3);
  assert.match(ci, /DEPLOYMENT_MODE: local[\s\S]*?DATABASE_URL: file:\.\/ci-validation\.db/);
  assert.match(ci, /DEPLOYMENT_MODE: cloud[\s\S]*?DATABASE_URL: postgresql:\/\/placeholder:placeholder@database\.invalid\/daily_paper/);
});

test("production audit runs after npm ci with the fixture-tested frozen baseline", () => {
  assert.ok(
    ci.indexOf("node scripts/production-audit-check.mjs") > ci.indexOf("npm ci"),
    "production audit must run after the locked install"
  );
  assert.match(ci, /scripts\/production-audit-check\.test\.mjs/);
  assert.doesNotMatch(ci, /npm audit[^\n]*(?:\|\||continue-on-error)/);
});

test("migration validation uses only an explicit ephemeral test database", () => {
  assert.match(ci, /image: postgres:17/);
  assert.match(ci, /POSTGRES_DB: daily_paper_ci/);
  assert.match(ci, /TEST_POSTGRES_DATABASE_URL: postgresql:\/\/ci_user:ci_password@127\.0\.0\.1:5432\/daily_paper_ci/);
  assert.match(ci, /node scripts\/ci-migration-check\.mjs/);
  assert.doesNotMatch(ci, /secrets\.DATABASE_URL|vars\.DATABASE_URL/);
  assert.match(migrationCheck, /environment\.TEST_POSTGRES_DATABASE_URL/);
  assert.match(migrationCheck, /DATABASE_URL: testDatabaseUrl/);
  assert.doesNotMatch(migrationCheck, /environment\.DATABASE_URL/);
});

test("Worker preview cannot inherit a database URL and verifies fail-closed access", () => {
  assert.match(preview, /on:\s*\n\s*pull_request:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(preview, /pull_request:[\s\S]*?paths(?:-ignore)?:/);
  assert.match(preview, /env -u DATABASE_URL npm run cf:build/);
  assert.match(preview, /env -u DATABASE_URL npx wrangler dev/);
  assert.doesNotMatch(preview, /secrets\.|ACCESS_JWT_LOCAL_PREVIEW_BYPASS/);
  assert.match(preview, /node scripts\/cloudflare-artifact-contract\.mjs/);
  assert.match(preview, /node scripts\/cloudflare-preview-smoke\.mjs/);
});
