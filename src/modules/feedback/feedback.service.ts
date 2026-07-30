import type { FeedbackLogRecord, FeedbackLogRepository, FeedbackService } from "./types";

export class DefaultFeedbackService implements FeedbackService {
  constructor(private readonly repository: FeedbackLogRepository) {}

  async logTriageAction(input: {
    runId: string;
    candidateId: string;
    action: "save" | "dismiss" | "promote";
    metadata?: Record<string, unknown>;
  }): Promise<FeedbackLogRecord> {
    return this.repository.appendLog({
      runId: input.runId,
      candidateId: input.candidateId,
      actionType: input.action,
      metadata: input.metadata
    });
  }

  async logLabelEdit(input: {
    runId: string;
    candidateId: string;
    oldValue?: Record<string, unknown>;
    newValue?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<FeedbackLogRecord> {
    return this.repository.appendLog({
      runId: input.runId,
      candidateId: input.candidateId,
      actionType: "label_edit",
      oldValue: input.oldValue,
      newValue: input.newValue,
      metadata: input.metadata
    });
  }

  async logSummaryEdit(input: {
    runId: string;
    candidateId: string;
    oldValue?: Record<string, unknown>;
    newValue?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<FeedbackLogRecord> {
    return this.repository.appendLog({
      runId: input.runId,
      candidateId: input.candidateId,
      actionType: "summary_edit",
      oldValue: input.oldValue,
      newValue: input.newValue,
      metadata: input.metadata
    });
  }

  async listLogs(input?: {
    runId?: string;
    candidateId?: string;
    candidateIds?: string[];
    limit?: number;
  }): Promise<FeedbackLogRecord[]> {
    return this.repository.listLogs(input);
  }
}
