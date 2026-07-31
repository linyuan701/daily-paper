import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

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
const NOTIFICATION_REASONS = new Set([
  "configuration_incomplete",
  "already_sent",
  "legacy_suppressed",
  "delivery_outcome_unknown",
  "already_succeeded",
  "already_running",
  "missing_run_id"
]);
const ERROR_CATEGORIES = new Set(["delivery_failed", "notification_internal"]);

export function collectProductionEvidence({
  lines,
  businessDate,
  dashboardUrl,
  generatedAt = new Date().toISOString(),
  existing = null
}) {
  const normalizedDate = normalizeBusinessDate(businessDate);
  if (!normalizedDate) throw new Error("businessDate must use YYYY-MM-DD");

  let pipeline = sanitizeExistingPipeline(existing?.pipeline);
  let notification = sanitizeExistingNotification(existing?.notification);

  for (const line of lines) {
    const value = parseJsonLine(line);
    if (!value) continue;
    if (value.event === "daily_notification") {
      notification = sanitizeNotification(value, normalizedDate, dashboardUrl);
      if (!pipeline) {
        pipeline = pipelineFromPersistedSkip(notification);
      }
      continue;
    }
    const candidate = sanitizePipeline(value, normalizedDate);
    if (candidate) pipeline = candidate;
  }

  return {
    schemaVersion: 1,
    generatedAt: safeIso(generatedAt) ?? new Date().toISOString(),
    pipeline,
    notification
  };
}

export function writeProductionEvidence(path, artifact) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  renameSync(temporary, target);
}

function sanitizePipeline(value, businessDate) {
  if (
    !isObject(value) ||
    value.event === "daily_notification" ||
    !PIPELINE_STATUSES.has(value.status) ||
    !DISPOSITIONS.has(value.disposition) ||
    typeof value.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    event: "daily_pipeline",
    runId: safeRunId(value.runId),
    businessDate,
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

function sanitizeNotification(value, businessDate, dashboardUrl) {
  if (
    !isObject(value) ||
    !DELIVERY_STATUSES.has(value.deliveryStatus) ||
    !CHANNELS.has(value.channel)
  ) {
    return null;
  }
  const recommendationCount = nonNegativeInteger(value.recommendationCount);
  const dashboardLinkIncluded = isPublicDashboardUrl(dashboardUrl);
  const reason = NOTIFICATION_REASONS.has(value.reason) ? value.reason : null;
  const persistedDeliveryStatus = value.deliveryStatus === "sent" || reason === "already_sent"
    ? "SENT"
    : reason === "delivery_outcome_unknown"
      ? "SENDING"
      : reason === "legacy_suppressed"
        ? "LEGACY_SUPPRESSED"
        : null;
  return {
    event: "daily_notification",
    runId: safeRunId(value.runId),
    businessDate: normalizeBusinessDate(value.businessDate) ?? businessDate,
    attempt: positiveInteger(value.attempt),
    runStatus: PIPELINE_STATUSES.has(value.runStatus) ? value.runStatus : null,
    deliveryStatus: value.deliveryStatus,
    persistedDeliveryStatus,
    channel: value.channel,
    recommendationCount,
    errorCategory: value.errorCategory === undefined || value.errorCategory === null
      ? null
      : ERROR_CATEGORIES.has(value.errorCategory)
        ? value.errorCategory
        : "invalid",
    reason,
    deduplicated: value.deduplicated === true,
    dashboardLinkIncluded,
    contentContractPassed: dashboardLinkIncluded && recommendationCount !== null
  };
}

function pipelineFromPersistedSkip(notification) {
  if (
    !notification?.runId ||
    !["already_sent", "delivery_outcome_unknown", "legacy_suppressed"].includes(notification.reason) ||
    !["complete", "complete_with_warnings"].includes(notification.runStatus)
  ) {
    return null;
  }
  return {
    event: "daily_pipeline",
    runId: notification.runId,
    businessDate: notification.businessDate,
    attempt: null,
    disposition: "already_succeeded",
    status: notification.runStatus,
    retryable: false,
    failedStage: null
  };
}

function sanitizeExistingPipeline(value) {
  if (!isObject(value)) return null;
  const businessDate = normalizeBusinessDate(value.businessDate);
  return businessDate ? sanitizePipeline(value, businessDate) : null;
}

function sanitizeExistingNotification(value) {
  if (
    !isObject(value) ||
    value.event !== "daily_notification" ||
    !normalizeBusinessDate(value.businessDate) ||
    !DELIVERY_STATUSES.has(value.deliveryStatus) ||
    !CHANNELS.has(value.channel)
  ) {
    return null;
  }
  return {
    event: "daily_notification",
    runId: safeRunId(value.runId),
    businessDate: normalizeBusinessDate(value.businessDate),
    attempt: positiveInteger(value.attempt),
    runStatus: PIPELINE_STATUSES.has(value.runStatus) ? value.runStatus : null,
    deliveryStatus: value.deliveryStatus,
    persistedDeliveryStatus: ["SENT", "SENDING", "LEGACY_SUPPRESSED"].includes(
      value.persistedDeliveryStatus
    ) ? value.persistedDeliveryStatus : null,
    channel: value.channel,
    recommendationCount: nonNegativeInteger(value.recommendationCount),
    errorCategory: value.errorCategory === null || ERROR_CATEGORIES.has(value.errorCategory)
      ? value.errorCategory
      : "invalid",
    reason: NOTIFICATION_REASONS.has(value.reason) ? value.reason : null,
    deduplicated: value.deduplicated === true,
    dashboardLinkIncluded: value.dashboardLinkIncluded === true,
    contentContractPassed: value.contentContractPassed === true
  };
}

function parseJsonLine(line) {
  if (typeof line !== "string" || line.length > 1_000_000) return null;
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(line.slice(start));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function readExisting(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) && value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function parseArgs(args) {
  if (args.length !== 4 || args[0] !== "--output" || args[2] !== "--business-date") {
    throw new Error("Usage: daily-production-evidence --output PATH --business-date YYYY-MM-DD");
  }
  return { output: args[1], businessDate: args[3] };
}

function normalizeBusinessDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function isPublicDashboardUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const { output, businessDate } = parseArgs(process.argv.slice(2));
  const lines = [];
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    process.stdout.write(`${line}\n`);
    if (parseJsonLine(line)) lines.push(line);
  }
  const existing = readExisting(output);
  const artifact = collectProductionEvidence({
    lines,
    businessDate,
    dashboardUrl: process.env.NOTIFICATION_DASHBOARD_URL,
    existing
  });
  writeProductionEvidence(output, artifact);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(() => {
    console.error(JSON.stringify({
      event: "daily_production_evidence",
      status: "failed",
      reason: "evidence_contract_failed"
    }));
    process.exitCode = 1;
  });
}
