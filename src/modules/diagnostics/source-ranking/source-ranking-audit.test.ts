import { describe, expect, it } from "vitest";

import { buildSourceRankingAudit, scoreCandidateForAblation } from "./source-ranking-audit";
import type {
  DiagnosticFeatureScores,
  JournalMetricState,
  SourceRankingCandidateSnapshot
} from "./types";

describe("buildSourceRankingAudit", () => {
  it("traces the source funnel with inclusive and fractional attribution", () => {
    const report = buildSourceRankingAudit({
      runId: "run-1",
      fetchedCounts: { pubmed: 20, biorxiv: 10, arxiv: 5, journal: 2 },
      acceptedCounts: { pubmed: 8, biorxiv: 4, arxiv: 2, journal: 1 },
      candidates: [
        candidate("a", ["pubmed"], "observed_metric", { recallRank: 1, rerankRank: 1, selected: true }),
        candidate("b", ["biorxiv"], "not_applicable_preprint", { represented: false }),
        candidate("c", ["pubmed", "arxiv"], "observed_metric", { recallRank: 2, rerankRank: 2 })
      ]
    });

    expect(report.funnel.find((stage) => stage.stage === "fetched")?.bySource.pubmed.inclusiveCount).toBe(20);
    expect(report.funnel.find((stage) => stage.stage === "fetched")?.bySource.arxiv.available).toBe(true);
    const normalized = report.funnel.find((stage) => stage.stage === "normalized");
    expect(normalized?.candidateCount).toBe(3);
    expect(normalized?.countSemantics).toBe("distinct_canonical");
    expect(normalized?.bySource.pubmed).toMatchObject({ inclusiveCount: 2, fractionalCount: 1.5 });
    expect(normalized?.bySource.arxiv).toMatchObject({ inclusiveCount: 1, fractionalCount: 0.5 });
    expect(report.funnel.find((stage) => stage.stage === "represented")?.candidateCount).toBe(2);
    expect(report.recallTop100.pubmed.fractionalCount).toBe(1.5);
    expect(report.rerankTop30.arxiv.fractionalCount).toBe(0.5);
    expect(report.finalSelected.pubmed.fractionalShare).toBe(1);
    expect(report.finalCandidates).toEqual([
      expect.objectContaining({
        candidateId: "a",
        rank: 1,
        sources: ["pubmed"],
        metricState: "observed_metric",
        metricAvailable: true,
        scores: expect.objectContaining({
          recallScore: 0,
          journalQualityScore: 0,
          requiredTopicGate: false,
          finalScore: 0
        })
      })
    ]);
    expect(report.finalCandidates[0]).not.toHaveProperty("title");
    expect(report.finalCandidates[0]).not.toHaveProperty("speciesEvidence");
  });

  it("reports feature distributions and separates metric availability states", () => {
    const report = buildSourceRankingAudit({
      runId: "run-1",
      candidates: [
        candidate("a", ["pubmed"], "observed_metric", { rerankRank: 1, selected: true, recallScore: 0.2 }),
        candidate("b", ["pubmed"], "unavailable_metric", { rerankRank: 2, recallScore: 0.4 }),
        candidate("c", ["pubmed"], "enrichment_failure", { rerankRank: 3, recallScore: 0.6 }),
        candidate("d", ["biorxiv"], "not_applicable_preprint", { rerankRank: 4 })
      ]
    });

    const pubmed = report.sourceFeatures.find((entry) => entry.source === "pubmed");
    expect(pubmed?.features.recallScore).toEqual({ count: 3, mean: 0.4, median: 0.4 });
    expect(pubmed?.journalMetricStates).toMatchObject({
      observed_metric: 1,
      unavailable_metric: 1,
      enrichment_failure: 1
    });
    expect(pubmed?.journalMetricMissingRate).toBeCloseTo(2 / 3);
    const biorxiv = report.sourceFeatures.find((entry) => entry.source === "biorxiv");
    expect(biorxiv?.journalMetricNotApplicableRate).toBe(1);
    expect(biorxiv?.journalMetricMissingRate).toBeUndefined();
  });

  it("runs all four journal-quality ablations without changing other features", () => {
    const observed = candidate("observed", ["pubmed"], "observed_metric", {
      rerankRank: 1,
      selected: true,
      recallScore: 0.4,
      journalQualityScore: 1,
      finalScore: 0.148,
      title: "Human cancer cohort"
    });
    const missing = candidate("missing", ["biorxiv"], "not_applicable_preprint", {
      rerankRank: 2,
      recallScore: 0.6,
      journalQualityScore: 0,
      finalScore: 0.132,
      title: "Cross-species cattle genomics"
    });
    const report = buildSourceRankingAudit({ runId: "run-1", candidates: [observed, missing] }, { topN: 1 });

    expect(scoreCandidateForAblation(observedWithRerank(observed), "current")).toBe(0.148);
    expect(report.scoreReproductionDrift).toEqual({ count: 2, mean: 0, median: 0 });
    expect(report.ablationReliability).toEqual({
      candidateCount: 2,
      saturatedCandidateCount: 0,
      scoreReproductionOutlierCount: 0,
      baselineSelectionMismatchCount: 0,
      baselineMatchesPersistedSelection: true,
      journalDeltaExactForUnsaturatedScores: true
    });
    expect(report.ablation.find((entry) => entry.scenario === "current")?.topCandidateIds).toEqual(["observed"]);
    expect(report.ablation.find((entry) => entry.scenario === "journal_quality_zero")?.topCandidateIds).toEqual(["missing"]);
    expect(report.ablation.find((entry) => entry.scenario === "journal_quality_half")?.topCandidateIds).toEqual(["missing"]);
    expect(report.ablation.find((entry) => entry.scenario === "missing_quality_neutral")?.topCandidateIds).toEqual(["missing"]);
    expect(report.ablation.find((entry) => entry.scenario === "journal_quality_zero")?.entrants).toEqual(["missing"]);
  });

  it("uses persisted selection as current and flags a stale score snapshot", () => {
    const selected = candidate("selected", ["biorxiv"], "not_applicable_preprint", {
      rerankRank: 1,
      selected: true,
      finalScore: 0.2
    });
    const rescoredHigher = candidate("rescored-higher", ["journal"], "observed_metric", {
      rerankRank: 2,
      finalScore: 0.8
    });

    const report = buildSourceRankingAudit(
      { runId: "stale-run", candidates: [selected, rescoredHigher] },
      { topN: 1 }
    );

    expect(report.ablation.find((entry) => entry.scenario === "current")?.topCandidateIds).toEqual(["selected"]);
    expect(report.ablationReliability).toMatchObject({
      baselineSelectionMismatchCount: 1,
      baselineMatchesPersistedSelection: false
    });
  });

  it("rejects duplicate candidates and invalid topN", () => {
    const duplicate = candidate("same", ["pubmed"], "observed_metric", {});
    expect(() => buildSourceRankingAudit({ runId: "run", candidates: [duplicate, duplicate] }))
      .toThrow("Duplicate diagnostic candidateId");
    expect(() => buildSourceRankingAudit({ runId: "run", candidates: [] }, { topN: 0 }))
      .toThrow("positive integer");
    const invalid = candidate("invalid", ["pubmed"], "observed_metric", { rerankRank: 1 });
    invalid.rerank!.features.finalScore = undefined as unknown as number;
    expect(() => buildSourceRankingAudit({ runId: "run", candidates: [invalid] }))
      .toThrow("finalScore must be a finite number");
    const invalidWeight = candidate("invalid-weight", ["pubmed"], "observed_metric", { rerankRank: 1 });
    invalidWeight.rerank!.featureWeights.journalQualityScore = undefined as unknown as number;
    expect(() => buildSourceRankingAudit({ runId: "run", candidates: [invalidWeight] }))
      .toThrow("journalQualityScore must be a finite number");
  });
});

