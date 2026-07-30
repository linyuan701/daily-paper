import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildIssueBody,
  buildStepSummary,
  evaluateProductionState,
  parseProductionResultArtifact,
  parseStructuredLogLine,
  reconcileAlertIssue,
  resolveExpectedSchedule,
  runLiveMonitor
} from "./daily-production-monitor.mjs";

const fixtures = new URL("./fixtures/daily-production-monitor/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"));
}

function healthyInput() {
  return structuredClone(fixture("healthy"));
}

function notificationRecord(input) {
  return input.evidenceByRun["1001"][0].records[1];
}

function pipelineRecord(input) {
  return input.evidenceByRun["1001"][0].records[0];
}

test("computes the due Shanghai trigger and previous business date with the 08:15 cutoff", () => {
  assert.deepEqual(resolveExpectedSchedule("2026-07-31T00:14:59.999Z"), {
    triggerDate: "2026-07-30",
    businessDate: "2026-07-29"
  });
  assert.deepEqual(resolveExpectedSchedule("2026-07-31T00:15:00.000Z"), {
    triggerDate: "2026-07-31",
    businessDate: "2026-07-30"
  });
  assert.equal(resolveExpectedSchedule("2024-03-01T02:17:00.000Z").businessDate, "2024-02-29");
});

test("finds a successful scheduled run for the expected business date", () => {
  const result = evaluateProductionState(healthyInput());
  assert.equal(result.overall, "healthy");
  assert.equal(result.actionsRun.id, 1001);
  assert.equal(result.pipeline.runId, "run-2026-07-30");
});

test("orchestrates the exact daily workflow through a mocked GitHub API", async () => {
  const input = healthyInput();
  const github = {
    repository: "example/daily-paper",
    serverUrl: "https://github.com",
    token: "fixture-token",
    writes: [],
    async getRepository() {
      return { default_branch: "master" };
    },
    async getDailyWorkflow() {
      return { path: ".github/workflows/daily.yml" };
    },
    async listDailyRuns() {
      return [{
        id: 1001,
        event: "schedule",
        status: "completed",
        conclusion: "success",
        created_at: "2026-07-31T00:20:00.000Z",
        run_started_at: "2026-07-31T00:21:00.000Z",
        updated_at: "2026-07-31T01:05:00.000Z",
        run_attempt: 1,
        head_branch: "master"
      }];
    },
    async listIssues() {
      return [];
    }
  };
  const outcome = await runLiveMonitor({
    github,
    now: input.now,
    phase: "final",
    dryRun: true,
    evidenceLoader: async () => input.evidenceByRun["1001"]
  });
  assert.equal(outcome.result.overall, "healthy");
  assert.equal(outcome.result.actionsRun.event, "schedule");
  assert.equal(outcome.issueResult.action, "none");
  assert.deepEqual(github.writes, []);
});

test("reports no run as pending during the first check", () => {
  const result = evaluateProductionState(fixture("no-run"));
  assert.equal(result.overall, "pending");
  assert.equal(result.reason, "scheduled_run_not_started");
});

test("keeps a delayed run pending inside the first-check runtime window", () => {
  const result = evaluateProductionState(fixture("pending"));
  assert.equal(result.overall, "pending");
  assert.equal(result.reason, "run_in_progress");
});

test("marks a failed Actions run unhealthy", () => {
  const result = evaluateProductionState(fixture("failed"));
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "actions_conclusion_failed");
});

test("accepts complete_with_warnings as a successful terminal state", () => {
  const input = healthyInput();
  pipelineRecord(input).status = "complete_with_warnings";
  notificationRecord(input).runStatus = "complete_with_warnings";
  assert.equal(evaluateProductionState(input).overall, "healthy");
});

test("accepts a sent SMTP notification with a passing dashboard contract", () => {
  const result = evaluateProductionState(healthyInput());
  assert.equal(result.notification.deliveryStatus, "sent");
  assert.equal(result.notification.channel, "email");
  assert.equal(result.providerAccepted, true);
  assert.equal(result.inboxConfirmation, "user_confirmation_required");
});

test("marks a skipped notification unhealthy", () => {
  const input = healthyInput();
  Object.assign(notificationRecord(input), {
    deliveryStatus: "skipped",
    channel: "none",
    reason: "configuration_incomplete"
  });
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "notification_not_sent");
});

test("marks a failed notification unhealthy without provider error text", () => {
  const input = healthyInput();
  Object.assign(notificationRecord(input), {
    deliveryStatus: "failed",
    channel: "none",
    errorCategory: "delivery_failed"
  });
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "notification_failed");
});

test("detects more than one sent result for the same pipeline runId", () => {
  const input = healthyInput();
  input.evidenceByRun["1001"].push({
    attempt: 2,
    source: "artifact",
    records: [{ ...notificationRecord(input), attempt: 2 }]
  });
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "duplicate_notification");
  assert.equal(result.duplicateCount, 1);
});

