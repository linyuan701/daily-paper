import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAILY_WORKFLOW_FILE = "daily.yml";
const DAILY_WORKFLOW_PATH = ".github/workflows/daily.yml";
const RESULT_ARTIFACT_PREFIX = "daily-production-result-v1";
const RESULT_ARTIFACT_FILE = "daily-production-result-v1.json";
const MAX_NORMAL_RUNTIME_MINUTES = 150;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const PIPELINE_STATUSES = new Set([
  "running",
  "complete",
  "complete_with_warnings",
  "partial",
  "failed"
]);
const DISPOSITIONS = new Set([
  "executed",
  "resumed",
  "already_succeeded",
  "already_running"
]);
const FAILED_STAGES = new Set([
  "ingestion",
  "enrichment",
  "normalization",
  "representation",
  "recall",
  "rerank",
  "summary"
]);
const DELIVERY_STATUSES = new Set(["sent", "skipped", "failed"]);
const CHANNELS = new Set(["email", "wecom", "none"]);
const ERROR_CATEGORIES = new Set(["delivery_failed", "notification_internal"]);
const NOTIFICATION_REASONS = new Set([
  "configuration_incomplete",
  "already_succeeded",
  "already_running",
  "missing_run_id"
]);

export function resolveExpectedSchedule(now) {
  const instant = asValidDate(now);
  const parts = shanghaiParts(instant);
  const beforeDailyTrigger = parts.hour < 8 || (parts.hour === 8 && parts.minute < 15);
  const triggerDate = shiftDateKey(parts.date, beforeDailyTrigger ? -1 : 0);
  return {
    triggerDate,
    businessDate: shiftDateKey(triggerDate, -1)
  };
}

export function expectedBusinessDate(now) {
  return resolveExpectedSchedule(now).businessDate;
}

export function parseStructuredLogLine(line) {
  if (typeof line !== "string" || line.length > 1_000_000) return null;
  const objectStart = line.indexOf("{");
  if (objectStart < 0) return null;
  try {
    return sanitizeEvidenceRecord(JSON.parse(line.slice(objectStart)));
  } catch {
    return null;
  }
}

export function parseProductionResultArtifact(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(value) || value.schemaVersion !== 1) return [];
  return [value.pipeline, value.notification]
    .map(sanitizeEvidenceRecord)
    .filter(Boolean);
}

