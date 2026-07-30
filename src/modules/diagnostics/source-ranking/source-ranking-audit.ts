import { classifyDiagnosticContext } from "./context-classifier";
import {
  DIAGNOSTIC_SOURCES,
  FUNNEL_STAGES,
  type AblationScenarioReport,
  type DiagnosticFeatureScores,
  type DiagnosticFeatureWeights,
  type DiagnosticSource,
  type FunnelStage,
  type FunnelStageReport,
  type JournalMetricState,
  type NumericDistribution,
  type RankingScenario,
  type SourceAttribution,
  type SourceFeatureReport,
  type SourceRankingAuditInput,
  type SourceRankingAuditReport,
  type SourceRankingCandidateSnapshot
} from "./types";

const FEATURE_KEYS: Array<keyof DiagnosticFeatureScores> = [
  "recallScore",
  "recentInterestScore",
  "stableInterestScore",
  "starredProfileScore",
  "contentTagScore",
  "studyTypeScore",
  "journalQualityScore",
  "freshnessScore",
  "requiredTopicGate",
  "noisePenalty",
  "finalScore",
  "collectionWeightScore",
  "sourcePriorityScore",
  "userCorrectedScore",
  "topicHeuristicScore"
];

const METRIC_STATES: JournalMetricState[] = [
  "observed_metric",
  "unavailable_metric",
  "enrichment_failure",
  "not_applicable_preprint",
  "unattempted_or_unknown"
];

const SCENARIOS: RankingScenario[] = [
  "current",
  "journal_quality_zero",
  "journal_quality_half",
  "missing_quality_neutral"
];

export function buildSourceRankingAudit(
  input: SourceRankingAuditInput,
  options?: { topN?: number }
): SourceRankingAuditReport {
  assertUniqueCandidates(input.candidates);
  const candidates = input.candidates.map(normalizeCandidateSources);
  const topN = normalizeTopN(options?.topN);
  const reranked = candidates.filter(hasRerank);
  const reproductionDrift = reranked.map((candidate) =>
    Math.abs(
      reproduceCurrentFormula(candidate.rerank.features, candidate.rerank.featureWeights) -
      candidate.rerank.formulaScore
    )
  );
  const saturatedCandidateCount = reranked.filter((candidate) =>
    candidate.rerank.formulaScore <= 0 || candidate.rerank.formulaScore >= 1
  ).length;
  const baselineSelectionMismatchCount = countBaselineSelectionMismatches(reranked, topN);

  return {
    runId: input.runId,
    formulaVersion: "persisted-final-score-journal-delta-v1",
    funnel: buildFunnel(input, candidates),
    sourceFeatures: buildSourceFeatures(reranked),
    recallTop100: sourceComposition(
      candidates.filter((candidate) => candidate.recall && candidate.recall.rank <= 100)
    ),
    rerankTop30: sourceComposition(
      reranked.filter((candidate) => candidate.rerank.rank <= 30)
    ),
    finalSelected: sourceComposition(
      reranked.filter((candidate) => candidate.rerank.selected)
    ),
    finalCandidates: reranked
      .filter((candidate) => candidate.rerank.selected)
      .sort((left, right) => left.rerank.rank - right.rerank.rank || left.candidateId.localeCompare(right.candidateId))
      .map((candidate) => {
        const context = classifyDiagnosticContext(candidate);
        const feature = candidate.rerank.features;
        return {
          candidateId: candidate.candidateId,
          rank: candidate.rerank.rank,
          sources: candidate.sources,
          metricState: candidate.rerank.metricState,
          metricAvailable: candidate.rerank.metricState === "observed_metric",
          speciesContext: context.speciesContext,
          researchContext: context.researchContext,
          scores: {
            recallScore: feature.recallScore,
            recentInterestScore: feature.recentInterestScore,
            stableInterestScore: feature.stableInterestScore,
            starredProfileScore: feature.starredProfileScore,
            contentTagScore: feature.contentTagScore,
            studyTypeScore: feature.studyTypeScore,
            journalQualityScore: feature.journalQualityScore,
            freshnessScore: feature.freshnessScore,
            requiredTopicGate: feature.requiredTopicGate,
            noisePenalty: feature.noisePenalty,
            finalScore: feature.finalScore
          }
        };
      }),
    scoreReproductionDrift: distribution(reproductionDrift),
    ablationReliability: {
      candidateCount: reranked.length,
      saturatedCandidateCount,
      scoreReproductionOutlierCount: reproductionDrift.filter((value) => value > 0.0001).length,
      baselineSelectionMismatchCount,
      baselineMatchesPersistedSelection: baselineSelectionMismatchCount === 0,
      journalDeltaExactForUnsaturatedScores: saturatedCandidateCount === 0
    },
    ablation: buildAblation(reranked, topN)
  };
}