test("accepts an already_succeeded recovery only when it skips a previously sent runId", () => {
  const input = healthyInput();
  input.runs.push({
    id: 1004,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-07-31T03:00:00.000Z",
    startedAt: "2026-07-31T03:00:00.000Z",
    completedAt: "2026-07-31T03:02:00.000Z",
    githubAttempt: 1,
    url: "https://github.com/example/daily-paper/actions/runs/1004"
  });
  input.evidenceByRun["1004"] = [{
    attempt: 1,
    source: "artifact",
    records: [
      {
        ...pipelineRecord(input),
        disposition: "already_succeeded"
      },
      {
        ...notificationRecord(input),
        deliveryStatus: "skipped",
        channel: "none",
        reason: "already_succeeded",
        deduplicated: true
      }
    ]
  }];
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "healthy");
  assert.equal(result.actionsRun.id, 1004);
  assert.equal(result.pipeline.disposition, "already_succeeded");
  assert.equal(result.duplicateCount, 0);
});

test("detects a pipeline businessDate mismatch", () => {
  const input = healthyInput();
  pipelineRecord(input).businessDate = "2026-07-29";
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "business_date_mismatch");
});

test("does not alert for first-check pending", async () => {
  const github = fakeGithub([]);
  const result = evaluateProductionState(fixture("pending"));
  const issue = await reconcileAlertIssue({ github, result, dryRun: false });
  assert.equal(issue.action, "none");
  assert.deepEqual(github.writes, []);
});

test("turns final-check pending into an unhealthy result", () => {
  const input = fixture("no-run");
  input.phase = "final";
  input.now = "2026-07-31T04:17:00.000Z";
  const result = evaluateProductionState(input);
  assert.equal(result.overall, "unhealthy");
  assert.equal(result.reason, "scheduled_run_missing_at_final_check");
});

test("updates the existing same-day issue instead of creating a duplicate", async () => {
  const result = evaluateProductionState(fixture("failed"));
  const existing = {
    number: 42,
    title: `Daily Paper production monitor: ${result.expectedBusinessDate}`,
    state: "open"
  };
  const github = fakeGithub([existing]);
  const issue = await reconcileAlertIssue({ github, result, dryRun: false });
  assert.equal(issue.action, "updated");
  assert.deepEqual(github.writes.map((entry) => entry.type), ["update"]);
  assert.equal(github.writes[0].number, 42);
});

test("adds a recovery comment and closes an existing alert", async () => {
  const result = evaluateProductionState(healthyInput());
  const existing = {
    number: 43,
    title: `Daily Paper production monitor: ${result.expectedBusinessDate}`,
    state: "open"
  };
  const github = fakeGithub([existing]);
  const issue = await reconcileAlertIssue({ github, result, dryRun: false });
  assert.equal(issue.action, "closed");
  assert.deepEqual(github.writes.map((entry) => entry.type), ["comment", "update"]);
  assert.equal(github.writes[1].input.state, "closed");
});

test("redacts unapproved provider fields from parsed logs, issues, and summaries", () => {
  const secret = "smtp-super-secret-value";
  const parsed = parseStructuredLogLine(
    `step 2026-07-31T01:00:00Z ${JSON.stringify({
      event: "daily_notification",
      runId: "run-1",
      businessDate: "2026-07-30",
      deliveryStatus: "failed",
      channel: "none",
      errorCategory: secret,
      providerError: secret,
      recommendationCount: 1,
      dashboardLinkIncluded: false
    })}`
  );
  assert.equal(parsed.errorCategory, "invalid");
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret));

  const result = evaluateProductionState(fixture("failed"));
  assert.doesNotMatch(buildIssueBody(result), new RegExp(secret));
  assert.doesNotMatch(buildStepSummary(result), new RegExp(secret));
});

test("strictly parses the versioned redacted artifact and legacy bounded log records", () => {
  const input = healthyInput();
  const [pipeline, notification] = input.evidenceByRun["1001"][0].records;
  const records = parseProductionResultArtifact(JSON.stringify({
    schemaVersion: 1,
    generatedAt: input.now,
    pipeline,
    notification
  }));
  assert.equal(records.length, 2);
  assert.equal(records[0].event, "daily_pipeline");
  assert.equal(records[1].contentContractPassed, true);

  const legacy = parseStructuredLogLine(
    'daily\tstep\t2026-07-31T01:00:00Z {"status":"complete","disposition":"executed","runId":"run-1","retryable":false}'
  );
  assert.equal(legacy.event, "daily_pipeline");
});

function fakeGithub(issues) {
  return {
    writes: [],
    async listIssues() {
      return issues;
    },
    async createIssue(input) {
      this.writes.push({ type: "create", input });
      return { number: 99, ...input, state: "open" };
    },
    async updateIssue(number, input) {
      this.writes.push({ type: "update", number, input });
      return { number, ...input };
    },
    async commentIssue(number, body) {
      this.writes.push({ type: "comment", number, body });
      return { id: 1 };
    }
  };
}
