import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  businessDateForActiveRun,
  findBlockingActiveRun,
  parseUtcBusinessDate,
  resolveBusinessDate,
  runDailyWorkflowGuard
} from "./daily-workflow-guard.mjs";
import { resolveScheduledBusinessDate } from "./daily-business-date.mjs";
import {
  buildDailyConcurrencyGroup,
  buildSkippedDailyNotification,
  decidePersistedDailyExecution
} from "./daily-workflow-state.mjs";

const workflow = readFileSync(new URL("../.github/workflows/daily.yml", import.meta.url), "utf8");
const notificationTestWorkflow = readFileSync(
  new URL("../.github/workflows/notification-test.yml", import.meta.url),
  "utf8"
);
const dailyCloudRunner = readFileSync(
  new URL("./run-daily-cloud.ts", import.meta.url),
  "utf8"
);
const dailyCli = readFileSync(
  new URL("../src/jobs/daily-cli.ts", import.meta.url),
  "utf8"
);
const dailyNotificationDelivery = readFileSync(
  new URL("../src/jobs/daily-notification-delivery.ts", import.meta.url),
  "utf8"
);
const persistedDailyGuard = readFileSync(
  new URL("./check-daily-workflow-state.ts", import.meta.url),
  "utf8"
);
const persistedDailyState = readFileSync(
  new URL("./daily-workflow-state.mjs", import.meta.url),
  "utf8"
);
const ingestionFoundation = readFileSync(
  new URL("../src/modules/ingestion/ingestion-foundation.service.ts", import.meta.url),
  "utf8"
);
const cloudflareDailyScheduler = readFileSync(
  new URL("../src/cloudflare/daily-scheduler.ts", import.meta.url),
  "utf8"
);