function buildFunnel(
  input: SourceRankingAuditInput,
  candidates: SourceRankingCandidateSnapshot[]
): FunnelStageReport[] {
  const postNormalization: Record<Exclude<FunnelStage, "fetched" | "accepted">, SourceRankingCandidateSnapshot[]> = {
    normalized: candidates,
    represented: candidates.filter((candidate) => candidate.represented),
    recall_candidate: candidates.filter((candidate) => Boolean(candidate.recall)),
    rerank_candidate: candidates.filter(hasRerank),
    final_selected: candidates.filter(
      (candidate): candidate is SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> } =>
        Boolean(candidate.rerank?.selected)
    )
  };

  return FUNNEL_STAGES.map((stage) => {
    if (stage === "fetched" || stage === "accepted") {
      const counts = stage === "fetched" ? input.fetchedCounts : input.acceptedCounts;
      return directCountStage(stage, counts);
    }
    const stageCandidates = postNormalization[stage];
    return {
      stage,
      available: true,
      candidateCount: stageCandidates.length,
      countSemantics: "distinct_canonical",
      bySource: sourceComposition(stageCandidates)
    };
  });
}

function directCountStage(
  stage: "fetched" | "accepted",
  counts?: Partial<Record<DiagnosticSource, number>>
): FunnelStageReport {
  const normalizedCounts = Object.fromEntries(
    DIAGNOSTIC_SOURCES.map((source) => [source, normalizeCount(counts?.[source])])
  ) as Record<DiagnosticSource, number>;
  const total = sum(Object.values(normalizedCounts));
  return {
    stage,
    available: Boolean(counts),
    ...(counts ? { candidateCount: total } : {}),
    countSemantics: "source_reported_total",
    bySource: Object.fromEntries(
      DIAGNOSTIC_SOURCES.map((source) => [source, {
        available: counts ? Object.hasOwn(counts, source) : false,
        inclusiveCount: normalizedCounts[source],
        fractionalCount: normalizedCounts[source],
        fractionalShare: total > 0 ? normalizedCounts[source] / total : 0
      }])
    ) as Record<DiagnosticSource, SourceAttribution>
  };
}

function buildSourceFeatures(
  candidates: Array<SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> }>
): SourceFeatureReport[] {
  return DIAGNOSTIC_SOURCES.map((source) => {
    const sourceCandidates = candidates.filter((candidate) => candidate.sources.includes(source));
    const journalMetricStates = Object.fromEntries(
      METRIC_STATES.map((state) => [
        state,
        sourceCandidates.filter((candidate) => candidate.rerank.metricState === state).length
      ])
    ) as Record<JournalMetricState, number>;
    const applicableCount = sourceCandidates.length - journalMetricStates.not_applicable_preprint;
    const missingApplicable = applicableCount - journalMetricStates.observed_metric;

    return {
      source,
      features: Object.fromEntries(
        FEATURE_KEYS.map((key) => [
          key,
          distribution(sourceCandidates.map((candidate) => numericFeature(candidate.rerank.features, key)))
        ])
      ) as Record<keyof DiagnosticFeatureScores, NumericDistribution>,
      journalMetricStates,
      journalMetricMissingRate: applicableCount > 0 ? missingApplicable / applicableCount : undefined,
      journalMetricNotApplicableRate:
        sourceCandidates.length > 0
          ? journalMetricStates.not_applicable_preprint / sourceCandidates.length
          : 0
    };
  });
}

