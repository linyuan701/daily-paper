import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";

const mocks = vi.hoisted(() => ({
  runAggregatedIngestion: vi.fn(),
  getRun: vi.fn(),
  setPipelineOutcome: vi.fn(),
  failRun: vi.fn(),
  enrichRun: vi.fn(),
  runForIngestionRun: vi.fn(),
  generateLabelsForRun: vi.fn(),
  generateSummariesForRun: vi.fn(),
  runRecall: vi.fn(),
  runRerank: vi.fn(),
  getLatestRerankRun: vi.fn(),
  initializeStages: vi.fn(),
  startStage: vi.fn(),
  completeStage: vi.fn(),
  failStage: vi.fn(),
  listStages: vi.fn(),
  getEnv: vi.fn()
}));

vi.mock("../../lib/config", () => ({
  getEnv: mocks.getEnv
}));

vi.mock("../ingestion", () => ({
  createDailyIngestionService: () => ({
    runAggregatedIngestion: mocks.runAggregatedIngestion,
    getRun: mocks.getRun,
    setPipelineOutcome: mocks.setPipelineOutcome,
    failRun: mocks.failRun
  })
}));

vi.mock("../candidate-enrich", () => ({
  createJournalEnrichmentService: () => ({
    enrichRun: mocks.enrichRun
  })
}));

vi.mock("../normalize-dedupe", () => ({
  createCandidateNormalizationService: () => ({
    runForIngestionRun: mocks.runForIngestionRun
  })
}));

vi.mock("../summary", () => ({
  createCandidateOutputService: () => ({
    generateLabelsForRun: mocks.generateLabelsForRun,
    generateSummariesForRun: mocks.generateSummariesForRun
  })
}));

vi.mock("../ranking/recall", () => ({
  createRecallRankingService: () => ({
    runRecall: mocks.runRecall
  })
}));

vi.mock("../ranking/rerank", () => ({
  createRerankService: () => ({
    runRerank: mocks.runRerank,
    getLatestRerankRun: mocks.getLatestRerankRun
  })
}));

vi.mock("../pipeline-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline-status")>();
  return {
    ...actual,
    createPipelineStageService: () => ({
      initialize: mocks.initializeStages,
      start: mocks.startStage,
      complete: mocks.completeStage,
      fail: mocks.failStage,
      list: mocks.listStages
    })
  };
});

import { runDailyRecommendationPipeline } from "./daily-pipeline";

