import assert from "node:assert/strict";
import test from "node:test";

import { collectProductionEvidence } from "./daily-production-evidence.mjs";

const BUSINESS_DATE = "2026-07-30";
const DASHBOARD_URL = "https://daily.example.com/recommendations";

test("collects a completed scheduled pipeline and persisted SENT notification", () => {
  const artifact = collectProductionEvidence({
    businessDate: BUSINESS_DATE,
    dashboardUrl: DASHBOARD_URL,
    generatedAt: "2026-07-31T01:00:00.000Z",
    lines: [
      'npm banner that is not evidence',
      JSON.stringify({
        status: "complete_with_warnings",
        disposition: "executed",
        runId: "run-1",
        retryable: false
      }),
      JSON.stringify({
        event: "daily_notification",
        runId: "run-1",
        runStatus: "complete_with_warnings",
        businessDate: BUSINESS_DATE,
        deliveryStatus: "sent",
        channel: "email",
        recommendationCount: 8
      })
    ]
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.deepEqual(artifact.pipeline, {
    event: "daily_pipeline",
    runId: "run-1",
    businessDate: BUSINESS_DATE,
    attempt: null,
    disposition: "executed",
    status: "complete_with_warnings",
    retryable: false,
    failedStage: null
  });
  assert.equal(artifact.notification.persistedDeliveryStatus, "SENT");
  assert.equal(artifact.notification.deliveryStatus, "sent");
  assert.equal(artifact.notification.contentContractPassed, true);
});

test("maps persisted SENDING to delivery_outcome_unknown without provider details", () => {
  const secret = "provider-secret-error-body";
  const artifact = collectProductionEvidence({
    businessDate: BUSINESS_DATE,
    dashboardUrl: DASHBOARD_URL,
    lines: [JSON.stringify({
      event: "daily_notification",
      runId: "run-2",
      runStatus: "complete",
      businessDate: BUSINESS_DATE,
      deliveryStatus: "skipped",
      channel: "none",
      reason: "delivery_outcome_unknown",
      deduplicated: true,
      providerError: secret
    })]
  });

  assert.equal(artifact.pipeline.disposition, "already_succeeded");
  assert.equal(artifact.notification.persistedDeliveryStatus, "SENDING");
  assert.equal(artifact.notification.reason, "delivery_outcome_unknown");
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(secret));
});

test("merges persisted guard evidence with the later pipeline result", () => {
  const guarded = collectProductionEvidence({
    businessDate: BUSINESS_DATE,
    dashboardUrl: DASHBOARD_URL,
    lines: [JSON.stringify({
      status: "accepted",
      businessDate: BUSINESS_DATE,
      runId: "run-3",
      reason: "recoverable_run",
      runMigration: false,
      runDailyJob: true
    })]
  });
  const completed = collectProductionEvidence({
    businessDate: BUSINESS_DATE,
    dashboardUrl: DASHBOARD_URL,
    existing: guarded,
    lines: [
      JSON.stringify({
        status: "failed",
        disposition: "resumed",
        runId: "run-3",
        failedStage: "rerank",
        retryable: true
      }),
      JSON.stringify({
        event: "daily_notification",
        runId: "run-3",
        runStatus: "failed",
        deliveryStatus: "failed",
        channel: "none",
        errorCategory: "delivery_failed"
      })
    ]
  });

  assert.equal(completed.pipeline.status, "failed");
  assert.equal(completed.pipeline.failedStage, "rerank");
  assert.equal(completed.notification.errorCategory, "delivery_failed");
});
