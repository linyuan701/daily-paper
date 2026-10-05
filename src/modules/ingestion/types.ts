export type DailyCandidateSourceValue = "biorxiv" | "arxiv" | "pubmed" | "journal";
export type DailyIngestionRunSourceValue = DailyCandidateSourceValue | "aggregated";
export type DailyIngestionRunStatusValue = "running" | "success" | "failed";
export type DailyPipelineRunStatusValue =
  | "running"
  | "complete"
  | "complete_with_warnings"
  | "partial"
  | "failed";
export type DailyRunDisposition =
  | "acquired"
  | "retry"
  | "pipeline_acquired"
  | "already_running"
  | "already_succeeded";

export type DailySourceAdapterCandidate = {
  externalId: string;
  title?: string;
  abstractNote?: string;
  publishedAt?: Date;
  indexedAt?: Date;
  url?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  bioRxivId?: string;
  journalName?: string;
  authors: string[];
  sourcePayload: Record<string, unknown>;
};

export type DailyCandidateRecord = {
  id: string;
  runId: string;
  source: DailyCandidateSourceValue;
  externalId: string;
  title?: string;
  abstractNote?: string;
  publishedAt?: Date;
  indexedAt?: Date;
  url?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  bioRxivId?: string;
  journalName?: string;
  authors: string[];
  sourcePayload: Record<string, unknown>;
};

export type DailyIngestionRunSummary = {
  id: string;
  requestKey?: string;
  attempt: number;
  source: DailyIngestionRunSourceValue;
  status: DailyIngestionRunStatusValue;
  pipelineStatus?: DailyPipelineRunStatusValue;
  runDate: string;
  startedAt: string;
  finishedAt?: string;
  pipelineStartedAt?: string;
  pipelineFinishedAt?: string;
  candidatesCount: number;
  errorMessage?: string;
};

export type AggregatedSourceIngestionSummary = {
  source: DailyCandidateSourceValue;
  status?: "success" | "failed";
  candidatesCount: number;
  fetchedCount?: number;
  filteredCount?: number;
  windowStart?: string;
  windowEnd?: string;
  filterMode?: "indexed_day" | "watermark" | "first_seen";
  errorMessage?: string;
  diagnostic?: ArxivFailureDiagnostic;
};

export type ArxivFailureDiagnostic = {
  source: "arxiv";
  failureCode: "ARXIV_SCOPE_REQUIRED" | "ARXIV_API_ERROR" | "ARXIV_UNEXPECTED_ERROR";
  stage: "configuration" | "request" | "ingestion";
  failureCategory:
    | "configuration_error"
    | "rate_limit"
    | "timeout"
    | "network"
    | "server_error"
    | "http_error"
    | "unknown";
  retryable: boolean;
  endpointHost?: "export.arxiv.org";
  categoryIndex?: number;
  page?: number;
  start?: number;
  attempts?: number;
  elapsedMs?: number;
  attemptElapsedMs?: number;
  timeoutMs?: number;
  requestPhase?: "headers" | "body";
  httpStatus?: number;
  transportCode?: string;
};

export type JournalFeedSourceRecord = {
  id: string;
  journalName: string;
  feedUrl: string;
  isActive: boolean;
};

export type UtcDayWindow = {
  runDate: Date;
  dayStart: Date;
  dayEnd: Date;
  sourceStart?: Date;
  sourceEnd?: Date;
};

export interface DailySourceAdapter {
  readonly source: DailyCandidateSourceValue;
  validateConfiguration?(): void;
  fetchCandidatesForDay(input: UtcDayWindow): Promise<DailySourceAdapterCandidate[]>;
}

export interface JournalFeedRepository {
  listActiveFeeds(): Promise<JournalFeedSourceRecord[]>;
}

export interface DailyIngestionRepository {
  acquireRun(input: {
    source: DailyIngestionRunSourceValue;
    runDate: Date;
    requestKey: string;
  }): Promise<{ run: DailyIngestionRunSummary; disposition: DailyRunDisposition }>;
  finalizeRunSuccess(input: {
    runId: string;
    attempt: number;
    entries: Array<{
      source: DailyCandidateSourceValue;
      candidate: DailySourceAdapterCandidate;
    }>;
    checkpoints: Array<{
      source: DailyCandidateSourceValue;
      successfulAt: Date;
      seenExternalIds?: string[];
    }>;
    pipelineInitialization?: {
      ingestionStatus: "success" | "partial";
      ingestionDetails: Record<string, unknown>;
    };
  }): Promise<DailyIngestionRunSummary>;
  markRunFailed(input: { runId: string; attempt: number; errorMessage: string }): Promise<DailyIngestionRunSummary>;
  setPipelineOutcome(input: {
    runId: string;
    attempt: number;
    status: Exclude<DailyPipelineRunStatusValue, "running">;
  }): Promise<DailyIngestionRunSummary>;
  getLatestRun(input?: { source?: DailyIngestionRunSourceValue }): Promise<DailyIngestionRunSummary | null>;
  getRun(runId: string): Promise<DailyIngestionRunSummary | null>;
  listCandidatesByRun(runId: string): Promise<DailyCandidateRecord[]>;
  getSourceCursor(source: DailyCandidateSourceValue): Promise<Date | undefined>;
  listSeenExternalIds(source: DailyCandidateSourceValue, externalIds: string[]): Promise<Set<string>>;
}

export interface DailyIngestionService {
  runSourceIngestion(input: {
    source: DailyCandidateSourceValue;
    runDate?: string;
  }): Promise<{
    run: DailyIngestionRunSummary;
    candidates: DailyCandidateRecord[];
    disposition: DailyRunDisposition;
  }>;
  runAggregatedIngestion(input?: {
    runDate?: string;
    sources?: DailyCandidateSourceValue[];
  }): Promise<{
    run: DailyIngestionRunSummary;
    candidates: DailyCandidateRecord[];
    sourceSummaries: AggregatedSourceIngestionSummary[];
    disposition: DailyRunDisposition;
  }>;
  getLatestRun(input?: { source?: DailyIngestionRunSourceValue }): Promise<DailyIngestionRunSummary | null>;
  getRun(runId: string): Promise<DailyIngestionRunSummary | null>;
  setPipelineOutcome(input: {
    runId: string;
    attempt: number;
    status: Exclude<DailyPipelineRunStatusValue, "running">;
  }): Promise<DailyIngestionRunSummary>;
}
