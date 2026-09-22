import type { OperationsRun } from "../operations/types";
import { sanitizeOperationsError } from "../operations/sanitize";
import type { ProfileSnapshotSummary } from "../profile-build/types";
import type { FeedbackLogRecord } from "../feedback/types";
import { readPersistedFeedbackEvidence } from "./persisted-feedback-evidence";
import type { RecallRunOutput, RecallRunSummary } from "../ranking/recall/types";
import type { RerankRunOutput, RerankRunSummary } from "../ranking/rerank/types";
import type { DailyRecommendationFeed, DailyRecommendationRecord } from "../ranking/explain/types";

export type DashboardProfileRecord = { snapshot: ProfileSnapshotSummary; summaryJson: unknown };

export type SiteDashboardReads = {
  listRuns(): Promise<OperationsRun[]>;
  getProfile(id?: string): Promise<DashboardProfileRecord | null>;
  listFeedback(): Promise<FeedbackLogRecord[]>;
  getRecall(runId: string): Promise<RecallRunOutput | null>;
  getRerank(runId: string): Promise<RerankRunOutput | null>;
  getFeed(runId: string): Promise<DailyRecommendationFeed | null>;
};

/** Reads stored outputs only. A timestamp is an observation time, not a data refresh. */
export async function readSiteDashboard(reads: SiteDashboardReads, now = () => new Date()) {
  const [storedRuns, active, logs] = await settleReads([
    reads.listRuns(), reads.getProfile(), reads.listFeedback()
  ]);
  const runs = storedRuns.slice(0, 10);
  const current = runs[0] ?? null;
  const [recall, rerank, feed] = current ? await settleReads([
    reads.getRecall(current.runId), reads.getRerank(current.runId), reads.getFeed(current.runId)
  ]) : [null, null, null];
  const profile = active ? projectProfile(active) : null;
  const rankingProfileId = rerank?.run.runId === current?.runId
    ? rerank?.run.profileSnapshotId : null;
  const rankingRecord = rankingProfileId
    ? (active?.snapshot.id === rankingProfileId ? active : await reads.getProfile(rankingProfileId))
    : null;
  const rankingProfile = rankingRecord ? projectProfile(rankingRecord) : null;
  const recallStage = current?.stages.find((stage) => stage.stage === "recall");
  const rerankStage = current?.stages.find((stage) => stage.stage === "rerank");
  const runFinished = current && ["complete", "complete_with_warnings", "partial"].includes(current.status);
  const linkMatches = Boolean(current && recall && rerank && feed &&
    runFinished && recallStage?.status === "success" && rerankStage?.status === "success" &&
    recallStage.details?.recallRunId === recall.run.id &&
    recallStage.details?.recallProfileSnapshotId === recall.run.profileSnapshotId &&
    rerankStage.details?.rerankRunId === rerank.run.id &&
    recall.run.runId === current.runId && rerank.run.runId === current.runId && feed.runId === current.runId &&
    feed.rerankRunId === rerank.run.id && rerank.run.recallRunId === recall.run.id &&
    recall.run.profileSnapshotId === rerank.run.profileSnapshotId &&
    recall.run.status === "success" && rerank.run.status === "success" &&
    // Ingestion retry replaces startedAt. Pipeline retry does not, so the persisted
    // successful stage links and terminal run status above are also required.
    Date.parse(recall.run.startedAt) >= Date.parse(current.startedAt) &&
    Date.parse(rerank.run.startedAt) >= Date.parse(current.startedAt) &&
    feed.generatedAt === rerank.run.startedAt);
  const selected = feed?.recommendations.filter((item) => item.selected)
    .sort((a, b) => a.rank - b.rank).slice(0, 20) ?? [];
  const itemsMatch = selected.every((item) => {
    const ranked = rerank?.results.find((row) => row.candidateId === item.candidateId);
    return ranked?.selected && ranked.rank === item.rank && ranked.scores.finalScore === item.finalScore &&
      recall?.results.some((row) => row.candidateId === item.candidateId && row.selected);
  });
  const recommendations = linkMatches && itemsMatch && feed && recall && rerank ? {
    runId: feed.runId,
    rerankRunId: feed.rerankRunId,
    profileSnapshotId: rerank.run.profileSnapshotId,
    generatedAt: feed.generatedAt,
    generatedAtMeaning: "rerank_started_at" as const,
    items: selected.map((item) => projectRecommendation(item, recall, rerank)),
    composition: {
      sources: countValues(selected.flatMap((item) => [...new Set(item.sources)])),
      topics: countValues(selected.map((item) => item.labels.contentRecall?.label ?? "unknown"))
    }
  } : null;

  return {
    status: "ok" as const,
    schemaVersion: 1 as const,
    observedAt: now().toISOString(),
    currentRun: current ? projectRun(current) : null,
    recentRuns: runs.map(projectRun),
    profile,
    ranking: {
      recall: recall ? { ...projectRankingRun(recall.run), recalledCount: recall.run.recalledCount } : null,
      rerank: rerank ? {
        ...projectRankingRun(rerank.run), recallRunId: rerank.run.recallRunId,
        recommendedCount: rerank.run.recommendedCount
      } : null,
      profile: rankingProfile,
      usesActiveProfile: rankingProfile && profile ? rankingProfile.id === profile.id : null,
      recommendationLink: recommendations ? "matched" as const : "unknown" as const,
      recommendationsUnavailableReason: recommendations ? null : !current ? "no_run" as const
        : !runFinished ? "run_not_finished_or_failed" as const : "ranking_evidence_unconfirmed" as const
    },
    recommendations,
    feedback: {
      scope: "latest_100_global_logs" as const,
      limit: 100,
      possiblyTruncated: logs.length >= 100,
      latestCreatedAt: logs[0]?.createdAt ?? null,
      logs: logs.slice(0, 100).map((log) => ({
        id: log.id, runId: log.runId, candidateId: log.candidateId,
        actionType: log.actionType, createdAt: log.createdAt,
        inActiveProfileDismissSignals: signalIncludes(profile, log.id),
        inRankingProfileDismissSignals: signalIncludes(rankingProfile, log.id)
      }))
    },
    limitations: [
      "latest_database_run_is_not_proof_of_today_or_scheduled_trigger",
      "github_run_id_and_sha_not_stored",
      "reads_are_not_an_atomic_database_snapshot",
      "missing_feedback_signal_is_not_proof_of_non_consumption",
      "individual_topic_and_penalty_values_not_persisted",
      "recommendation_content_may_include_later_user_corrections"
    ]
  };
}

