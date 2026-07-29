import type { ResearchTypeCategoryValue } from "../../tagging/types";

export type RecommendationSourceValue = "biorxiv" | "arxiv" | "pubmed" | "journal";

export type DailyRecommendationRecord = {
  candidateId: string;
  rank: number;
  selected: boolean;
  finalScore: number;
  title?: string;
  abstract?: string;
  publishedAt?: string;
  url?: string;
  sources: RecommendationSourceValue[];
  sourceIdentifiers?: Array<{
    source: RecommendationSourceValue;
    externalId: string;
  }>;
  identifiers: {
    doi?: string;
    pmid?: string;
    arxivId?: string;
    bioRxivId?: string;
  };
  summary?: {
    researchQuestion: string;
    method: string;
    mainFinding: string;
    relevanceToUser: string;
    provider: string;
    provenance: "generated" | "user_corrected";
  };
  labels: {
    contentRecall?: {
      label: string;
      provider: string;
      provenance: "generated" | "user_corrected";
    };
    researchType?: {
      category?: ResearchTypeCategoryValue;
      primaryKeyword?: string;
      secondaryKeyword?: string;
      rawText?: string;
      provider: string;
      provenance: "generated" | "user_corrected";
    };
  };
  reasons: string[];
  journal?: {
    name?: string;
    quartile?: string;
    impactScore?: number;
  };
};

export type DailyRecommendationFeed = {
  rerankRunId: string;
  runId: string;
  generatedAt: string;
  recommendations: DailyRecommendationRecord[];
};

export interface DailyRecommendationRepository {
  getLatestFeed(runId?: string): Promise<DailyRecommendationFeed | null>;
}

export interface DailyRecommendationService {
  getDailyFeed(input?: {
    runId?: string;
    selectedOnly?: boolean;
    source?: RecommendationSourceValue;
  }): Promise<DailyRecommendationFeed | null>;
}
