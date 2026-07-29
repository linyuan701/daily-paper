import type { PrismaClient } from "../../generated/prisma";
import type {
  DailyRecommendationFeed,
  DailyRecommendationRecord,
  DailyRecommendationRepository
} from "../../modules/ranking/explain/types";
import type { ResearchTypeCategoryValue } from "../../modules/tagging/types";

export class PrismaDailyRecommendationRepository implements DailyRecommendationRepository {
  constructor(private readonly db: PrismaClient) {}

  async getLatestFeed(runId?: string): Promise<DailyRecommendationFeed | null> {
    const rerankRun = await this.db.dailyRerankRun.findFirst({
      where: {
        ...(runId
          ? { runId }
          : {
              run: {
                is: {
                  source: "AGGREGATED"
                }
              }
            }),
        status: "SUCCESS"
      },
      include: {
        results: {
          orderBy: [{ rank: "asc" }],
          include: {
            canonicalCandidate: {
              include: {
                summary: true,
                labels: true,
                provenances: {
                  include: {
                    sourceCandidate: {
                      include: {
                        journalEnrichment: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
    });

    if (!rerankRun) {
      return null;
    }

    return {
      rerankRunId: rerankRun.id,
      runId: rerankRun.runId,
      generatedAt: rerankRun.startedAt.toISOString(),
      recommendations: rerankRun.results.map((result) => toRecommendation(result))
    };
  }
}

function toRecommendation(result: {
  rank: number;
  selected: boolean;
  finalScore: number;
  reasonsJson: unknown;
  canonicalCandidate: {
    id: string;
    title: string | null;
    abstractNote: string | null;
    publishedAt: Date | null;
    url: string | null;
    journalName: string | null;
    doi: string | null;
    pmid: string | null;
    arxivId: string | null;
    bioRxivId: string | null;
    summary: {
      researchQuestion: string;
      method: string;
      mainFinding: string;
      relevanceToUser: string;
      provider: string;
      provenance: "GENERATED" | "USER_CORRECTED";
    } | null;
    labels: Array<{
      labelType: "CONTENT_RECALL" | "RESEARCH_TYPE";
      contentRecallLabel: string | null;
      researchCategory: "METHOD" | "BIOLOGY" | "RESOURCE" | "BENCHMARK" | null;
      primaryKeyword: string | null;
      secondaryKeyword: string | null;
      rawLabelText: string | null;
      provider: string;
      provenance: "GENERATED" | "USER_CORRECTED";
    }>;
    provenances: Array<{
      source: "BIORXIV" | "ARXIV" | "PUBMED" | "JOURNAL";
      externalId: string;
      sourceCandidate: {
        journalEnrichment: {
          status: "ENRICHED" | "NOT_FOUND" | "FAILED";
          quartile: string | null;
          impactScore: number | null;
        } | null;
      };
    }>;
  };
}): DailyRecommendationRecord {
  const sources = [...new Set(result.canonicalCandidate.provenances.map((entry) => fromDbSource(entry.source)))];
  const contentLabel = result.canonicalCandidate.labels.find((label) => label.labelType === "CONTENT_RECALL");
  const researchLabel = result.canonicalCandidate.labels.find((label) => label.labelType === "RESEARCH_TYPE");
  const enriched = result.canonicalCandidate.provenances
    .map((entry) => entry.sourceCandidate.journalEnrichment)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => entry.status === "ENRICHED")
    .sort((left, right) => (right.impactScore ?? 0) - (left.impactScore ?? 0))[0];

  return {
    candidateId: result.canonicalCandidate.id,
    rank: result.rank,
    selected: result.selected,
    finalScore: result.finalScore,
    title: result.canonicalCandidate.title ?? undefined,
    abstract: result.canonicalCandidate.abstractNote ?? undefined,
    publishedAt: result.canonicalCandidate.publishedAt?.toISOString(),
    url: result.canonicalCandidate.url ?? undefined,
    sources,
    sourceIdentifiers: result.canonicalCandidate.provenances.map((entry) => ({
      source: fromDbSource(entry.source),
      externalId: entry.externalId
    })),
    identifiers: {
      doi: result.canonicalCandidate.doi ?? undefined,
      pmid: result.canonicalCandidate.pmid ?? undefined,
      arxivId: result.canonicalCandidate.arxivId ?? undefined,
      bioRxivId: result.canonicalCandidate.bioRxivId ?? undefined
    },
    summary: result.canonicalCandidate.summary
      ? {
          researchQuestion: result.canonicalCandidate.summary.researchQuestion,
          method: result.canonicalCandidate.summary.method,
          mainFinding: result.canonicalCandidate.summary.mainFinding,
          relevanceToUser: result.canonicalCandidate.summary.relevanceToUser,
          provider: result.canonicalCandidate.summary.provider,
          provenance: fromDbProvenance(result.canonicalCandidate.summary.provenance)
        }
      : undefined,
    labels: {
      contentRecall: contentLabel?.contentRecallLabel
        ? {
            label: contentLabel.contentRecallLabel,
            provider: contentLabel.provider,
            provenance: fromDbProvenance(contentLabel.provenance)
          }
        : undefined,
      researchType: researchLabel
        ? {
            category: researchLabel.researchCategory
              ? fromDbResearchCategory(researchLabel.researchCategory)
              : undefined,
            primaryKeyword: researchLabel.primaryKeyword ?? undefined,
            secondaryKeyword: researchLabel.secondaryKeyword ?? undefined,
            rawText: researchLabel.rawLabelText ?? undefined,
            provider: researchLabel.provider,
            provenance: fromDbProvenance(researchLabel.provenance)
          }
        : undefined
    },
    reasons: toReasons(result.reasonsJson),
    journal: result.canonicalCandidate.journalName || enriched
      ? {
          name: result.canonicalCandidate.journalName ?? undefined,
          quartile: enriched?.quartile ?? undefined,
          impactScore: enriched?.impactScore ?? undefined
        }
      : undefined
  };
}

function fromDbSource(value: "BIORXIV" | "ARXIV" | "PUBMED" | "JOURNAL") {
  if (value === "BIORXIV") {
    return "biorxiv";
  }
  if (value === "ARXIV") {
    return "arxiv";
  }
  if (value === "PUBMED") {
    return "pubmed";
  }
  return "journal";
}

function fromDbProvenance(value: "GENERATED" | "USER_CORRECTED") {
  if (value === "GENERATED") {
    return "generated";
  }
  return "user_corrected";
}

function fromDbResearchCategory(
  value: "METHOD" | "BIOLOGY" | "RESOURCE" | "BENCHMARK"
): ResearchTypeCategoryValue {
  if (value === "METHOD") {
    return "method";
  }
  if (value === "BIOLOGY") {
    return "biology";
  }
  if (value === "RESOURCE") {
    return "resource";
  }
  return "benchmark";
}

function toReasons(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