export function evaluateProductionState({
  now,
  phase,
  runs,
  evidenceByRun = {},
  maxNormalRuntimeMinutes = MAX_NORMAL_RUNTIME_MINUTES
}) {
  const checkTime = asValidDate(now);
  const normalizedPhase = phase === "final" ? "final" : "first";
  const { triggerDate, businessDate } = resolveExpectedSchedule(checkTime);
  const scheduledRuns = runs.filter((run) => run.event === "schedule");
  const recoveryRuns = runs.filter((run) => {
    if (run.event !== "workflow_dispatch" || run.status !== "completed") return false;
    const pipeline = latestPipelineRecord(evidenceByRun[String(run.id)]);
    return Boolean(
      pipeline &&
      ["resumed", "already_succeeded"].includes(pipeline.disposition) &&
      pipeline.businessDate === businessDate
    );
  });
  const formalRuns = [...scheduledRuns, ...recoveryRuns]
    .filter((run, index, values) => values.findIndex((item) => item.id === run.id) === index)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  if (formalRuns.length === 0) {
    return resultForMissingRun({ checkTime, normalizedPhase, triggerDate, businessDate });
  }

  const selectedRun = formalRuns.at(-1);
  const base = buildBaseResult({ checkTime, triggerDate, businessDate, selectedRun });

  if (selectedRun.status !== "completed") {
    const ageMinutes = elapsedMinutes(
      selectedRun.startedAt ?? selectedRun.createdAt,
      checkTime.toISOString()
    );
    const normalFirstWindow = normalizedPhase === "first" && ageMinutes <= maxNormalRuntimeMinutes;
    if (normalFirstWindow) {
      return finishResult(base, {
        overall: "pending",
        reason: "run_in_progress",
        recommendedNextAction: "Wait for the existing daily Actions run; do not rerun it."
      });
    }
    return finishResult(base, {
      overall: "unhealthy",
      reason: normalizedPhase === "final" ? "final_run_pending" : "run_overdue",
      recommendedNextAction: "Inspect the existing Actions run; do not rerun it automatically."
    });
  }

  if (selectedRun.conclusion !== "success") {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "actions_conclusion_failed",
      recommendedNextAction: "Inspect the failed Actions run and authorize any recovery separately."
    });
  }

  const pipeline = latestPipelineRecord(evidenceByRun[String(selectedRun.id)]);
  if (!pipeline) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "application_result_unavailable",
      recommendedNextAction: "Inspect the redacted daily result artifact for the existing Actions run."
    });
  }

  base.pipeline = pipeline;
  if (pipeline.businessDate && pipeline.businessDate !== businessDate) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "business_date_mismatch",
      recommendedNextAction: "Verify the scheduled or recovery runDate before any authorized retry."
    });
  }
  if (!["complete", "complete_with_warnings"].includes(pipeline.status)) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "pipeline_terminal_failure",
      recommendedNextAction: "Inspect the reported failed stage before authorizing recovery."
    });
  }
  if (pipeline.retryable || pipeline.failedStage) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: pipeline.retryable ? "pipeline_retryable" : "pipeline_failed_stage",
      recommendedNextAction: "Inspect the reported failed stage before authorizing recovery."
    });
  }
  if (!pipeline.runId || !pipeline.businessDate || !pipeline.attempt) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "pipeline_contract_invalid",
      recommendedNextAction: "Inspect the redacted daily result artifact for missing identity fields."
    });
  }

  const allNotifications = formalRuns.flatMap((run) =>
    allRecords(evidenceByRun[String(run.id)]).filter((record) => record.event === "daily_notification")
  );
  const runNotifications = allNotifications.filter((record) => record.runId === pipeline.runId);
  const sentNotifications = runNotifications.filter((record) => record.deliveryStatus === "sent");
  base.duplicateCount = Math.max(0, sentNotifications.length - 1);

  if (sentNotifications.length > 1) {
    base.notification = sentNotifications.at(-1);
    return finishResult(base, {
      overall: "unhealthy",
      reason: "duplicate_notification",
      recommendedNextAction: "Stop retries and inspect notification idempotency for this pipeline runId."
    });
  }

  const notification = sentNotifications[0] ?? runNotifications.at(-1) ?? null;
  base.notification = notification;
  if (!notification || notification.deliveryStatus !== "sent") {
    return finishResult(base, {
      overall: "unhealthy",
      reason: notification?.deliveryStatus === "failed" ? "notification_failed" : "notification_not_sent",
      recommendedNextAction: "Inspect SMTP configuration and provider status without sending a test email."
    });
  }
  if (notification.runId !== pipeline.runId || notification.businessDate !== businessDate) {
    return finishResult(base, {
      overall: "unhealthy",
      reason: "notification_identity_mismatch",
      recommendedNextAction: "Inspect the notification identity contract before any authorized recovery."
    });
  }
  if (
    notification.channel !== "email" ||
    !Number.isInteger(notification.recommendationCount) ||
    notification.recommendationCount < 0 ||
    notification.errorCategory !== null ||
    !notification.contentContractPassed
  ) {
    const reason = notification.channel !== "email"
      ? "notification_wrong_channel"
      : notification.errorCategory
        ? "notification_failed"
        : !notification.contentContractPassed
          ? "notification_content_contract_failed"
          : "notification_invalid_count";
    return finishResult(base, {
      overall: "unhealthy",
      reason,
      recommendedNextAction: "Inspect the SMTP notification contract without sending a test email."
    });
  }

  base.providerAccepted = true;
  return finishResult(base, {
    overall: "healthy",
    reason: "healthy",
    recommendedNextAction: "No automated recovery is required."
  });
}