describe("runDailyRecommendationPipeline", () => {
  beforeEach(() => {
    mocks.runAggregatedIngestion.mockReset();
    mocks.getRun.mockReset();
    mocks.setPipelineOutcome.mockReset();
    mocks.failRun.mockReset();
    mocks.enrichRun.mockReset();
    mocks.runForIngestionRun.mockReset();
    mocks.generateLabelsForRun.mockReset();
    mocks.generateSummariesForRun.mockReset();
    mocks.runRecall.mockReset();
    mocks.runRerank.mockReset();
    mocks.getLatestRerankRun.mockReset();
    mocks.getLatestRerankRun.mockResolvedValue(null);
    mocks.initializeStages.mockReset();
    mocks.startStage.mockReset();
    mocks.completeStage.mockReset();
    mocks.failStage.mockReset();
    mocks.listStages.mockReset();
    mocks.getEnv.mockReset();
    mocks.getEnv.mockReturnValue({ DAILY_RECOMMENDATION_LIMIT: 20 });
    mocks.enrichRun.mockResolvedValue({ processed: 0, enriched: 0, notFound: 0, failed: 0 });
    mocks.runForIngestionRun.mockResolvedValue({ canonicalCount: 0 });
    mocks.generateLabelsForRun.mockResolvedValue({ requested: 0, generated: 0, failed: 0 });
    mocks.generateSummariesForRun.mockResolvedValue({ requested: 0, generated: 0, failed: 0 });
    mocks.runRecall.mockResolvedValue({ run: { id: "recall-1" } });
    mocks.runRerank.mockResolvedValue({ run: { id: "rerank-1" } });
    mocks.getRun.mockResolvedValue(null);
    mocks.listStages.mockResolvedValue([
      { stage: "ingestion", status: "success" },
      { stage: "enrichment", status: "success" },
      { stage: "normalization", status: "success" },
      { stage: "representation", status: "success" },
      { stage: "recall", status: "success" },
      { stage: "rerank", status: "success" },
      { stage: "summary", status: "success" }
    ]);
  });

  it.each([1, 20, 30])("uses configured final selection limit %i without shrinking recall", async (limit) => {
    mocks.getEnv.mockReturnValue({ DAILY_RECOMMENDATION_LIMIT: limit });
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: `run-limit-${limit}`, attempt: 1 },
      disposition: "acquired",
      sourceSummaries: [{ source: "pubmed", candidatesCount: 100 }]
    });

    await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(mocks.runRecall).toHaveBeenCalledWith({ runId: `run-limit-${limit}` });
    expect(mocks.runRerank).toHaveBeenCalledWith({ runId: `run-limit-${limit}`, topN: limit });
    expect(mocks.completeStage).toHaveBeenCalledWith({
      runId: `run-limit-${limit}`,
      attempt: 1,
      stage: "rerank",
      details: { rerankRunId: "rerank-1", recommendationLimit: limit }
    });
    expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
      runId: `run-limit-${limit}`,
      limit,
      selectedOnly: true
    });
  });

  it.each([
    { persistedLimit: 30, configuredLimit: 1 },
    { persistedLimit: 1, configuredLimit: 30 }
  ])(
    "keeps a run's selected limit at $persistedLimit when configuration changes to $configuredLimit before summary resume",
    async ({ persistedLimit, configuredLimit }) => {
      mocks.getEnv.mockReturnValue({ DAILY_RECOMMENDATION_LIMIT: configuredLimit });
      mocks.runAggregatedIngestion.mockResolvedValue({
        run: { id: "run-resume-limit", attempt: 2 },
        disposition: "pipeline_acquired",
        sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 100 }]
      });
      mocks.listStages
        .mockResolvedValueOnce([
          { stage: "ingestion", status: "success" },
          { stage: "enrichment", status: "success" },
          { stage: "normalization", status: "success" },
          { stage: "representation", status: "success" },
          { stage: "recall", status: "success" },
          {
            stage: "rerank",
            status: "success",
            details: { rerankRunId: "rerank-existing", recommendationLimit: persistedLimit }
          },
          { stage: "summary", status: "partial" }
        ])
        .mockResolvedValueOnce([
          { stage: "ingestion", status: "success" },
          { stage: "enrichment", status: "success" },
          { stage: "normalization", status: "success" },
          { stage: "representation", status: "success" },
          { stage: "recall", status: "success" },
          {
            stage: "rerank",
            status: "success",
            details: { rerankRunId: "rerank-existing", recommendationLimit: persistedLimit }
          },
          { stage: "summary", status: "success" }
        ]);

      await runDailyRecommendationPipeline({ sources: ["pubmed"] });

      expect(mocks.runRerank).not.toHaveBeenCalled();
      expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
        runId: "run-resume-limit",
        limit: persistedLimit,
        selectedOnly: true
      });
    }
  );

  it("recovers the selected limit from a successful rerank for an in-flight pre-upgrade run", async () => {
    mocks.getEnv.mockReturnValue({ DAILY_RECOMMENDATION_LIMIT: 1 });
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-pre-upgrade", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 100 }]
    });
    mocks.getLatestRerankRun.mockResolvedValue({
      run: { status: "success", requestedTopN: 30 },
      results: []
    });
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "success" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success", details: { rerankRunId: "rerank-existing" } },
        { stage: "summary", status: "partial" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "success" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success", details: { rerankRunId: "rerank-existing" } },
        { stage: "summary", status: "success" }
      ]);

    await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(mocks.getLatestRerankRun).toHaveBeenCalledWith("run-pre-upgrade");
    expect(mocks.runRerank).not.toHaveBeenCalled();
    expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
      runId: "run-pre-upgrade",
      limit: 30,
      selectedOnly: true
    });
  });

  it("runs aggregated ingestion and downstream stages once", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 1 },
      disposition: "acquired",
      sourceSummaries: [{ source: "arxiv", candidatesCount: 2 }]
    });

    const result = await runDailyRecommendationPipeline({
      sources: ["arxiv"]
    });

    expect(mocks.runAggregatedIngestion).toHaveBeenCalledWith({
      runDate: undefined,
      sources: ["arxiv"]
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].status).toBe("success");
    expect(result.sources[0].runId).toBe("run-1");
    expect(result.status).toBe("complete");
    expect(result.retryable).toBe(false);
    expect(mocks.enrichRun).toHaveBeenCalledWith("run-1");
    expect(mocks.runForIngestionRun).toHaveBeenCalledWith("run-1");
    expect(mocks.startStage).toHaveBeenCalledTimes(6);
    expect(mocks.runRecall).toHaveBeenCalledWith({ runId: "run-1" });
    expect(mocks.runRerank).toHaveBeenCalledWith({ runId: "run-1", topN: 20 });
    expect(mocks.generateLabelsForRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
      runId: "run-1",
      limit: 20,
      selectedOnly: true
    });
    expect(mocks.generateLabelsForRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runRecall.mock.invocationCallOrder[0]
    );
    expect(mocks.runRecall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runRerank.mock.invocationCallOrder[0]
    );
    expect(mocks.runRerank.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generateSummariesForRun.mock.invocationCallOrder[0]
    );
  });

  it("preserves per-source failures from partial aggregated ingestion", async () => {
    mocks.listStages.mockResolvedValue([
      { stage: "ingestion", status: "partial" },
      { stage: "enrichment", status: "success" },
      { stage: "normalization", status: "success" },
      { stage: "representation", status: "success" },
      { stage: "recall", status: "success" },
      { stage: "rerank", status: "success" },
      { stage: "summary", status: "success" }
    ]);
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 1 },
      disposition: "acquired",
      sourceSummaries: [
        {
          source: "biorxiv",
          status: "failed",
          candidatesCount: 0,
          errorMessage: "bioRxiv unavailable"
        },
        { source: "pubmed", status: "success", candidatesCount: 10 }
      ]
    });

    const result = await runDailyRecommendationPipeline({
      sources: ["biorxiv", "pubmed"]
    });

    expect(result.sources).toEqual([
      {
        source: "biorxiv",
        status: "failed",
        errorMessage: "bioRxiv unavailable"
      },
      {
        source: "pubmed",
        runId: "run-1",
        status: "success"
      }
    ]);
    expect(mocks.enrichRun).toHaveBeenCalledWith("run-1");
    expect(mocks.runForIngestionRun).toHaveBeenCalledWith("run-1");
    expect(result.status).toBe("complete_with_warnings");
    expect(result.disposition).toBe("executed");
    expect(mocks.initializeStages).not.toHaveBeenCalled();
  });

  it("reuses a completed persistent run without duplicating downstream stages", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-existing", attempt: 1 },
      disposition: "already_succeeded",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.listStages.mockResolvedValue([
      { stage: "ingestion", status: "success" },
      { stage: "enrichment", status: "success" },
      { stage: "normalization", status: "success" },
      { stage: "representation", status: "success" },
      { stage: "recall", status: "success" },
      { stage: "rerank", status: "success" },
      { stage: "summary", status: "success" }
    ]);

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result.sources[0]).toMatchObject({ source: "pubmed", runId: "run-existing", status: "success" });
    expect(result.status).toBe("complete");
    expect(result.disposition).toBe("already_succeeded");
    expect(mocks.enrichRun).not.toHaveBeenCalled();
    expect(mocks.runForIngestionRun).not.toHaveBeenCalled();
    expect(mocks.runRecall).not.toHaveBeenCalled();
    expect(mocks.runRerank).not.toHaveBeenCalled();
  });

  it("resumes from the first partial downstream stage", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-existing", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "partial" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "partial" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success" },
        { stage: "summary", status: "partial" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "partial" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success" },
        { stage: "summary", status: "success" }
      ]);

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result.status).toBe("complete_with_warnings");
    expect(result.disposition).toBe("resumed");
    expect(mocks.enrichRun).not.toHaveBeenCalled();
    expect(mocks.runForIngestionRun).not.toHaveBeenCalled();
    expect(mocks.generateLabelsForRun).toHaveBeenCalledWith({ runId: "run-existing" });
    expect(mocks.runRecall).toHaveBeenCalled();
    expect(mocks.runRerank).toHaveBeenCalled();
    expect(mocks.generateSummariesForRun).toHaveBeenCalled();
  });

  it("keeps successful ingestion reusable when a downstream stage fails", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 1 },
      disposition: "acquired",
      sourceSummaries: [{ source: "arxiv", status: "success", candidatesCount: 2 }]
    });
    mocks.enrichRun.mockRejectedValueOnce(new Error("enrichment failed"));
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "pending" },
        { stage: "normalization", status: "pending" },
        { stage: "representation", status: "pending" },
        { stage: "recall", status: "pending" },
        { stage: "rerank", status: "pending" },
        { stage: "summary", status: "pending" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "failed" },
        { stage: "normalization", status: "skipped" },
        { stage: "representation", status: "skipped" },
        { stage: "recall", status: "skipped" },
        { stage: "rerank", status: "skipped" },
        { stage: "summary", status: "skipped" }
      ]);

    const result = await runDailyRecommendationPipeline({ sources: ["arxiv"] });

    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(result.sources[0]).toMatchObject({ source: "arxiv", status: "success" });
    expect(result).toMatchObject({ status: "failed", failedStage: "enrichment", retryable: true });
    expect(mocks.failStage).toHaveBeenCalledWith({
      runId: "run-1",
      attempt: 1,
      stage: "enrichment",
      errorMessage: "enrichment failed"
    });
  });

  it("resumes a persisted hard failure without rerunning successful ingestion", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-existing", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "success" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "failed" },
        { stage: "recall", status: "skipped" },
        { stage: "rerank", status: "skipped" },
        { stage: "summary", status: "skipped" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "success" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success" },
        { stage: "summary", status: "success" }
      ]);

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result.status).toBe("complete");
    expect(mocks.enrichRun).not.toHaveBeenCalled();
    expect(mocks.runForIngestionRun).not.toHaveBeenCalled();
    expect(mocks.generateLabelsForRun).toHaveBeenCalledWith({ runId: "run-existing" });
    expect(mocks.runRecall).toHaveBeenCalledWith({ runId: "run-existing" });
    expect(mocks.runRerank).toHaveBeenCalledWith({ runId: "run-existing", topN: 20 });
    expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
      runId: "run-existing",
      limit: 20,
      selectedOnly: true
    });
  });

  it("resumes a failed normalization for the same run without rerunning ingestion or enrichment", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-normalization-retry", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 1_000 }]
    });
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "partial" },
        { stage: "normalization", status: "failed" },
        { stage: "representation", status: "skipped" },
        { stage: "recall", status: "skipped" },
        { stage: "rerank", status: "skipped" },
        { stage: "summary", status: "skipped" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "partial" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success" },
        { stage: "summary", status: "success" }
      ]);

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result).toMatchObject({
      runId: "run-normalization-retry",
      status: "complete_with_warnings",
      disposition: "resumed",
      retryable: false
    });
    expect(mocks.enrichRun).not.toHaveBeenCalled();
    expect(mocks.runForIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.runForIngestionRun).toHaveBeenCalledWith("run-normalization-retry");
    expect(mocks.generateLabelsForRun).toHaveBeenCalledWith({ runId: "run-normalization-retry" });
    expect(mocks.runRecall).toHaveBeenCalledWith({ runId: "run-normalization-retry" });
    expect(mocks.runRerank).toHaveBeenCalledWith({ runId: "run-normalization-retry", topN: 20 });
    expect(mocks.generateSummariesForRun).toHaveBeenCalledWith({
      runId: "run-normalization-retry",
      limit: 20,
      selectedOnly: true
    });
  });

  it("returns already-running without presenting the trigger as retryable", async () => {
    mocks.runAggregatedIngestion.mockRejectedValue(
      new AppError("DAILY_RUN_ALREADY_RUNNING", "run active", 409, { runId: "run-active" })
    );

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result).toMatchObject({
      status: "running",
      disposition: "already_running",
      runId: "run-active",
      retryable: false
    });
    expect(mocks.failRun).not.toHaveBeenCalled();
  });

  it("reports a pre-acquisition repository failure instead of completing an empty pipeline", async () => {
    mocks.runAggregatedIngestion.mockRejectedValue(new Error("database unavailable"));

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result).toMatchObject({
      status: "failed",
      disposition: "executed",
      failedStage: "ingestion",
      retryable: true
    });
    expect(result.sources).toEqual([{
      source: "pubmed",
      status: "failed",
      errorMessage: "database unavailable"
    }]);
    expect(mocks.failRun).not.toHaveBeenCalled();
    expect(mocks.failStage).not.toHaveBeenCalled();
    expect(mocks.setPipelineOutcome).not.toHaveBeenCalled();
  });

  it("returns already-running when a stale attempt loses the downstream lease", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.listStages.mockResolvedValueOnce([
      { stage: "ingestion", status: "success" },
      { stage: "enrichment", status: "failed" },
      { stage: "normalization", status: "skipped" },
      { stage: "representation", status: "skipped" },
      { stage: "recall", status: "skipped" },
      { stage: "rerank", status: "skipped" },
      { stage: "summary", status: "skipped" }
    ]);
    mocks.startStage.mockRejectedValueOnce(
      new Error("Daily pipeline lease was lost before stage update")
    );

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result).toMatchObject({
      runId: "run-1",
      status: "running",
      disposition: "already_running",
      retryable: false
    });
    expect(mocks.enrichRun).not.toHaveBeenCalled();
    expect(mocks.failStage).not.toHaveBeenCalled();
  });

  it("reports the winner's terminal status when a lost lease has already completed", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 2 },
      disposition: "pipeline_acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "failed" },
        { stage: "normalization", status: "skipped" },
        { stage: "representation", status: "skipped" },
        { stage: "recall", status: "skipped" },
        { stage: "rerank", status: "skipped" },
        { stage: "summary", status: "skipped" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "success" },
        { stage: "normalization", status: "success" },
        { stage: "representation", status: "success" },
        { stage: "recall", status: "success" },
        { stage: "rerank", status: "success" },
        { stage: "summary", status: "success" }
      ]);
    mocks.startStage.mockRejectedValueOnce(
      new Error("Daily pipeline lease was lost before stage update")
    );
    mocks.getRun.mockResolvedValue({
      id: "run-1",
      attempt: 3,
      pipelineStatus: "complete"
    });

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(result).toMatchObject({
      runId: "run-1",
      status: "complete",
      disposition: "already_succeeded",
      retryable: false
    });
    expect(mocks.getRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listStages.mock.invocationCallOrder[1]
    );
  });

  it("records a stage failure when starting that stage fails before its transition", async () => {
    mocks.runAggregatedIngestion.mockResolvedValue({
      run: { id: "run-1", attempt: 1 },
      disposition: "acquired",
      sourceSummaries: [{ source: "pubmed", status: "success", candidatesCount: 10 }]
    });
    mocks.startStage.mockRejectedValueOnce(new Error("database write unavailable"));
    mocks.listStages
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "pending" },
        { stage: "normalization", status: "pending" },
        { stage: "representation", status: "pending" },
        { stage: "recall", status: "pending" },
        { stage: "rerank", status: "pending" },
        { stage: "summary", status: "pending" }
      ])
      .mockResolvedValueOnce([
        { stage: "ingestion", status: "success" },
        { stage: "enrichment", status: "failed" },
        { stage: "normalization", status: "skipped" },
        { stage: "representation", status: "skipped" },
        { stage: "recall", status: "skipped" },
        { stage: "rerank", status: "skipped" },
        { stage: "summary", status: "skipped" }
      ]);

    const result = await runDailyRecommendationPipeline({ sources: ["pubmed"] });

    expect(mocks.failStage).toHaveBeenCalledWith({
      runId: "run-1",
      attempt: 1,
      stage: "enrichment",
      errorMessage: "database write unavailable"
    });
    expect(result).toMatchObject({
      status: "failed",
      failedStage: "enrichment",
      retryable: true
    });
  });
});
