export const DIAGNOSTIC_SOURCES = ["pubmed", "biorxiv", "arxiv", "journal"] as const;

export type DiagnosticSource = (typeof DIAGNOSTIC_SOURCES)[number];

export const FUNNEL_STAGES = [
  "fetched",
  "accepted",
  "normalized",
  "represented",
  "recall_candidate",
  "rerank_candidate",
  "final_selected"
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type SpeciesContext =
  | "human"
  | "livestock"
  | "model_organism"
  | "plant"
  | "cross_species"
  | "unknown";

export type ResearchContext =
  | "disease"
  | "basic_biology"
  | "breeding"
  | "evolution"
  | "method"
  | "resource"
  | "unknown";

export type DiagnosticContext = {
  speciesContext: SpeciesContext;
  researchContext: ResearchContext;
  speciesEvidence: string[];
  researchEvidence: string[];
};

export type JournalMetricState =
  | "observed_metric"
  | "unavailable_metric"
  | "enrichment_failure"
  | "not_applicable_preprint"
  | "unattempted_or_unknown";

/**
 * Diagnostic aliases intentionally match the product vocabulary without changing
 * the persisted rerank DTO. The extra fields reproduce the current score formula.
 */
export type DiagnosticFeatureScores = {
  recallScore: number;
  recentInterestScore: number;
  stableInterestScore: number;
  starredProfileScore: number;
  contentTagScore: number;
  studyTypeScore: number;
  journalQualityScore: number;
  freshnessScore: number;
  requiredTopicGate: boolean;
  noisePenalty: number;
  finalScore: number;
  collectionWeightScore: number;
  sourcePriorityScore: number;
  userCorrectedScore: number;
  topicHeuristicScore: number;
};

export type DiagnosticFeatureWeights = Omit<
  DiagnosticFeatureScores,
  "requiredTopicGate" | "finalScore"
>;

export type SourceRankingCandidateSnapshot = {
  candidateId: string;
  sources: DiagnosticSource[];
  title?: string;
  abstractNote?: string;
  researchCategory?: "method" | "biology" | "resource" | "benchmark";
  represented: boolean;
  recall?: {
    rank: number;
    selected: boolean;
  };
  rerank?: {
    rank: number;
    selected: boolean;
    metricState: JournalMetricState;
    features: DiagnosticFeatureScores;
    featureWeights: DiagnosticFeatureWeights;
    /** Persisted scoring baseline used for journal-only deltas. */
    formulaScore: number;
  };
};

export type SourceRankingAuditInput = {
  runId: string;
  fetchedCounts?: Partial<Record<DiagnosticSource, number>>;
  acceptedCounts?: Partial<Record<DiagnosticSource, number>>;
  candidates: SourceRankingCandidateSnapshot[];
};

export type SourceAttribution = {
  available: boolean;
  inclusiveCount: number;
  fractionalCount: number;
  fractionalShare: number;
};

export type FunnelStageReport = {
  stage: FunnelStage;
  available: boolean;
  candidateCount?: number;
  countSemantics: "source_reported_total" | "distinct_canonical";
  bySource: Record<DiagnosticSource, SourceAttribution>;
};

export type NumericDistribution = {
  count: number;
  mean?: number;
  median?: number;
};

export type SourceFeatureReport = {
  source: DiagnosticSource;
  features: Record<keyof DiagnosticFeatureScores, NumericDistribution>;
  journalMetricStates: Record<JournalMetricState, number>;
  journalMetricMissingRate?: number;
  journalMetricNotApplicableRate: number;
};

export type RankingScenario =
  | "current"
  | "journal_quality_zero"
  | "journal_quality_half"
  | "missing_quality_neutral";

export type AblationScenarioReport = {
  scenario: RankingScenario;
  topCandidateIds: string[];
  sourceComposition: Record<DiagnosticSource, SourceAttribution>;
  humanDiseaseShare: number;
  livestockOrCrossSpeciesShare: number;
  profileMatch: NumericDistribution;
  entrants: string[];
  exits: string[];
  meanAbsoluteRankChange: number;
};

export type SourceRankingAuditReport = {
  runId: string;
  formulaVersion: "persisted-final-score-journal-delta-v1";
  funnel: FunnelStageReport[];
  sourceFeatures: SourceFeatureReport[];
  recallTop100: Record<DiagnosticSource, SourceAttribution>;
  rerankTop30: Record<DiagnosticSource, SourceAttribution>;
  finalSelected: Record<DiagnosticSource, SourceAttribution>;
  finalCandidates: Array<{
    candidateId: string;
    rank: number;
    sources: DiagnosticSource[];
    metricState: JournalMetricState;
    metricAvailable: boolean;
    speciesContext: SpeciesContext;
    researchContext: ResearchContext;
    scores: Pick<
      DiagnosticFeatureScores,
      | "recallScore"
      | "recentInterestScore"
      | "stableInterestScore"
      | "starredProfileScore"
      | "contentTagScore"
      | "studyTypeScore"
      | "journalQualityScore"
      | "freshnessScore"
      | "requiredTopicGate"
      | "noisePenalty"
      | "finalScore"
    >;
  }>;
  scoreReproductionDrift: NumericDistribution;
  ablationReliability: {
    candidateCount: number;
    saturatedCandidateCount: number;
    scoreReproductionOutlierCount: number;
    baselineSelectionMismatchCount: number;
    baselineMatchesPersistedSelection: boolean;
    journalDeltaExactForUnsaturatedScores: boolean;
  };
  ablation: AblationScenarioReport[];
};