export function buildIssueTitle(result) {
  return `Daily Paper production monitor: ${result.expectedBusinessDate}`;
}

export function buildIssueBody(result) {
  return [
    `- businessDate: ${safeText(result.expectedBusinessDate, "unknown")}`,
    `- Actions run URL: ${safeText(result.actionsRun?.url, "unavailable")}`,
    `- pipeline runId: ${safeText(result.pipeline?.runId, "unavailable")}`,
    `- stage/status: ${safeText(result.pipeline?.failedStage ?? result.pipeline?.status ?? result.actionsRun?.status, "unknown")}`,
    `- deliveryStatus: ${safeText(result.notification?.deliveryStatus, "unavailable")}`,
    `- errorCategory: ${safeText(result.notification?.errorCategory ?? result.reason, "none")}`,
    `- recommended next action: ${safeText(result.recommendedNextAction, "Inspect the existing run.")}`
  ].join("\n");
}

export async function reconcileAlertIssue({ github, result, dryRun }) {
  const title = buildIssueTitle(result);
  const existing = (await github.listIssues()).find(
    (issue) => !issue.pull_request && issue.title === title
  );

  if (result.overall === "pending") return { action: "none", issue: existing ?? null };
  if (result.overall === "healthy") {
    if (!existing || existing.state !== "open") return { action: "none", issue: existing ?? null };
    if (dryRun) return { action: "would_close", issue: existing };
    const body = buildIssueBody(result);
    await github.commentIssue(existing.number, body);
    await github.updateIssue(existing.number, { state: "closed", state_reason: "completed" });
    return { action: "closed", issue: existing };
  }

  const body = buildIssueBody(result);
  if (dryRun) return { action: existing ? "would_update" : "would_create", issue: existing ?? null };
  if (!existing) {
    return { action: "created", issue: await github.createIssue({ title, body }) };
  }
  await github.updateIssue(existing.number, { body, state: "open" });
  return { action: "updated", issue: existing };
}

export function buildStepSummary(result, issueAction = "none") {
  const run = result.actionsRun;
  const pipeline = result.pipeline;
  const notification = result.notification;
  return [
    "## Daily Paper production monitor",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| check time | ${safeText(result.checkTime, "unknown")} |`,
    `| expected businessDate | ${safeText(result.expectedBusinessDate, "unknown")} |`,
    `| daily Actions run | ${run ? `[${run.id}](${run.url})` : "not found"} |`,
    `| Actions event | ${safeText(run?.event, "unavailable")} |`,
    `| Actions status / conclusion / attempt | ${safeText(run?.status, "unavailable")} / ${safeText(run?.conclusion, "unavailable")} / ${safeText(run?.githubAttempt, "unavailable")} |`,
    `| created / started / completed | ${safeText(run?.createdAt, "-")} / ${safeText(run?.startedAt, "-")} / ${safeText(run?.completedAt, "-")} |`,
    `| pipeline runId | ${safeText(pipeline?.runId, "unavailable")} |`,
    `| application attempt | ${safeText(pipeline?.attempt, "unavailable")} |`,
    `| disposition / terminal status | ${safeText(pipeline?.disposition, "unavailable")} / ${safeText(pipeline?.status, "unavailable")} |`,
    `| retryable / failedStage | ${safeText(pipeline?.retryable, "unavailable")} / ${safeText(pipeline?.failedStage, "none")} |`,
    `| notification deliveryStatus / channel | ${safeText(notification?.deliveryStatus, "unavailable")} / ${safeText(notification?.channel, "unavailable")} |`,
    `| provider accepted | ${result.providerAccepted ? "yes" : "no"} |`,
    `| duplicate count | ${result.duplicateCount} |`,
    "| inbox confirmation | user_confirmation_required |",
    `| issue action | ${safeText(issueAction, "none")} |`,
    `| overall result | ${result.overall} |`
  ].join("\n");
}

export class GitHubClient {
  constructor({ token, repository, apiUrl = "https://api.github.com", serverUrl = "https://github.com" }) {
    if (!token) throw new Error("github_token_unavailable");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
      throw new Error("repository_invalid");
    }
    this.token = token;
    this.repository = repository;
    this.apiUrl = new URL(apiUrl).origin;
    this.serverUrl = new URL(serverUrl).origin;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    if (!response.ok) throw new Error(`github_api_${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  getRepository() {
    return this.request(`/repos/${this.repository}`);
  }

  getDailyWorkflow() {
    return this.request(`/repos/${this.repository}/actions/workflows/${DAILY_WORKFLOW_FILE}`);
  }

  async listDailyRuns() {
    const result = await this.request(
      `/repos/${this.repository}/actions/workflows/${DAILY_WORKFLOW_FILE}/runs?per_page=100`
    );
    return Array.isArray(result?.workflow_runs) ? result.workflow_runs : [];
  }

  async listRunArtifacts(runId) {
    const result = await this.request(`/repos/${this.repository}/actions/runs/${runId}/artifacts?per_page=100`);
    return Array.isArray(result?.artifacts) ? result.artifacts : [];
  }

  async listIssues() {
    const issues = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request(
        `/repos/${this.repository}/issues?state=all&per_page=100&page=${page}`
      );
      if (!Array.isArray(result)) break;
      issues.push(...result);
      if (result.length < 100) break;
    }
    return issues;
  }

  createIssue(input) {
    return this.request(`/repos/${this.repository}/issues`, { method: "POST", body: input });
  }

  updateIssue(number, input) {
    return this.request(`/repos/${this.repository}/issues/${number}`, { method: "PATCH", body: input });
  }

  commentIssue(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: "POST",
      body: { body }
    });
  }
}