test("cloud daily workflow exposes the approved schedule and manual runDate", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron: ["']15 8 \* \* \*["']\s*\n\s*timezone: ["']Asia\/Shanghai["']/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*runDate:/);
  assert.match(workflow, /runDate:\s*\n\s*description: ["']UTC business date YYYY-MM-DD["']\s*\n\s*required: true\s*\n\s*type: string/);
  assert.match(workflow, /RUN_DATE: \$\{\{ needs\.preflight\.outputs\.run_date \}\}/);
  assert.doesNotMatch(workflow, /if \[\[ -n ["']?\$RUN_DATE/);
});

test("cloud daily workflow uses least privilege and bounded non-cancelling concurrency", () => {
  assert.match(workflow, /^permissions:\s*\n\s*contents: read\s*$/m);
  const preflightBlock = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  daily:"));
  assert.match(preflightBlock, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  const dailyBlock = workflow.slice(workflow.indexOf("  daily:"));
  assert.doesNotMatch(dailyBlock, /actions: read/);
  assert.match(workflow, /concurrency:[\s\S]*?group: daily-paper-cloud-\$\{\{ github\.repository \}\}-production-\$\{\{ needs\.preflight\.outputs\.run_date \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /queue: max/);
  assert.ok(
    workflow.indexOf("concurrency:") < workflow.indexOf("Deploy PostgreSQL migrations"),
    "the business-date concurrency gate must apply before migration"
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /timeout-minutes: 120/);
  assert.match(workflow, /node-version: 22/);
});

test("manual preflight is outside production and fails closed before the daily job", () => {
  const preflightIndex = workflow.indexOf("  preflight:");
  const dailyIndex = workflow.indexOf("  daily:");
  assert.ok(preflightIndex >= 0 && dailyIndex > preflightIndex);
  const preflightBlock = workflow.slice(preflightIndex, dailyIndex);
  assert.doesNotMatch(preflightBlock, /environment: production|DATABASE_URL|NOTIFICATION_SMTP/);
  assert.match(preflightBlock, /node scripts\/daily-workflow-guard\.mjs/);
  assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /if: needs\.preflight\.outputs\.should_run == ["']true["']/);
  assert.match(workflow, /run-name: Daily \$\{\{ github\.event_name == ["']workflow_dispatch["']/);
});

test("manual runDate validation is strict and never falls back", () => {
  assert.equal(parseUtcBusinessDate("2026-07-30"), "2026-07-30");
  for (const value of [undefined, "", "2026-7-30", " 2026-07-30", "2026-02-30", "2026-07-30T00:00:00Z"]) {
    assert.throws(() => parseUtcBusinessDate(value));
  }
  assert.equal(resolveBusinessDate({
    eventName: "schedule",
    ref: "refs/heads/master",
    now: new Date("2026-07-31T00:15:00.000Z")
  }), "2026-07-30");
  assert.throws(() => resolveBusinessDate({
    eventName: "workflow_dispatch",
    ref: "refs/heads/codex/v0.3-product-experience",
    manualRunDate: "2026-07-30"
  }), /master branch/);
});

test("manual preflight recognizes same-date scheduled and manual active runs", () => {
  const scheduled = {
    id: 100,
    event: "schedule",
    status: "queued",
    head_branch: "master",
    created_at: "2026-07-31T00:15:00.000Z",
    display_title: "Daily scheduled"
  };
  const manual = {
    id: 101,
    event: "workflow_dispatch",
    status: "in_progress",
    head_branch: "master",
    created_at: "2026-07-31T00:35:00.000Z",
    display_title: "Daily manual 2026-07-30"
  };
  assert.equal(businessDateForActiveRun(scheduled), "2026-07-30");
  assert.equal(businessDateForActiveRun(manual), "2026-07-30");
  assert.equal(findBlockingActiveRun({
    workflowRuns: [scheduled, manual],
    currentRunId: 999,
    businessDate: "2026-07-30"
  })?.id, 100);
  assert.equal(findBlockingActiveRun({
    workflowRuns: [{ ...scheduled, id: 999 }, { ...manual, status: "completed" }],
    currentRunId: 999,
    businessDate: "2026-07-30"
  }), undefined);
});

test("manual preflight returns a safe no-op when the Actions API reports an active same-date run", async () => {
  const fetchImpl = async (url) => {
    const status = new URL(url).searchParams.get("status");
    return new Response(JSON.stringify({
      workflow_runs: status === "queued"
        ? [{
            id: 100,
            event: "schedule",
            status: "queued",
            head_branch: "master",
            created_at: "2026-07-31T00:15:00.000Z",
            display_title: "Daily scheduled"
          }]
        : []
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.doesNotReject(async () => {
    const result = await runDailyWorkflowGuard({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/master",
      MANUAL_RUN_DATE: "2026-07-30",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "999",
      GH_TOKEN: "test-token",
      GITHUB_API_URL: "https://api.github.test"
    }, fetchImpl);
    assert.equal(result.shouldRun, false);
    assert.equal(result.blockingRun?.id, 100);
  });
});

test("Cloudflare dispatch first and a later native schedule share one gate; the follower safely skips", () => {
  const cloudflareScheduledTime = Date.parse("2026-07-31T00:15:00.000Z");
  const cloudflareDispatchDate = resolveScheduledBusinessDate(cloudflareScheduledTime);
  const delayedNativeScheduleDate = resolveBusinessDate({
    eventName: "schedule",
    ref: "refs/heads/master",
    now: new Date("2026-07-31T03:00:00.000Z")
  });
  const dispatchedDate = resolveBusinessDate({
    eventName: "workflow_dispatch",
    ref: "refs/heads/master",
    manualRunDate: cloudflareDispatchDate
  });
  const repository = "owner/repo";
  assert.equal(cloudflareDispatchDate, "2026-07-30");
  assert.equal(dispatchedDate, delayedNativeScheduleDate);
  assert.equal(
    buildDailyConcurrencyGroup({ repository, businessDate: cloudflareDispatchDate }),
    buildDailyConcurrencyGroup({ repository, businessDate: delayedNativeScheduleDate })
  );
  assert.match(cloudflareDailyScheduler, /actions\/workflows\/daily\.yml\/dispatches/);
  assert.match(cloudflareDailyScheduler, /ref:\s*["']master["']/);
  assert.match(cloudflareDailyScheduler, /inputs:\s*\{\s*runDate\s*\}/);
  assert.match(
    ingestionFoundation,
    /DEFAULT_SOURCES:\s*DailyCandidateSourceValue\[\]\s*=\s*\["biorxiv",\s*"arxiv",\s*"pubmed",\s*"journal"\]/
  );

  const cloudflareWinner = decidePersistedDailyExecution(null);
  const nativeScheduleFollower = decidePersistedDailyExecution({
    id: "run-2026-07-30",
    pipelineStatus: "COMPLETE",
    hasNotificationDeliveryStatus: true,
    notificationDeliveryStatus: "SENT"
  });
  assert.deepEqual(cloudflareWinner, {
    runMigration: true,
    runDailyJob: true,
    reason: "new_run"
  });
  assert.deepEqual(nativeScheduleFollower, {
    runMigration: false,
    runDailyJob: false,
    reason: "already_sent"
  });
  assert.equal([cloudflareWinner, nativeScheduleFollower].filter((run) => run.runMigration).length, 1);
  assert.equal([cloudflareWinner, nativeScheduleFollower].filter((run) => run.runDailyJob).length, 1);
  assert.match(workflow, /id: persisted[\s\S]*?job:daily:guard/);
  assert.match(workflow, /Deploy PostgreSQL migrations\s*\n\s*if: steps\.persisted\.outputs\.run_migration == ["']true["']/);
  assert.match(workflow, /Run daily pipeline\s*\n\s*if: steps\.persisted\.outputs\.run_daily_job == ["']true["']/);
});

test("pre-migration skips preserve v0.2.1 notification observability", () => {
  const sentRun = {
    id: "run-2026-07-30",
    pipelineStatus: "COMPLETE",
    hasNotificationDeliveryStatus: true,
    notificationDeliveryStatus: "SENT"
  };
  assert.deepEqual(buildSkippedDailyNotification({
    run: sentRun,
    businessDate: "2026-07-30",
    reason: "already_sent"
  }), {
    event: "daily_notification",
    runId: "run-2026-07-30",
    runStatus: "complete",
    deliveryStatus: "skipped",
    channel: "none",
    businessDate: "2026-07-30",
    reason: "already_sent",
    deduplicated: true
  });
  assert.deepEqual(decidePersistedDailyExecution({
    ...sentRun,
    notificationDeliveryStatus: "SENDING"
  }), {
    runMigration: false,
    runDailyJob: false,
    reason: "delivery_outcome_unknown"
  });
  assert.deepEqual(buildSkippedDailyNotification({
    run: { ...sentRun, notificationDeliveryStatus: "SENDING" },
    businessDate: "2026-07-30",
    reason: "delivery_outcome_unknown"
  }), {
    event: "daily_notification",
    runId: "run-2026-07-30",
    runStatus: "complete",
    deliveryStatus: "skipped",
    channel: "none",
    businessDate: "2026-07-30",
    reason: "delivery_outcome_unknown",
    deduplicated: true
  });
  assert.match(persistedDailyGuard, /console\.log\(JSON\.stringify\(notification\)\)/);
  assert.match(persistedDailyState, /event:\s*["']daily_notification["']/);
});

test("recoverable persisted runs reuse the business run without repeating migration", () => {
  assert.deepEqual(decidePersistedDailyExecution({
    id: "run-recoverable",
    pipelineStatus: "PARTIAL",
    hasNotificationDeliveryStatus: true,
    notificationDeliveryStatus: null
  }), {
    runMigration: false,
    runDailyJob: true,
    reason: "recoverable_run"
  });
  assert.deepEqual(decidePersistedDailyExecution({
    id: "legacy-run-recoverable",
    pipelineStatus: "PARTIAL",
    hasNotificationDeliveryStatus: false,
    notificationDeliveryStatus: null
  }), {
    runMigration: true,
    runDailyJob: true,
    reason: "legacy_requires_migration"
  });
  assert.doesNotMatch(persistedDailyGuard, /error\.message/);
  assert.match(persistedDailyGuard, /reason:\s*["']persisted_daily_guard_failed["']/);
});

test("cloud daily workflow fixes cloud capabilities and references secrets symbolically", () => {
  assert.match(workflow, /DEPLOYMENT_MODE: cloud/);
  assert.match(workflow, /ZOTERO_TRANSPORT: web/);
  assert.match(workflow, /OBSIDIAN_ENABLED: ["']false["']/);
  assert.match(workflow, /SCHEDULER_DESKTOP_NOTIFICATION_ENABLED: ["']false["']/);

  for (const name of ["DATABASE_URL", "ZOTERO_ID", "ZOTERO_KEY"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  for (const name of ["LLM_MODEL", "NOTIFICATION_DASHBOARD_URL"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ vars\\.${name} \\}\\}`));
  }
  assert.match(workflow, /LLM_PROVIDER: \$\{\{ vars\.LLM_PROVIDER \}\}/);
  assert.doesNotMatch(workflow, /^\s+LLM_API_KEY:/m);
  assert.match(workflow, /name: Select DeepSeek official LLM credential[\s\S]*?if: env\.LLM_PROVIDER == ['"]deepseek['"][\s\S]*?SELECTED_LLM_API_KEY: \$\{\{ secrets\.DEEPSEEK_API_KEY \}\}/);
  assert.match(workflow, /name: Select NVIDIA LLM credential[\s\S]*?if: env\.LLM_PROVIDER == ['"]nvidia['"][\s\S]*?SELECTED_LLM_API_KEY: \$\{\{ secrets\.NVIDIA_API_KEY \}\}/);
  assert.match(workflow, /name: Select legacy OpenAI-compatible LLM credential[\s\S]*?if: env\.LLM_PROVIDER == ['"]['"] \|\| env\.LLM_PROVIDER == ['"]openai-compatible['"][\s\S]*?SELECTED_LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/);
  assert.match(workflow, /printf ['"]%s=%s\\n['"] LLM_API_KEY ["']\$SELECTED_LLM_API_KEY["'] >> ["']\$GITHUB_ENV["']/);
  assert.doesNotMatch(workflow, /secrets\.NVIDIA_API_KEY\s*\|\|/);
  assert.doesNotMatch(workflow, /secrets\.DEEPSEEK_API_KEY\s*\|\|/);
  assert.match(workflow, /LLM_BASE_URL: \$\{\{ vars\.LLM_BASE_URL \|\| vars\.LLM_API_BASE_URL \}\}/);
  assert.doesNotMatch(workflow, /^\s+LLM_API_BASE_URL:/m);
  for (const name of [
    "WECOM_BOT_WEBHOOK_URL",
    "NOTIFICATION_SMTP_HOST",
    "NOTIFICATION_SMTP_PORT",
    "NOTIFICATION_SMTP_SECURE",
    "NOTIFICATION_SMTP_USER",
    "NOTIFICATION_SMTP_PASS",
    "NOTIFICATION_SMTP_FROM",
    "NOTIFICATION_SMTP_TO"
  ]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
});

test("cloud daily workflow migrates before invoking the existing CLI", () => {
  const commands = [
    "Select DeepSeek official LLM credential",
    "Select NVIDIA LLM credential",
    "Select legacy OpenAI-compatible LLM credential",
    "npm ci",
    "npm run check:env",
    "npm run prisma:cloud:validate",
    "npm run prisma:cloud:generate",
    "npm run job:daily:guard",
    "npm run prisma:cloud:migrate:deploy",
    "npm run job:daily:cloud"
  ];
  let previous = -1;
  for (const command of commands) {
    const current = workflow.indexOf(command);
    assert.ok(current > previous, `${command} must appear in workflow order`);
    previous = current;
  }
  assert.doesNotMatch(workflow, /migrate:deploy[\s\S]{0,200}(retry|while|until)/i);
  assert.match(workflow, /npm run job:daily:cloud -- --run-date ["']\$RUN_DATE["']/);
});

test("scheduled daily CLI emits a bounded structured daily_notification result", () => {
  assert.match(dailyCloudRunner, /writeNotificationResult:\s*\(result\)\s*=>\s*console\.log\(JSON\.stringify\(result\)\)/);
  assert.match(dailyCli, /event:\s*["']daily_notification["']/);
  assert.match(dailyCli, /deliveryStatus:\s*["']skipped["']/);
  assert.match(dailyCli, /reason:\s*pipeline\.disposition/);
  assert.match(dailyNotificationDelivery, /["']already_sent["']/);
  assert.match(dailyNotificationDelivery, /["']legacy_suppressed["']/);
  assert.match(dailyNotificationDelivery, /["']delivery_outcome_unknown["']/);
  assert.match(dailyNotificationDelivery, /deduplicated:\s*true/);
  assert.ok(
    dailyCloudRunner.indexOf("getDailyFeed") < dailyCloudRunner.indexOf("return deliverDailyNotificationOnce({"),
    "feed and message preparation must complete before claiming external notification delivery"
  );
  assert.doesNotMatch(dailyCloudRunner, /delivery\.attempts|error\.message|process\.env\.(?:DATABASE_URL|NOTIFICATION_SMTP_PASS)/);
});

test("cloud daily workflow contains no plaintext credentials or Worker trigger", () => {
  assert.doesNotMatch(workflow, /postgres(?:ql)?:\/\/[A-Za-z0-9]/i);
  assert.doesNotMatch(workflow, /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook/i);
  assert.doesNotMatch(workflow, /curl\s/i);
  assert.doesNotMatch(workflow, /cloudflare/i);
  assert.doesNotMatch(workflow, /\/api\/jobs\/daily/i);
});

test("SMTP notification test is manual, isolated, and least privilege", () => {
  assert.match(notificationTestWorkflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(notificationTestWorkflow, /schedule:|pull_request:|push:/);
  assert.match(notificationTestWorkflow, /permissions:\s*\n\s*contents: read/);
  assert.match(notificationTestWorkflow, /environment: production/);
  assert.match(notificationTestWorkflow, /timeout-minutes: 10/);
  assert.match(notificationTestWorkflow, /persist-credentials: false/);
  assert.match(notificationTestWorkflow, /Daily Paper notification test/);
  assert.match(notificationTestWorkflow, /sendDailyNotification/);
});

test("SMTP notification test references only notification configuration symbolically", () => {
  for (const name of [
    "NOTIFICATION_SMTP_HOST",
    "NOTIFICATION_SMTP_PORT",
    "NOTIFICATION_SMTP_SECURE",
    "NOTIFICATION_SMTP_USER",
    "NOTIFICATION_SMTP_PASS",
    "NOTIFICATION_SMTP_FROM",
    "NOTIFICATION_SMTP_TO"
  ]) {
    assert.match(notificationTestWorkflow, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  assert.match(
    notificationTestWorkflow,
    /\$\{\{ vars\.NOTIFICATION_DASHBOARD_URL \}\}/
  );
  assert.doesNotMatch(notificationTestWorkflow, /WECOM_BOT_WEBHOOK_URL/);
});

test("SMTP notification test cannot run or mutate the persisted pipeline", () => {
  for (const forbidden of [
    "DATABASE_URL",
    "prisma",
    "job:daily",
    "run-daily-cloud",
    "createDailyRecommendationService",
    "/api/jobs/daily",
    "ingestion",
    "normalization",
    "rerank",
    "summary"
  ]) {
    assert.doesNotMatch(notificationTestWorkflow, new RegExp(forbidden, "i"));
  }
});

test("SMTP notification test emits only bounded delivery status and redacted error categories", () => {
  assert.match(notificationTestWorkflow, /delivery\.channel === ["']email["']/);
  assert.match(notificationTestWorkflow, /configuration_incomplete/);
  assert.match(notificationTestWorkflow, /smtp_delivery_failed/);
  assert.match(notificationTestWorkflow, /notification_test_internal/);
  assert.doesNotMatch(notificationTestWorkflow, /delivery\.attempts|error\.message|console\.(?:log|error)\([^\n]*process\.env/);
});
