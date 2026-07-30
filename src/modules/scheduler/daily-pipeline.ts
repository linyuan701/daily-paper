import { logger } from "../../lib/logging";
import { AppError } from "../../lib/errors";
import { getEnv } from "../../lib/config";
import { createJournalEnrichmentService } from "../candidate-enrich";
import {
  createDailyIngestionService,
  type AggregatedSourceIngestionSummary,
  type DailyCandidateSourceValue
} from "../ingestion";
import { createCandidateNormalizationService } from "../normalize-dedupe";
import { createRecallRankingService } from "../ranking/recall";
import { createRerankService } from "../ranking/rerank";
import { createCandidateOutputService } from "../summary";
import {
  createPipelineStageService,
  concludeDailyPipeline,
  findDailyResumeStage,
  isDailyPipelineRetryable,
  STAGE_ORDER,
  type DailyPipelineDisposition,
  type DailyPipelineOutcome,
  type DailyPipelineStageRecord,
  type DailyPipelineStageValue
} from "../pipeline-status";

export type DailySchedulerSource = DailyCandidateSourceValue;

export type DailySchedulerSourceResult = {
  source: DailySchedulerSource;
  runId?: string;
  status: "success" | "failed";
  errorMessage?: string;
};

export type DailyPipelineRunSummary = {
  status: DailyPipelineOutcome | "running";
  disposition: DailyPipelineDisposition;
  runId?: string;
  failedStage?: DailyPipelineStageValue;
  retryable: boolean;
  startedAt: string;
  finishedAt: string;
  runDate?: string;
  sources: DailySchedulerSourceResult[];
  stages: DailyPipelineStageRecord[];
};