export async function runLiveMonitor({
  github,
  now,
  phase,
  dryRun,
  evidenceLoader = loadRunEvidence
}) {
  const repository = await github.getRepository();
  const workflow = await github.getDailyWorkflow();
  if (workflow?.path !== DAILY_WORKFLOW_PATH) throw new Error("daily_workflow_path_mismatch");

  const schedule = resolveExpectedSchedule(now);
  const bounds = shanghaiDayBounds(schedule.triggerDate);
  const rawRuns = await github.listDailyRuns();
  const runs = rawRuns
    .map((run) => normalizeWorkflowRun(run, github))
    .filter(Boolean)
    .filter((run) => run.createdAt >= bounds.start && run.createdAt < bounds.end)
    .filter((run) => ["schedule", "workflow_dispatch"].includes(run.event))
    .filter((run) => !run.headBranch || run.headBranch === repository.default_branch);

  const evidenceByRun = {};
  for (const run of runs) {
    if (run.status !== "completed") continue;
    evidenceByRun[String(run.id)] = await evidenceLoader({ github, run });
  }

  const result = evaluateProductionState({ now, phase, runs, evidenceByRun });
  const issueResult = await reconcileAlertIssue({ github, result, dryRun });
  return { result, issueResult };
}

async function loadRunEvidence({ github, run }) {
  const artifacts = await github.listRunArtifacts(run.id);
  const attempts = [];
  for (let attempt = 1; attempt <= run.githubAttempt; attempt += 1) {
    const artifactName = `${RESULT_ARTIFACT_PREFIX}-${attempt}`;
    const artifact = artifacts.find((item) => item.name === artifactName && !item.expired);
    let records = [];
    let source = "unavailable";
    if (artifact) {
      records = await downloadArtifactRecords({ github, runId: run.id, artifactName });
      source = records.length > 0 ? "artifact" : "unavailable";
    }
    attempts.push({ attempt, source, records });
  }
  return attempts;
}

