import { describe, expect, it, vi } from "vitest";
import { readSiteDashboard, type DashboardProfileRecord, type SiteDashboardReads } from "./service";
import type { OperationsRun } from "../operations/types";
import type { RecallRunOutput } from "../ranking/recall/types";
import type { RerankRunOutput } from "../ranking/rerank/types";
import type { DailyRecommendationFeed } from "../ranking/explain/types";

function fixtures() {
  const startedAt = "2026-09-11T00:15:00.000Z";
  const rankedAt = "2026-09-11T00:30:00.000Z";
  const active: DashboardProfileRecord = {
    snapshot: { id: "profile-1", status: "active", builtAt: startedAt, itemsCount: 3,
      segments: { recentCore: 3, stableLongTerm: 0, background: 0 }, researchTypePreferences: [] },
    summaryJson: { segmentCounts: { recentCore: 3 }, privateText: "PRIVATE_LIBRARY",
      feedbackIntegration: { logsConsumed: 2, actionCounts: { dismiss: 1 }, keywordHints: ["PRIVATE_KEYWORD"],
        negativeFeedback: { modelVersion: "bounded-token-overlap-v1", signalCount: 1, signals: [{
          paperIdentityKey: "PRIVATE_IDENTITY", sourceCandidateId: "old-candidate", sourceFeedbackLogId: "dismiss-1",
          representationText: "PRIVATE_REPRESENTATION", effectiveAt: startedAt
        }] } } }
  };
  const run: OperationsRun = {
    runId: "daily-1", runDate: "2026-09-11", attempt: 1, status: "complete", startedAt, retryable: false,
    sourceDegradation: { degraded: false, sources: [{ source: "arxiv", status: "success" }] },
    stages: [{ stage: "ingestion", status: "success", details: { sources: [{ source: "arxiv", fetchedCount: 42 }],
      privateConfig: "PRIVATE_CONFIG" } },
      { stage: "recall", status: "success", details: { recallRunId: "recall-1", recallProfileSnapshotId: "profile-1" } },
      { stage: "rerank", status: "success", details: { rerankRunId: "rerank-1" } }]
  };
  const items = Array.from({ length: 23 }, (_, i) => ({ candidateId: `paper-${i}`, rank: i + 1, selected: true }));
  const recall: RecallRunOutput = {
    run: { id: "recall-1", runId: run.runId, profileSnapshotId: "profile-1", status: "success", startedAt: rankedAt,
      requestedTopN: 100, candidateCount: 100, recalledCount: 23 },
    results: items.map((item) => ({ ...item, scores: { semanticScore: 0.8, tagOverlapScore: 0.5,
      researchTypeScore: 0.6, sourceScopeScore: 1, recallScore: 0.7,
      reasons: ["domain_topic_alignment", "oncology_context_penalty", "dismiss_similarity_penalty"] } }))
  };
  const rerank: RerankRunOutput = {
    run: { id: "rerank-1", runId: run.runId, recallRunId: "recall-1", profileSnapshotId: "profile-1",
      status: "success", startedAt: rankedAt, requestedTopN: 23, candidateCount: 23, recommendedCount: 23 },
    results: items.map((item) => ({ ...item, scores: { finalScore: 0.9, recallScore: 0.7, recentCoreScore: 0.8,
      stableLongTermScore: 0.3, highAttentionScore: 0.2, contentTagScore: 0.5, researchTypeScore: 0.5,
      collectionWeightScore: 0.6, sourcePriorityScore: 1, journalQualityScore: 0.5, userCorrectedScore: 0,
      recencyScore: 1, reasons: ["dismiss_similarity_penalty_applied_in_recall"], featureWeights: {} } }))
  };
  const feed: DailyRecommendationFeed = { rerankRunId: "rerank-1", runId: run.runId, generatedAt: rankedAt,
    recommendations: items.map((item) => ({ ...item, finalScore: 0.9, title: item.candidateId,
      sources: ["arxiv", "pubmed"], identifiers: {}, labels: { contentRecall: {
        label: "genomics", provider: "stored", provenance: "generated" } }, reasons: [] })) };
  const reads = {
    listRuns: vi.fn(async () => [run]), getProfile: vi.fn(async () => active),
    listFeedback: vi.fn(async () => [{ id: "dismiss-1", runId: "old-run", candidateId: "old-candidate", actionType: "dismiss" as const,
      createdAt: startedAt, oldValue: { text: "PRIVATE_OLD" }, newValue: { text: "PRIVATE_NEW" }, metadata: { token: "PRIVATE_TOKEN" } },
      { id: "unconfirmed", runId: "old-run", candidateId: "other", actionType: "dismiss" as const, createdAt: startedAt }]),
    getRecall: vi.fn(async () => recall), getRerank: vi.fn(async () => rerank), getFeed: vi.fn(async () => feed)
  } satisfies SiteDashboardReads;
  return { reads, run, active, recall, rerank, feed };
}