export async function runDailyRecommendationPipeline(input?: {
  runDate?: string;
  sources?: DailySchedulerSource[];
}): Promise<DailyPipelineRunSummary> {
  const startedAt = new Date();
  const configuredRecommendationLimit = getEnv().DAILY_RECOMMENDATION_LIMIT;
  const sourceList = input?.sources?.length
    ? input.sources
    : (["biorxiv", "arxiv", "pubmed", "journal"] as const);

  const ingestion = createDailyIngestionService();
  const enrich = createJournalEnrichmentService();
  const dedupe = createCandidateNormalizationService();
  const summarize = createCandidateOutputService();
  const recall = createRecallRankingService();
  const rerank = createRerankService();
  const stageStatus = createPipelineStageService();

  let results: DailySchedulerSourceResult[] = [];
  let activeRunId: string | undefined;
  let activeAttempt: number | undefined;
  let activeStage: DailyPipelineStageValue = "ingestion";
  let pipelineStatus: DailyPipelineRunSummary["status"] = "complete";
  let disposition: DailyPipelineDisposition = "executed";
  let persistedStages: DailyPipelineStageRecord[] = [];

  try {
    logger.info("Scheduler daily aggregated pipeline started", {
      sources: sourceList,
      runDate: input?.runDate
    });

    const ingestResult = await ingestion.runAggregatedIngestion({
      runDate: input?.runDate,
      sources: [...sourceList]
    });
    const runId = ingestResult.run.id;
    activeRunId = runId;
    activeAttempt = ingestResult.run.attempt;
    disposition = ingestResult.disposition === "acquired" ? "executed" : "resumed";
    let sourceSummaries = ingestResult.sourceSummaries;

    if (ingestResult.disposition === "already_succeeded" || ingestResult.disposition === "pipeline_acquired") {
      persistedStages = await stageStatus.list(runId);
      sourceSummaries = sourceSummariesFromStages(persistedStages) ?? sourceSummaries;
      const resumeStage = findDailyResumeStage(persistedStages);
      if (!resumeStage) {
        logger.info("Scheduler daily pipeline reused completed ingestion run", { runId });
        results = sourceSummaries.map((entry) => ({
          source: entry.source,
          runId,
          status: entry.status ?? "success",
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {})
        }));
        const conclusion = concludeDailyPipeline(persistedStages);
        if (ingestResult.disposition === "pipeline_acquired") {
          await ingestion.setPipelineOutcome({
            runId,
            attempt: ingestResult.run.attempt,
            status: conclusion.status
          });
        }
        const storedStatus = asTerminalPipelineOutcome(ingestResult.run.pipelineStatus) ?? conclusion.status;
        return {
          status: ingestResult.disposition === "pipeline_acquired" ? conclusion.status : storedStatus,
          disposition: ingestResult.disposition === "pipeline_acquired" ? "resumed" : "already_succeeded",
          runId,
          failedStage: conclusion.failedStage,
          retryable: isDailyPipelineRetryable(persistedStages),
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          runDate: input?.runDate,
          sources: results,
          stages: persistedStages
        } satisfies DailyPipelineRunSummary;
      }
      logger.info("Scheduler daily pipeline resuming partial downstream stages", {
        runId,
        resumeStage
      });
    }

    results = sourceSummaries.map((entry) => ({
      source: entry.source,
      ...(entry.status === "failed" ? {} : { runId }),
      status: entry.status ?? "success",
      ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {})
    }));

    const sourcePartial = sourceSummaries.some((entry) => entry.status === "failed");
    if (persistedStages.length === 0) {
      persistedStages = await stageStatus.list(runId);
    }
    if (persistedStages.length === 0) {
      await stageStatus.initialize({
        runId,
        attempt: activeAttempt!,
        ingestionStatus: sourcePartial ? "partial" : "success",
        ingestionDetails: { sources: sourceSummaries }
      });
      persistedStages = await stageStatus.list(runId);
    }
    const resumeStage = findDailyResumeStage(persistedStages) ?? "enrichment";
    const persistedRecommendationLimit = recommendationLimitFromStages(persistedStages);
    let recommendationLimit = persistedRecommendationLimit ?? configuredRecommendationLimit;
    const completedRerankWithoutLimit = persistedRecommendationLimit === undefined &&
      persistedStages.some((stage) => stage.stage === "rerank" && stage.status === "success");
    if (completedRerankWithoutLimit) {
      const persistedRerank = await rerank.getLatestRerankRun(runId);
      if (
        persistedRerank?.run.status === "success" &&
        isRecommendationLimit(persistedRerank.run.requestedTopN)
      ) {
        recommendationLimit = persistedRerank.run.requestedTopN;
      }
    }
    const shouldRun = (stage: DailyPipelineStageValue) =>
      STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(resumeStage);

    activeStage = "enrichment";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const enrichment = await enrich.enrichRun(runId);
      await stageStatus.complete({
        runId,
        attempt: activeAttempt!,
        stage: activeStage,
        status: enrichment.failed > 0 ? "partial" : "success",
        details: enrichment as unknown as Record<string, unknown>
      });
    }

    activeStage = "normalization";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const normalization = await dedupe.runForIngestionRun(runId);
      await stageStatus.complete({
        runId,
        attempt: activeAttempt!,
        stage: activeStage,
        details: {
          runId: normalization.runId,
          inputCount: normalization.inputCount,
          canonicalCount: normalization.canonicalCount,
          mergedCount: normalization.mergedCount
        }
      });
    }

    activeStage = "representation";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const labels = await summarize.generateLabelsForRun({ runId });
      await stageStatus.complete({
        runId,
        attempt: activeAttempt!,
        stage: activeStage,
        status: labels.failed > 0 ? "partial" : "success",
        details: { requested: labels.requested, generated: labels.generated, failed: labels.failed }
      });
    }

    activeStage = "recall";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const recallResult = await recall.runRecall({ runId });
      await stageStatus.complete({ runId, attempt: activeAttempt!, stage: activeStage, details: { recallRunId: recallResult.run.id } });
    }

    activeStage = "rerank";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const rerankResult = await rerank.runRerank({ runId, topN: recommendationLimit });
      await stageStatus.complete({
        runId,
        attempt: activeAttempt!,
        stage: activeStage,
        details: {
          rerankRunId: rerankResult.run.id,
          recommendationLimit
        }
      });
    }

    activeStage = "summary";
    if (shouldRun(activeStage)) {
      await stageStatus.start({ runId, attempt: activeAttempt!, stage: activeStage });
      const summaries = await summarize.generateSummariesForRun({
        runId,
        limit: recommendationLimit,
        selectedOnly: true
      });
      await stageStatus.complete({
        runId,
        attempt: activeAttempt!,
        stage: activeStage,
        status: summaries.failed > 0 ? "partial" : "success",
        details: { requested: summaries.requested, generated: summaries.generated, failed: summaries.failed }
      });
    }

    persistedStages = await stageStatus.list(runId);
    const conclusion = concludeDailyPipeline(persistedStages);
    pipelineStatus = conclusion.status;
    await ingestion.setPipelineOutcome({ runId, attempt: activeAttempt!, status: conclusion.status });

    logger.info("Scheduler daily aggregated pipeline succeeded", {
      runId,
      sourceCount: sourceSummaries.length
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown scheduler daily error";
    logger.error("Scheduler daily aggregated pipeline failed", {
      sources: sourceList,
      errorMessage
    });
    const errorRunId = activeRunId ?? extractRunId(error);
    const alreadyRunningSummary = async (): Promise<DailyPipelineRunSummary> => {
      const currentRun = errorRunId ? await ingestion.getRun(errorRunId) : null;
      const stages = errorRunId ? await stageStatus.list(errorRunId) : [];
      const terminalStatus = asTerminalPipelineOutcome(currentRun?.pipelineStatus);
      if (terminalStatus) {
        const conclusion = concludeDailyPipeline(stages);
        const sourceSummaries = sourceSummariesFromStages(stages) ?? [];
        return {
          status: terminalStatus,
          disposition: terminalStatus === "complete" || terminalStatus === "complete_with_warnings"
            ? "already_succeeded"
            : "resumed",
          runId: errorRunId,
          failedStage: conclusion.failedStage,
          retryable: conclusion.retryable,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          runDate: input?.runDate,
          sources: sourceSummaries.map((entry) => ({
            source: entry.source,
            ...(entry.status === "failed" ? {} : { runId: errorRunId }),
            status: entry.status ?? "success",
            ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {})
          })),
          stages
        };
      }
      return {
        status: "running",
        disposition: "already_running",
        runId: errorRunId,
        retryable: false,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        runDate: input?.runDate,
        sources: [],
        stages
      };
    };
    if (
      (error instanceof AppError && error.code === "DAILY_RUN_ALREADY_RUNNING") ||
      isPipelineLeaseLost(error)
    ) {
      return {
        ...await alreadyRunningSummary()
      } satisfies DailyPipelineRunSummary;
    }
    if (errorRunId) {
      if (activeRunId && activeAttempt !== undefined) {
        try {
          await stageStatus.fail({
            runId: errorRunId,
            attempt: activeAttempt,
            stage: activeStage,
            errorMessage
          });
        } catch (stageError) {
          if (isPipelineLeaseLost(stageError)) {
            return { ...await alreadyRunningSummary() } satisfies DailyPipelineRunSummary;
          }
          throw stageError;
        }
      }
      persistedStages = await stageStatus.list(errorRunId);
      activeRunId = errorRunId;
    }
    const conclusion = concludeDailyPipeline(persistedStages);
    pipelineStatus = conclusion.status;
    if (activeRunId && activeAttempt !== undefined) {
      try {
        await ingestion.setPipelineOutcome({
          runId: activeRunId,
          attempt: activeAttempt,
          status: conclusion.status
        });
      } catch (outcomeError) {
        if (isPipelineLeaseLost(outcomeError)) {
          return { ...await alreadyRunningSummary() } satisfies DailyPipelineRunSummary;
        }
        throw outcomeError;
      }
    }

    if (results.length === 0) {
      results = sourceList.map((source) => ({ source, status: "failed", errorMessage }));
    }
  }

  const conclusion = concludeDailyPipeline(persistedStages);

  return {
    status: pipelineStatus,
    disposition,
    runId: activeRunId,
    failedStage: conclusion.failedStage ?? (pipelineStatus === "failed" ? activeStage : undefined),
    retryable: conclusion.retryable,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    runDate: input?.runDate,
    sources: results,
    stages: persistedStages
  } satisfies DailyPipelineRunSummary;
}