async function downloadArtifactRecords({ github, runId, artifactName }) {
  const tempRoot = resolve(tmpdir());
  const tempDirectory = mkdtempSync(join(tempRoot, "daily-production-monitor-"));
  try {
    await execFilePromise("gh", [
      "run",
      "download",
      String(runId),
      "--name",
      artifactName,
      "--dir",
      tempDirectory,
      "--repo",
      github.repository
    ], github.token);
    return parseProductionResultArtifact(readFileSync(join(tempDirectory, RESULT_ARTIFACT_FILE), "utf8"));
  } catch {
    return [];
  } finally {
    const resolvedDirectory = resolve(tempDirectory);
    if (resolvedDirectory.startsWith(`${tempRoot}\\`) || resolvedDirectory.startsWith(`${tempRoot}/`)) {
      rmSync(resolvedDirectory, { recursive: true, force: true });
    }
  }
}

function execFilePromise(executable, args, token) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(executable, args, {
      shell: false,
      env: { ...process.env, GH_TOKEN: token },
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error) => error ? rejectCommand(error) : resolveCommand());
  });
}

function sanitizeEvidenceRecord(value) {
  if (!isObject(value)) return null;
  if (value.event === "daily_notification") return sanitizeNotificationRecord(value);
  if (value.event === undefined || value.event === "daily_pipeline") return sanitizePipelineRecord(value);
  return null;
}

function sanitizePipelineRecord(value) {
  if (!PIPELINE_STATUSES.has(value.status) || !DISPOSITIONS.has(value.disposition)) return null;
  if (typeof value.retryable !== "boolean") return null;
  return {
    event: "daily_pipeline",
    runId: safeRunId(value.runId),
    businessDate: normalizeBusinessDate(value.businessDate ?? value.runDate),
    attempt: positiveInteger(value.attempt),
    disposition: value.disposition,
    status: value.status,
    retryable: value.retryable,
    failedStage: value.failedStage === undefined || value.failedStage === null
      ? null
      : FAILED_STAGES.has(value.failedStage)
        ? value.failedStage
        : "invalid"
  };
}

function sanitizeNotificationRecord(value) {
  if (!DELIVERY_STATUSES.has(value.deliveryStatus) || !CHANNELS.has(value.channel)) return null;
  const businessDate = normalizeBusinessDate(value.businessDate);
  const recommendationCount = nonNegativeInteger(value.recommendationCount);
  const legacyContentContract = Boolean(
    businessDate &&
    recommendationCount !== null &&
    typeof value.warningSummary === "string" &&
    value.warningSummary.length <= 500
  );
  return {
    event: "daily_notification",
    runId: safeRunId(value.runId),
    businessDate,
    attempt: positiveInteger(value.attempt),
    runStatus: PIPELINE_STATUSES.has(value.runStatus) ? value.runStatus : null,
    deliveryStatus: value.deliveryStatus,
    channel: value.channel,
    recommendationCount,
    errorCategory: value.errorCategory === undefined || value.errorCategory === null
      ? null
      : ERROR_CATEGORIES.has(value.errorCategory)
        ? value.errorCategory
        : "invalid",
    reason: NOTIFICATION_REASONS.has(value.reason) ? value.reason : null,
    deduplicated: value.deduplicated === true,
    dashboardLinkIncluded: value.dashboardLinkIncluded === true,
    contentContractPassed: value.dashboardLinkIncluded === true || legacyContentContract
  };
}

function resultForMissingRun({ checkTime, normalizedPhase, triggerDate, businessDate }) {
  const base = buildBaseResult({ checkTime, triggerDate, businessDate, selectedRun: null });
  return finishResult(base, normalizedPhase === "first" ? {
    overall: "pending",
    reason: "scheduled_run_not_started",
    recommendedNextAction: "Wait for the final scheduled check; do not start the daily pipeline."
  } : {
    overall: "unhealthy",
    reason: "scheduled_run_missing_at_final_check",
    recommendedNextAction: "Inspect GitHub Actions scheduling before authorizing any recovery."
  });
}