function buildAblation(
  candidates: Array<SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> }>,
  topN: number
): AblationScenarioReport[] {
  const baselineTop = candidates
    .filter((candidate) => candidate.rerank.selected)
    .sort((left, right) => left.rerank.rank - right.rerank.rank || left.candidateId.localeCompare(right.candidateId))
    .slice(0, topN)
    .map((candidate) => ({ candidate, score: candidate.rerank.features.finalScore }));
  const baselineRanks = new Map(candidates.map((candidate) => [candidate.candidateId, candidate.rerank.rank]));
  const rankings = new Map(
    SCENARIOS.filter((scenario) => scenario !== "current")
      .map((scenario) => [scenario, rankCandidates(candidates, scenario)])
  );

  return SCENARIOS.map((scenario) => {
    const top = scenario === "current"
      ? baselineTop
      : (rankings.get(scenario) ?? []).slice(0, topN);
    const topCandidates = top.map((entry) => entry.candidate);
    const topIds = topCandidates.map((candidate) => candidate.candidateId);
    const topSet = new Set(topIds);
    const baselineSet = new Set(baselineTop.map((entry) => entry.candidate.candidateId));
    const contexts = topCandidates.map(classifyDiagnosticContext);
    const sharedRankChanges = top.flatMap((entry, index) => {
      const baselineRank = baselineRanks.get(entry.candidate.candidateId);
      return baselineRank ? [Math.abs(index + 1 - baselineRank)] : [];
    });

    return {
      scenario,
      topCandidateIds: topIds,
      sourceComposition: sourceComposition(topCandidates),
      humanDiseaseShare: top.length > 0
        ? contexts.filter(
            (context) => context.speciesContext === "human" && context.researchContext === "disease"
          ).length / top.length
        : 0,
      livestockOrCrossSpeciesShare: top.length > 0
        ? contexts.filter(
            (context) => context.speciesContext === "livestock" || context.speciesContext === "cross_species"
          ).length / top.length
        : 0,
      profileMatch: distribution(topCandidates.map(profileMatchScore)),
      entrants: topIds.filter((candidateId) => !baselineSet.has(candidateId)),
      exits: [...baselineSet].filter((candidateId) => !topSet.has(candidateId)),
      meanAbsoluteRankChange: mean(sharedRankChanges) ?? 0
    };
  });
}

function countBaselineSelectionMismatches(
  candidates: Array<SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> }>,
  topN: number
): number {
  const persisted = new Set(candidates
    .filter((candidate) => candidate.rerank.selected)
    .sort((left, right) => left.rerank.rank - right.rerank.rank)
    .slice(0, topN)
    .map((candidate) => candidate.candidateId));
  const rescored = new Set(rankCandidates(candidates, "current")
    .slice(0, persisted.size)
    .map((entry) => entry.candidate.candidateId));
  return [...persisted].filter((candidateId) => !rescored.has(candidateId)).length;
}

function rankCandidates(
  candidates: Array<SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> }>,
  scenario: RankingScenario
) {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, scenario) }))
    .sort((left, right) => right.score - left.score || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
}

export function scoreCandidateForAblation(
  candidate: SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> },
  scenario: RankingScenario
): number {
  return scoreCandidate(candidate, scenario);
}

function scoreCandidate(
  candidate: SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> },
  scenario: RankingScenario
): number {
  const feature = candidate.rerank.features;
  if (scenario === "current") return feature.finalScore;
  const journalWeight = candidate.rerank.featureWeights.journalQualityScore;
  const currentJournalContribution = feature.journalQualityScore * journalWeight;
  if (scenario === "journal_quality_zero") {
    return clamp(candidate.rerank.formulaScore - currentJournalContribution);
  }
  if (scenario === "journal_quality_half") {
    return clamp(candidate.rerank.formulaScore - currentJournalContribution / 2);
  }
  if (candidate.rerank.metricState !== "observed_metric") {
    return clamp(
      candidate.rerank.formulaScore + (0.5 - feature.journalQualityScore) * journalWeight
    );
  }
  return candidate.rerank.formulaScore;
}

function reproduceCurrentFormula(
  feature: DiagnosticFeatureScores,
  weight: DiagnosticFeatureWeights
): number {
  const score =
    feature.recallScore * weight.recallScore +
    feature.recentInterestScore * weight.recentInterestScore +
    feature.stableInterestScore * weight.stableInterestScore +
    feature.starredProfileScore * weight.starredProfileScore +
    feature.contentTagScore * weight.contentTagScore +
    feature.studyTypeScore * weight.studyTypeScore +
    feature.collectionWeightScore * weight.collectionWeightScore +
    feature.sourcePriorityScore * weight.sourcePriorityScore +
    feature.journalQualityScore * weight.journalQualityScore +
    feature.userCorrectedScore * weight.userCorrectedScore +
    feature.freshnessScore * weight.freshnessScore +
    feature.topicHeuristicScore * weight.topicHeuristicScore +
    feature.noisePenalty * weight.noisePenalty;
  return clamp(score);
}