function recommendationLimitFromStages(stages: DailyPipelineStageRecord[]): number | undefined {
  const persistedLimit = stages.find((stage) => stage.stage === "rerank")
    ?.details?.recommendationLimit;

  return isRecommendationLimit(persistedLimit) ? persistedLimit : undefined;
}

function isRecommendationLimit(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 30;
}

function extractRunId(error: unknown) {
  const runId = error instanceof AppError ? error.details?.runId : undefined;
  return typeof runId === "string" ? runId : undefined;
}

function sourceSummariesFromStages(stages: DailyPipelineStageRecord[]) {
  const sources = stages.find((stage) => stage.stage === "ingestion")?.details?.sources;
  if (!Array.isArray(sources)) return undefined;
  const validSources = new Set<DailySchedulerSource>(["biorxiv", "arxiv", "pubmed", "journal"]);
  return sources.flatMap((entry): AggregatedSourceIngestionSummary[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.source !== "string" || !validSources.has(value.source as DailySchedulerSource)) return [];
    return [{
      source: value.source as DailySchedulerSource,
      status: value.status === "failed" ? "failed" : "success",
      candidatesCount: typeof value.candidatesCount === "number" ? value.candidatesCount : 0,
      fetchedCount: typeof value.fetchedCount === "number" ? value.fetchedCount : undefined,
      filteredCount: typeof value.filteredCount === "number" ? value.filteredCount : undefined,
      windowStart: typeof value.windowStart === "string" ? value.windowStart : undefined,
      windowEnd: typeof value.windowEnd === "string" ? value.windowEnd : undefined,
      filterMode:
        value.filterMode === "indexed_day" || value.filterMode === "watermark" || value.filterMode === "first_seen"
          ? value.filterMode
          : undefined,
      errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined
    }];
  });
}

function isPipelineLeaseLost(error: unknown) {
  return error instanceof Error && /pipeline lease was lost/i.test(error.message);
}

function asTerminalPipelineOutcome(value: string | undefined): DailyPipelineOutcome | undefined {
  return value === "complete" ||
    value === "complete_with_warnings" ||
    value === "partial" ||
    value === "failed"
    ? value
    : undefined;
}