export type SiteDashboard = Awaited<ReturnType<typeof readSiteDashboard>>;

function projectProfile(record: DashboardProfileRecord) {
  const snapshot = record.snapshot;
  const summary = object(record.summaryJson);
  const segments = object(summary.segmentCounts);
  const integration = object(summary.feedbackIntegration);
  const negative = object(integration.negativeFeedback);
  const counts = object(integration.actionCounts);
  return {
    id: snapshot.id, status: snapshot.status, builtAt: snapshot.builtAt,
    sourceLibraryVersion: snapshot.sourceLibraryVersion ?? null, itemsCount: snapshot.itemsCount,
    segments: {
      recentCore: number(segments.recentCore), stableLongTerm: number(segments.stableLongTerm),
      background: number(segments.background)
    },
    researchTypePreferences: snapshot.researchTypePreferences.map((entry) => ({
      category: entry.category, weight: entry.weight, itemCount: entry.itemCount
    })),
    feedbackEvidence: {
      since: string(integration.since), logsConsumed: number(integration.logsConsumed),
      actionCounts: Object.fromEntries(["save", "dismiss", "promote", "label_edit", "summary_edit"]
        .map((action) => [action, number(counts[action])])),
      negativeFeedback: {
        modelVersion: string(negative.modelVersion), signalCount: number(negative.signalCount),
        maxSignals: number(negative.maxSignals), maxContributingSignals: number(negative.maxContributingSignals),
        weightPerSignal: number(negative.weightPerSignal), maxPenalty: number(negative.maxPenalty),
        // Missing storage must remain distinct from an explicitly empty model.
        signals: Array.isArray(negative.signals) ? readPersistedFeedbackEvidence(record.summaryJson) : null
      }
    }
  };
}

function signalIncludes(profile: ReturnType<typeof projectProfile> | null, logId: string): true | null {
  return profile?.feedbackEvidence.negativeFeedback.signals?.some((signal) => signal.sourceFeedbackLogId === logId)
    ? true : null;
}

