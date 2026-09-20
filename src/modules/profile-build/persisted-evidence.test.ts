import { describe, expect, it } from "vitest";
import { projectFeedbackEvidence } from "./persisted-evidence";
describe("persisted profile feedback evidence", () => {
  it("does not infer consumption or manufacture zeroes for old snapshots", () => {
    expect(projectFeedbackEvidence({ segmentCounts: {} })).toBeUndefined();
    expect(projectFeedbackEvidence({ feedbackIntegration: {} })?.logsConsumed).toBeUndefined();
  });
  it("projects only explicitly saved fields, excluding arbitrary metadata", () => {
    const result = projectFeedbackEvidence({ feedbackIntegration: { logsConsumed: 7, actionCounts: { dismiss: 3, secret: 123 }, internalToken: "not-for-ui", negativeFeedback: { modelVersion: "v1", signalCount: 1, maxPenalty: 0.2, signals: [{ sourceFeedbackLogId: "log-fixture", representationText: "fixture", paperIdentityKey: "private-internal" }] } } });
    expect(result?.logsConsumed).toBe(7);
    expect(result?.actionCounts).toEqual({ dismiss: 3 });
    expect(result?.negativeFeedback?.signals[0].sourceFeedbackLogId).toBe("log-fixture");
    expect(JSON.stringify(result)).not.toMatch(/not-for-ui|private-internal|secret/);
  });
});