function candidate(
  candidateId: string,
  sources: SourceRankingCandidateSnapshot["sources"],
  metricState: JournalMetricState,
  options: {
    represented?: boolean;
    recallRank?: number;
    rerankRank?: number;
    selected?: boolean;
    recallScore?: number;
    journalQualityScore?: number;
    finalScore?: number;
    title?: string;
  }
): SourceRankingCandidateSnapshot {
  const features = featureScores({
    recallScore: options.recallScore,
    journalQualityScore: options.journalQualityScore,
    finalScore: options.finalScore
  });
  return {
    candidateId,
    sources,
    title: options.title,
    represented: options.represented ?? true,
    ...(options.recallRank ? { recall: { rank: options.recallRank, selected: options.recallRank <= 100 } } : {}),
    ...(options.rerankRank ? {
      rerank: {
        rank: options.rerankRank,
        selected: options.selected ?? false,
        metricState,
        features,
        featureWeights: defaultFeatureWeights(),
        formulaScore: features.finalScore
      }
    } : {})
  };
}

function featureScores(overrides: Partial<DiagnosticFeatureScores>): DiagnosticFeatureScores {
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Partial<DiagnosticFeatureScores>;
  return {
    recallScore: 0,
    recentInterestScore: 0,
    stableInterestScore: 0,
    starredProfileScore: 0,
    contentTagScore: 0,
    studyTypeScore: 0,
    journalQualityScore: 0,
    freshnessScore: 0,
    requiredTopicGate: false,
    noisePenalty: 0,
    finalScore: 0,
    collectionWeightScore: 0,
    sourcePriorityScore: 0,
    userCorrectedScore: 0,
    topicHeuristicScore: 0,
    ...definedOverrides
  };
}

function defaultFeatureWeights() {
  return {
    recallScore: 0.22,
    recentInterestScore: 0.14,
    stableInterestScore: 0.1,
    starredProfileScore: 0.1,
    contentTagScore: 0.1,
    studyTypeScore: 0.08,
    journalQualityScore: 0.06,
    freshnessScore: 0.06,
    noisePenalty: -0.12,
    collectionWeightScore: 0.08,
    sourcePriorityScore: 0.08,
    userCorrectedScore: 0.08,
    topicHeuristicScore: 0.12
  };
}

function observedWithRerank(candidate: SourceRankingCandidateSnapshot) {
  if (!candidate.rerank) throw new Error("Fixture must be reranked");
  return candidate as SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> };
}