function profileMatchScore(candidate: SourceRankingCandidateSnapshot): number {
  if (!candidate.rerank) return 0;
  const feature = candidate.rerank.features;
  const weight = candidate.rerank.featureWeights;
  const denominator =
    weight.recentInterestScore +
    weight.stableInterestScore +
    weight.starredProfileScore +
    weight.contentTagScore +
    weight.studyTypeScore;
  if (denominator <= 0) return 0;
  return clamp((
    feature.recentInterestScore * weight.recentInterestScore +
    feature.stableInterestScore * weight.stableInterestScore +
    feature.starredProfileScore * weight.starredProfileScore +
    feature.contentTagScore * weight.contentTagScore +
    feature.studyTypeScore * weight.studyTypeScore
  ) / denominator);
}

function sourceComposition(candidates: SourceRankingCandidateSnapshot[]): Record<DiagnosticSource, SourceAttribution> {
  const counts = Object.fromEntries(
    DIAGNOSTIC_SOURCES.map((source) => [source, { inclusiveCount: 0, fractionalCount: 0 }])
  ) as Record<DiagnosticSource, { inclusiveCount: number; fractionalCount: number }>;
  for (const candidate of candidates) {
    if (candidate.sources.length === 0) continue;
    const fraction = 1 / candidate.sources.length;
    for (const source of candidate.sources) {
      counts[source].inclusiveCount += 1;
      counts[source].fractionalCount += fraction;
    }
  }
  const fractionalTotal = sum(Object.values(counts).map((entry) => entry.fractionalCount));
  return Object.fromEntries(
    DIAGNOSTIC_SOURCES.map((source) => [source, {
      available: true,
      inclusiveCount: counts[source].inclusiveCount,
      fractionalCount: round(counts[source].fractionalCount),
      fractionalShare: fractionalTotal > 0 ? round(counts[source].fractionalCount / fractionalTotal) : 0
    }])
  ) as Record<DiagnosticSource, SourceAttribution>;
}

function distribution(values: number[]): NumericDistribution {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return { count: 0 };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
  return {
    count: finite.length,
    mean: round(sum(finite) / finite.length),
    median: round(median)
  };
}

function numericFeature(features: DiagnosticFeatureScores, key: keyof DiagnosticFeatureScores): number {
  const value = features[key];
  return typeof value === "boolean" ? Number(value) : value;
}

function normalizeCandidateSources(candidate: SourceRankingCandidateSnapshot): SourceRankingCandidateSnapshot {
  return {
    ...candidate,
    sources: DIAGNOSTIC_SOURCES.filter((source) => candidate.sources.includes(source))
  };
}

function hasRerank(
  candidate: SourceRankingCandidateSnapshot
): candidate is SourceRankingCandidateSnapshot & { rerank: NonNullable<SourceRankingCandidateSnapshot["rerank"]> } {
  return Boolean(candidate.rerank);
}

function assertUniqueCandidates(candidates: SourceRankingCandidateSnapshot[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.candidateId.trim()) throw new Error("Diagnostic candidateId cannot be empty.");
    if (seen.has(candidate.candidateId)) {
      throw new Error(`Duplicate diagnostic candidateId: ${candidate.candidateId}`);
    }
    if (candidate.rerank) {
      assertValidFeatureScores(candidate.candidateId, candidate.rerank.features);
      assertValidFeatureWeights(candidate.candidateId, candidate.rerank.featureWeights);
      if (!Number.isFinite(candidate.rerank.formulaScore)) {
        throw new Error(`Diagnostic formulaScore must be a finite number for candidate ${candidate.candidateId}.`);
      }
    }
    seen.add(candidate.candidateId);
  }
}

function assertValidFeatureWeights(candidateId: string, weights: DiagnosticFeatureWeights): void {
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Diagnostic feature weight ${key} must be a finite number for candidate ${candidateId}.`);
    }
  }
  const required = FEATURE_KEYS.filter((key) => key !== "requiredTopicGate" && key !== "finalScore");
  for (const key of required) {
    if (!Object.hasOwn(weights, key)) {
      throw new Error(`Diagnostic feature weight ${key} is required for candidate ${candidateId}.`);
    }
  }
}

function assertValidFeatureScores(candidateId: string, features: DiagnosticFeatureScores): void {
  for (const key of FEATURE_KEYS) {
    const value = features[key];
    if (key === "requiredTopicGate") {
      if (typeof value !== "boolean") {
        throw new Error(`Diagnostic feature ${key} must be boolean for candidate ${candidateId}.`);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Diagnostic feature ${key} must be a finite number for candidate ${candidateId}.`);
    }
  }
}

function normalizeTopN(value?: number): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1) throw new Error("Diagnostic topN must be a positive integer.");
  return value;
}

function normalizeCount(value?: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return round(Math.min(1, value));
}

function mean(values: number[]): number | undefined {
  return values.length > 0 ? round(sum(values) / values.length) : undefined;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
