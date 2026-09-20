/** Read projection only: no re-evaluation of feedback or ranking. */
export type PersistedFeedbackEvidence = {
  since?: string;
  logsConsumed?: number;
  actionCounts: Record<string, number>;
  negativeFeedback?: {
    modelVersion?: string;
    signalCount?: number;
    maxPenalty?: number;
    signals: Array<{
      sourceCandidateId?: string;
      sourceFeedbackLogId?: string;
      contentRecallLabel?: string;
      researchCategory?: string;
      representationText?: string;
      effectiveAt?: string;
    }>;
  };
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const string = (value: unknown) => typeof value === "string" ? value.slice(0, 4000) : undefined;

export function projectFeedbackEvidence(summary: unknown): PersistedFeedbackEvidence | undefined {
  const feedback = object(object(summary)?.feedbackIntegration);
  if (!feedback) return undefined;
  const counts = object(feedback.actionCounts);
  const negative = object(feedback.negativeFeedback);
  return {
    since: string(feedback.since), logsConsumed: number(feedback.logsConsumed),
    actionCounts: Object.fromEntries(["save", "dismiss", "promote", "label_edit", "summary_edit"]
      .flatMap(key => number(counts?.[key]) === undefined ? [] : [[key, number(counts?.[key])!]])),
    negativeFeedback: negative ? {
      modelVersion: string(negative.modelVersion), signalCount: number(negative.signalCount), maxPenalty: number(negative.maxPenalty),
      signals: Array.isArray(negative.signals) ? negative.signals.slice(0, 200).flatMap(value => {
        const signal = object(value);
        return signal ? [{
          sourceCandidateId: string(signal.sourceCandidateId), sourceFeedbackLogId: string(signal.sourceFeedbackLogId),
          contentRecallLabel: string(signal.contentRecallLabel), researchCategory: string(signal.researchCategory),
          representationText: string(signal.representationText), effectiveAt: string(signal.effectiveAt)
        }] : [];
      }) : []
    } : undefined
  };
}
