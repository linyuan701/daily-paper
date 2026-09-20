/**
 * Read the persisted signal shape only. This intentionally has no dependency on
 * profile refresh or ranking/penalty computation. The validation and 50-signal
 * bound match parseNegativeFeedbackSignals in the newer persisted format.
 */
export type PersistedFeedbackEvidence = {
  sourceFeedbackLogId: string;
  sourceCandidateId: string;
  effectiveAt: string;
};

export function readPersistedFeedbackEvidence(summaryJson: unknown): PersistedFeedbackEvidence[] {
  const summary = object(summaryJson);
  const integration = object(summary.feedbackIntegration);
  const negative = object(integration.negativeFeedback);
  const signals = Array.isArray(negative.signals) ? negative.signals : [];
  return signals.map(readSignal)
    .filter((signal): signal is PersistedFeedbackEvidence => signal !== undefined)
    .slice(0, 50);
}

function readSignal(value: unknown): PersistedFeedbackEvidence | undefined {
  const signal = object(value);
  const paperIdentityKey = string(signal.paperIdentityKey);
  const sourceCandidateId = string(signal.sourceCandidateId);
  const sourceFeedbackLogId = string(signal.sourceFeedbackLogId);
  const representationText = string(signal.representationText);
  const effectiveAt = string(signal.effectiveAt);
  if (!paperIdentityKey || !sourceCandidateId || !sourceFeedbackLogId || !representationText || !effectiveAt) {
    return undefined;
  }
  return { sourceFeedbackLogId, sourceCandidateId, effectiveAt };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}