function buildBaseResult({ checkTime, triggerDate, businessDate, selectedRun }) {
  return {
    checkTime: checkTime.toISOString(),
    triggerDate,
    expectedBusinessDate: businessDate,
    actionsRun: selectedRun,
    pipeline: null,
    notification: null,
    providerAccepted: false,
    inboxConfirmation: "user_confirmation_required",
    duplicateCount: 0,
    overall: "unhealthy",
    reason: "unknown",
    recommendedNextAction: "Inspect the existing Actions run."
  };
}

function finishResult(base, update) {
  return { ...base, ...update };
}

function normalizeWorkflowRun(value, github) {
  if (!isObject(value) || !Number.isSafeInteger(value.id) || value.id <= 0) return null;
  const createdAt = safeIso(value.created_at);
  if (!createdAt) return null;
  const status = ["queued", "in_progress", "completed", "waiting", "requested", "pending"]
    .includes(value.status) ? value.status : "unknown";
  return {
    id: value.id,
    event: typeof value.event === "string" ? value.event : "unknown",
    status,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    createdAt,
    startedAt: safeIso(value.run_started_at),
    completedAt: status === "completed" ? safeIso(value.updated_at) : null,
    githubAttempt: positiveInteger(value.run_attempt) ?? 1,
    headBranch: typeof value.head_branch === "string" ? value.head_branch : null,
    url: `${github.serverUrl}/${github.repository}/actions/runs/${value.id}`
  };
}

function latestPipelineRecord(attempts) {
  return allRecords(attempts).filter((record) => record.event === "daily_pipeline").at(-1) ?? null;
}

function allRecords(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts
    .slice()
    .sort((left, right) => (left.attempt ?? 0) - (right.attempt ?? 0))
    .flatMap((attempt) => Array.isArray(attempt.records) ? attempt.records : []);
}

function shanghaiParts(date) {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type) => entries.find((entry) => entry.type === type)?.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
    minute: Number(part("minute"))
  };
}

function shanghaiDayBounds(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function normalizeBusinessDate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}

function safeRunId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function elapsedMinutes(start, end) {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration / 60_000 : Number.POSITIVE_INFINITY;
}

function safeText(value, fallback) {
  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value).replace(/[^A-Za-z0-9_./:@?=&+\- ]/g, "").slice(0, 240) || fallback;
  }
  return fallback;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("monitor_clock_invalid");
  return date;
}

async function main() {
  const now = process.env.MONITOR_NOW ? asValidDate(process.env.MONITOR_NOW) : new Date();
  const phase = process.env.MONITOR_PHASE === "final" ? "final" : "first";
  const dryRun = process.env.MONITOR_DRY_RUN === "true";
  const github = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
    serverUrl: process.env.GITHUB_SERVER_URL
  });
  const { result, issueResult } = await runLiveMonitor({ github, now, phase, dryRun });
  const summary = buildStepSummary(result, issueResult.action);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8");
  }
  console.log(JSON.stringify({
    event: "daily_production_monitor",
    checkTime: result.checkTime,
    expectedBusinessDate: result.expectedBusinessDate,
    actionsRunId: result.actionsRun?.id ?? null,
    pipelineRunId: result.pipeline?.runId ?? null,
    terminalStatus: result.pipeline?.status ?? null,
    retryable: result.pipeline?.retryable ?? null,
    deliveryStatus: result.notification?.deliveryStatus ?? null,
    channel: result.notification?.channel ?? null,
    duplicateCount: result.duplicateCount,
    inboxConfirmation: result.inboxConfirmation,
    issueAction: issueResult.action,
    overall: result.overall,
    reason: result.reason
  }));
  process.exitCode = result.overall === "unhealthy" ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(async () => {
    const safeFailure = {
      event: "daily_production_monitor",
      overall: "unhealthy",
      reason: "monitor_internal",
      inboxConfirmation: "user_confirmation_required"
    };
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        "## Daily Paper production monitor\n\nOverall result: unhealthy (monitor_internal)\n",
        "utf8"
      ).catch(() => {});
    }
    console.log(JSON.stringify(safeFailure));
    process.exitCode = 1;
  });
}