function projectRun(run: OperationsRun) {
  const sourceDetails = object(run.stages.find((stage) => stage.stage === "ingestion")?.details).sources;
  const sources = Array.isArray(sourceDetails) ? sourceDetails : [];
  return {
    runId: run.runId, runDate: run.runDate, attempt: run.attempt, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    errorSummary: sanitizeOperationsError(run.errorSummary) ?? null,
    sha: null, githubRunId: null, trigger: "unknown" as const,
    stages: run.stages.map((stage) => ({
      stage: stage.stage, status: stage.status, startedAt: stage.startedAt ?? null,
      finishedAt: stage.finishedAt ?? null, error: sanitizeOperationsError(stage.error) ?? null
    })),
    sources: ["arxiv", "pubmed", "biorxiv", "journal"].map((source) => {
      const details = object(sources.find((entry) => object(entry).source === source));
      const degradation = run.sourceDegradation.sources.find((entry) => entry.source === source);
      return {
        source, status: degradation?.status ?? "unknown",
        error: sanitizeOperationsError(degradation?.error) ?? null,
        candidatesCount: number(details.candidatesCount), fetchedCount: number(details.fetchedCount),
        filteredCount: number(details.filteredCount), windowStart: string(details.windowStart),
        windowEnd: string(details.windowEnd), filterMode: string(details.filterMode),
        failureCategory: string(object(details.diagnostic).failureCategory)
      };
    })
  };
}

function projectRankingRun(run: RecallRunSummary | RerankRunSummary) {
  return {
    id: run.id, runId: run.runId, profileSnapshotId: run.profileSnapshotId, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
    requestedTopN: run.requestedTopN, candidateCount: run.candidateCount,
    error: sanitizeOperationsError(run.errorMessage) ?? null
  };
}

function projectRecommendation(item: DailyRecommendationRecord, recall: RecallRunOutput, rerank: RerankRunOutput) {
  const recallScores = recall.results.find((row) => row.candidateId === item.candidateId)!.scores;
  const scores = rerank.results.find((row) => row.candidateId === item.candidateId)!.scores;
  return {
    candidateId: item.candidateId, rank: item.rank, finalScore: item.finalScore,
    title: item.title ?? null, publishedAt: item.publishedAt ?? null, sources: item.sources,
    identifiers: {
      doi: item.identifiers.doi ?? null, pmid: item.identifiers.pmid ?? null,
      arxivId: item.identifiers.arxivId ?? null, bioRxivId: item.identifiers.bioRxivId ?? null
    },
    topic: item.labels.contentRecall?.label ?? null,
    researchType: item.labels.researchType?.category ?? null,
    summary: item.summary ? {
      researchQuestion: item.summary.researchQuestion, method: item.summary.method,
      mainFinding: item.summary.mainFinding, relevanceToUser: item.summary.relevanceToUser,
      provider: item.summary.provider, provenance: item.summary.provenance
    } : null,
    journal: item.journal ? { quartile: item.journal.quartile ?? null, impactScore: item.journal.impactScore ?? null } : null,
    reasons: {
      recall: recallScores.reasons, rerank: scores.reasons,
      topicAlignment: null, oncologyPenalty: null, dismissPenalty: null
    },
    scores: {
      recall: {
        recallScore: recallScores.recallScore, semanticScore: recallScores.semanticScore,
        tagOverlapScore: recallScores.tagOverlapScore, researchTypeScore: recallScores.researchTypeScore,
        sourceScopeScore: recallScores.sourceScopeScore
      },
      rerank: {
        finalScore: scores.finalScore, recallScore: scores.recallScore, recentCoreScore: scores.recentCoreScore,
        stableLongTermScore: scores.stableLongTermScore, highAttentionScore: scores.highAttentionScore,
        contentTagScore: scores.contentTagScore, researchTypeScore: scores.researchTypeScore,
        collectionWeightScore: scores.collectionWeightScore, sourcePriorityScore: scores.sourcePriorityScore,
        journalQualityScore: scores.journalQualityScore, userCorrectedScore: scores.userCorrectedScore,
        recencyScore: scores.recencyScore
      }
    }
  };
}

function countValues(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function settleReads<T extends unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(promises);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as T;
}
