import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const monitorPath = new URL("../.github/workflows/daily-production-monitor.yml", import.meta.url);
const dailyPath = new URL("../.github/workflows/daily.yml", import.meta.url);
const monitorText = readFileSync(monitorPath, "utf8");
const dailyText = readFileSync(dailyPath, "utf8");
const monitorScript = readFileSync(
  new URL("./daily-production-monitor.mjs", import.meta.url),
  "utf8"
);
const evidenceScript = readFileSync(
  new URL("./daily-production-evidence.mjs", import.meta.url),
  "utf8"
);
const monitor = YAML.parse(monitorText);
const daily = YAML.parse(dailyText);

test("parses the monitor workflow and exposes the two approved Shanghai schedules", () => {
  assert.ok(monitor && typeof monitor === "object");
  assert.ok(monitor.on.workflow_dispatch);
  assert.deepEqual(monitor.on.schedule, [
    { cron: "17 10 * * *", timezone: "Asia/Shanghai" },
    { cron: "17 12 * * *", timezone: "Asia/Shanghai" }
  ]);
  assert.equal(monitor.on.workflow_dispatch.inputs.dryRun.default, true);
  assert.deepEqual(monitor.on.workflow_dispatch.inputs.phase.options, ["first", "final"]);
});

test("uses only the approved permissions and serial issue concurrency", () => {
  assert.deepEqual(monitor.permissions, {
    contents: "read",
    actions: "read",
    issues: "write"
  });
  assert.deepEqual(monitor.concurrency, {
    group: "daily-production-monitor",
    "cancel-in-progress": false
  });
  for (const permission of ["deployments", "id-token", "packages"]) {
    assert.equal(monitor.permissions[permission], undefined);
  }
});

test("runs only the read-only monitor and injects no production credentials", () => {
  const job = monitor.jobs.monitor;
  assert.equal(job.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(job.steps.at(-1).run, "node scripts/daily-production-monitor.mjs");
  assert.equal(job.steps[0].with["persist-credentials"], false);

  for (const forbidden of [
    "DATABASE_URL",
    "SMTP_PASS",
    "ZOTERO_KEY",
    "LLM_API_KEY",
    "ACCESS_CLIENT_SECRET",
    "workflow_dispatch daily.yml",
    "gh run rerun",
    "/api/operations/retry",
    "sendDailyNotification",
    "nodemailer",
    "prisma"
  ]) {
    assert.doesNotMatch(monitorText, new RegExp(forbidden, "i"));
  }
  assert.doesNotMatch(job.steps.at(-1).run, /\$\{\{/);
  assert.doesNotMatch(monitorScript, /gh["']?,?\s*\[[\s\S]*?run["']?,\s*["']view|--log/);
});

test("daily producer uploads only the versioned redacted result artifact", () => {
  const dailyJob = daily.jobs.daily;
  assert.equal(
    dailyJob.env.DAILY_PRODUCTION_RESULT_PATH,
    "artifacts/daily-production-result-v1.json"
  );
  const upload = dailyJob.steps.find((step) => step.name === "Upload redacted production result");
  assert.equal(upload.if, "always()");
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(upload.with.name, "daily-production-result-v1-${{ github.run_attempt }}");
  assert.equal(upload.with.path, "artifacts/daily-production-result-v1.json");
  assert.equal(upload.with["retention-days"], 14);
  const persisted = dailyJob.steps.find(
    (step) => step.name === "Check persisted business run before migration"
  );
  const pipeline = dailyJob.steps.find((step) => step.name === "Run daily pipeline");
  for (const step of [persisted, pipeline]) {
    assert.match(step.run, /set -o pipefail/);
    assert.match(step.run, /node scripts\/daily-production-evidence\.mjs/);
    assert.match(step.run, /--business-date "\$RUN_DATE"/);
  }
  assert.doesNotMatch(evidenceScript, /DATABASE_URL|SMTP_PASS|ZOTERO_KEY|LLM_API_KEY/);
  assert.doesNotMatch(evidenceScript, /sendDailyNotification|nodemailer|prisma/);
});