describe("stored Site dashboard projection", () => {
  it("returns Top 20 and stored reasons, distinguishes observation time from data time, and strips private JSON", async () => {
    const { reads } = fixtures();
    const dashboard = await readSiteDashboard(reads, () => new Date("2026-09-12T06:00:00Z"));
    expect(Object.keys(dashboard).sort()).toEqual([
      "currentRun", "feedback", "limitations", "observedAt", "profile", "ranking", "recentRuns",
      "recommendations", "schemaVersion", "status"
    ]);
    expect(dashboard.schemaVersion).toBe(1);
    expect(Object.keys(dashboard.recommendations!.items[0]).sort()).toEqual([
      "candidateId", "finalScore", "identifiers", "journal", "publishedAt", "rank", "reasons",
      "researchType", "scores", "sources", "summary", "title", "topic"
    ]);
    expect(dashboard.currentRun).toMatchObject({ runDate: "2026-09-11", sha: null, githubRunId: null, trigger: "unknown" });
    expect(dashboard.observedAt).toBe("2026-09-12T06:00:00.000Z");
    expect(dashboard.recommendations?.generatedAt).toBe("2026-09-11T00:30:00.000Z");
    expect(dashboard.recommendations?.items).toHaveLength(20);
    expect(dashboard.recommendations?.composition).toEqual({ sources: [{ value: "arxiv", count: 20 }, { value: "pubmed", count: 20 }],
      topics: [{ value: "genomics", count: 20 }] });
    expect(dashboard.recommendations?.items[0].reasons).toMatchObject({
      recall: ["domain_topic_alignment", "oncology_context_penalty", "dismiss_similarity_penalty"],
      topicAlignment: null, oncologyPenalty: null, dismissPenalty: null
    });
    expect(dashboard.feedback.logs[0].inActiveProfileDismissSignals).toBe(true);
    expect(dashboard.feedback.logs[1].inActiveProfileDismissSignals).toBeNull();
    expect(dashboard.profile?.segments.stableLongTerm).toBeNull();
    expect(dashboard.profile?.feedbackEvidence.logsConsumed).toBe(2);
    expect(JSON.stringify(dashboard)).not.toContain("PRIVATE_");
    expect(reads.getFeed).toHaveBeenCalledWith("daily-1");
  });

  it("returns null for missing runs and profiles without looking up a historical successful feed", async () => {
    const { reads } = fixtures();
    const getProfile = vi.fn(async () => null);
    const dashboard = await readSiteDashboard({ ...reads, listRuns: async () => [], getProfile });
    expect(dashboard.currentRun).toBeNull();
    expect(dashboard.profile).toBeNull();
    expect(dashboard.recommendations).toBeNull();
    expect(dashboard.ranking.recommendationLink).toBe("unknown");
    expect(reads.getFeed).not.toHaveBeenCalled();
    expect(reads.getRecall).not.toHaveBeenCalled();
    expect(reads.getRerank).not.toHaveBeenCalled();
  });

  it.each(["run", "recall", "profile", "feed", "failed", "retry", "results"])("does not join mismatched %s evidence", async (change) => {
    const { reads, run, recall, rerank, feed } = fixtures();
    if (change === "run") recall.run.runId = "another-daily";
    if (change === "recall") rerank.run.recallRunId = "another-recall";
    if (change === "profile") recall.run.profileSnapshotId = "another-profile";
    if (change === "feed") feed.rerankRunId = "older-rerank";
    if (change === "failed") rerank.run.status = "failed";
    if (change === "retry") { run.attempt = 2; run.startedAt = "2026-09-12T00:15:00.000Z"; }
    if (change === "results") rerank.results[0].scores.finalScore = 0.1;
    expect((await readSiteDashboard(reads)).recommendations).toBeNull();
  });

  it("keeps the ranking profile's feedback evidence separate from a newer active profile", async () => {
    const { reads, active } = fixtures();
    const newer = { snapshot: { ...active.snapshot, id: "profile-2" }, summaryJson: {} };
    const getProfile = vi.fn(async (id?: string) => id ? active : newer);
    const dashboard = await readSiteDashboard({ ...reads, getProfile });
    expect(dashboard.profile?.id).toBe("profile-2");
    expect(dashboard.profile?.feedbackEvidence.logsConsumed).toBeNull();
    expect(dashboard.profile?.feedbackEvidence.negativeFeedback.signals).toBeNull();
    expect(dashboard.ranking.profile?.id).toBe("profile-1");
    expect(dashboard.ranking.usesActiveProfile).toBe(false);
    expect(dashboard.feedback.logs[0]).toMatchObject({ inActiveProfileDismissSignals: null, inRankingProfileDismissSignals: true });
    expect(getProfile).toHaveBeenCalledWith("profile-1");
  });

  it("does not attribute old rankings to a pipeline retry that keeps ingestion startedAt unchanged", async () => {
    const { reads, run } = fixtures();
    run.attempt = 2;
    run.status = "running";
    run.stages.push({ stage: "representation", status: "running" });
    const dashboard = await readSiteDashboard(reads);
    expect(dashboard.recommendations).toBeNull();
    expect(dashboard.ranking.recommendationLink).toBe("unknown");
    expect(dashboard.ranking.recommendationsUnavailableReason).toBe("run_not_finished_or_failed");
  });

  it.each(["missing", "running", "wrong-id"])("requires persisted successful stage links (%s)", async (change) => {
    const { reads, run } = fixtures();
    if (change === "missing") run.stages = [];
    if (change === "running") run.stages[1].status = "running";
    if (change === "wrong-id") run.stages[2].details = { rerankRunId: "older-rerank" };
    expect((await readSiteDashboard(reads)).recommendations).toBeNull();
  });

  it("can reuse persisted successful rankings after a summary-only resume has finished", async () => {
    const { reads, run } = fixtures();
    run.attempt = 2;
    run.stages.push({ stage: "summary", status: "success" });
    expect((await readSiteDashboard(reads)).recommendations?.items).toHaveLength(20);
  });

  it("preserves explicit zero consumption and empty dismiss signals", async () => {
    const { reads, active } = fixtures();
    active.summaryJson = { feedbackIntegration: { logsConsumed: 0, negativeFeedback: { signalCount: 0, signals: [] } } };
    const dashboard = await readSiteDashboard(reads);
    expect(dashboard.profile?.feedbackEvidence).toMatchObject({ logsConsumed: 0, negativeFeedback: { signalCount: 0, signals: [] } });
  });

  it.each([null, {}, { segmentCounts: { recentCore: 3 } }])("keeps absent legacy profile evidence unknown (%j)", async (summaryJson) => {
    const { reads, active } = fixtures();
    active.summaryJson = summaryJson;
    const dashboard = await readSiteDashboard(reads);
    expect(dashboard.profile?.feedbackEvidence).toEqual({
      since: null, logsConsumed: null,
      actionCounts: { save: null, dismiss: null, promote: null, label_edit: null, summary_edit: null },
      negativeFeedback: { modelVersion: null, signalCount: null, maxSignals: null,
        maxContributingSignals: null, weightPerSignal: null, maxPenalty: null, signals: null }
    });
    expect(dashboard.profile?.segments.stableLongTerm).toBeNull();
    expect(dashboard.feedback.logs[0].inActiveProfileDismissSignals).toBeNull();
    expect(dashboard.feedback.logs[0].inRankingProfileDismissSignals).toBeNull();
  });

  it("does not join a legacy run without persisted recallProfileSnapshotId", async () => {
    const { reads, run } = fixtures();
    run.stages[1].details = { recallRunId: "recall-1" };
    const dashboard = await readSiteDashboard(reads);
    expect(dashboard.recommendations).toBeNull();
    expect(dashboard.ranking.recommendationLink).toBe("unknown");
    expect(dashboard.ranking.recommendationsUnavailableReason).toBe("ranking_evidence_unconfirmed");
    expect(dashboard.currentRun?.runId).toBe("daily-1");
    expect(dashboard.profile?.id).toBe("profile-1");
  });

  it("does not claim a feedback log was consumed from an incomplete signal", async () => {
    const { reads, active } = fixtures();
    active.summaryJson = { feedbackIntegration: { negativeFeedback: { signals: [{
      sourceFeedbackLogId: "dismiss-1", sourceCandidateId: "old-candidate", effectiveAt: active.snapshot.builtAt,
      arbitrarySecret: "PRIVATE_SECRET"
    }] } } };
    const dashboard = await readSiteDashboard(reads);
    expect(dashboard.profile?.feedbackEvidence.negativeFeedback.signals).toEqual([]);
    expect(dashboard.feedback.logs[0].inActiveProfileDismissSignals).toBeNull();
    expect(dashboard.feedback.logs[0].inRankingProfileDismissSignals).toBeNull();
    expect(JSON.stringify(dashboard)).not.toContain("PRIVATE_");
  });

  it("finishes pending reads before surfacing an error so the client can safely be released", async () => {
    const { reads } = fixtures();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const result = readSiteDashboard({ ...reads, listRuns: async () => { throw new Error("read failed"); },
      listFeedback: async () => { await pending; return []; } });
    const settled = vi.fn();
    const caught = result.catch(settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    finish();
    await caught;
    expect(settled).toHaveBeenCalledOnce();
  });
});
