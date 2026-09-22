import { describe, expect, it } from "vitest";
import { readPersistedFeedbackEvidence } from "./persisted-feedback-evidence";
import { parseNegativeFeedbackSignals } from "../feedback/negative-feedback";

const signal = {
  paperIdentityKey: "PRIVATE_IDENTITY", sourceCandidateId: "candidate-1", sourceFeedbackLogId: "feedback-1",
  representationText: "PRIVATE_REPRESENTATION", effectiveAt: "2026-09-11T00:15:00.000Z"
};
const summary = (signals: unknown) => ({ feedbackIntegration: { negativeFeedback: { signals } } });

describe("persisted feedback evidence reader", () => {
  it.each([undefined, null, {}, [], { feedbackIntegration: {} }, summary(null), summary({})])(
    "does not invent signals from missing or legacy data (%j)", (value) => {
      expect(readPersistedFeedbackEvidence(value)).toEqual([]);
    }
  );

  it("exposes only the three evidence fields after validation and trimming", () => {
    const output = readPersistedFeedbackEvidence(summary([{
      ...signal, sourceCandidateId: " candidate-1 ", sourceFeedbackLogId: " feedback-1 ",
      effectiveAt: " 2026-09-11T00:15:00.000Z ", contentRecallLabel: "PRIVATE_LABEL",
      researchCategory: "biology", arbitrarySecret: "PRIVATE_SECRET"
    }]));
    expect(output).toEqual([{
      sourceCandidateId: "candidate-1", sourceFeedbackLogId: "feedback-1", effectiveAt: signal.effectiveAt
    }]);
    expect(JSON.stringify(output)).not.toContain("PRIVATE_");
  });

  it.each(Object.keys(signal))("rejects an incomplete %s field", (field) => {
    for (const invalid of [undefined, null, "", " \t ", 123, [], {}]) {
      expect(readPersistedFeedbackEvidence(summary([{ ...signal, [field]: invalid }]))).toEqual([]);
    }
  });

  it("skips malformed entries and caps valid persisted evidence at 50", () => {
    const input = [null, [], false, "bad", ...Array.from({ length: 55 }, (_, index) => ({
      ...signal, sourceFeedbackLogId: `feedback-${index}`
    }))];
    const output = readPersistedFeedbackEvidence(summary(input));
    // Master already parses this persisted format. The v1 projection agrees but
    // exposes no private representation and imports no scoring code at runtime.
    expect(output).toEqual(parseNegativeFeedbackSignals(summary(input)).map(
      ({ sourceFeedbackLogId, sourceCandidateId, effectiveAt }) => ({ sourceFeedbackLogId, sourceCandidateId, effectiveAt })
    ));
    expect(output).toHaveLength(50);
    expect(output[0].sourceFeedbackLogId).toBe("feedback-0");
    expect(output[49].sourceFeedbackLogId).toBe("feedback-49");
  });
});
