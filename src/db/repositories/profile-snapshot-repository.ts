import type { Prisma, PrismaClient } from "../../generated/prisma";
import { toIsoDate } from "../../lib/utils";
import type {
  ProfileSnapshotRepository,
  ProfileSnapshotSummary
} from "../../modules/profile-build/types";

export class PrismaProfileSnapshotRepository implements ProfileSnapshotRepository {
  constructor(private readonly db: PrismaClient) {}

  async listEligibleItems() {
    const items = await this.db.zoteroItemRaw.findMany({
      where: {
        itemCollections: {
          some: {
            collection: {
              effectivePriority: {
                is: {
                  priority: {
                    in: ["PRIMARY", "SECONDARY"]
                  }
                }
              }
            }
          }
        }
      },
      select: {
        id: true,
        zoteroItemKey: true,
        title: true,
        abstractNote: true,
        dateAdded: true,
        libraryVersion: true,
        tagSignal: {
          select: {
            attentionLevel: true
          }
        },
        itemCollections: {
          select: {
            collection: {
              select: {
                effectivePriority: {
                  select: {
                    priority: true
                  }
                }
              }
            }
          }
        },
        contentRecallTags: {
          where: {
            parseStatus: "PARSED"
          },
          select: {
            label: true
          }
        },
        researchTypeTags: {
          where: {
            parseStatus: "PARSED",
            category: {
              not: null
            }
          },
          select: {
            category: true,
            primaryKeyword: true,
            secondaryKeyword: true
          }
        }
      }
    });

    return items.map((item) => {
      const collectionPriorities = Array.from(
        new Set(
          item.itemCollections
            .map((entry) => entry.collection.effectivePriority?.priority)
            .filter((priority): priority is "PRIMARY" | "SECONDARY" =>
              priority === "PRIMARY" || priority === "SECONDARY"
            )
            .map((priority) => (priority === "PRIMARY" ? "primary" : "secondary"))
        )
      );

      const researchCategories = item.researchTypeTags
        .map((tag) => tag.category)
        .filter(
          (category): category is "METHOD" | "BIOLOGY" | "RESOURCE" | "BENCHMARK" =>
            category === "METHOD" ||
            category === "BIOLOGY" ||
            category === "RESOURCE" ||
            category === "BENCHMARK"
        )
        .map((category) => fromDbResearchCategory(category));

      const researchKeywords = item.researchTypeTags
        .flatMap((tag) => [tag.primaryKeyword, tag.secondaryKeyword])
        .filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim() !== "")
        .map((keyword) => keyword.trim());

      return {
        itemId: item.id,
        zoteroItemKey: item.zoteroItemKey,
        title: item.title ?? undefined,
        abstractNote: item.abstractNote ?? undefined,
        dateAdded: item.dateAdded ?? undefined,
        libraryVersion: item.libraryVersion ?? undefined,
        collectionPriorities,
        attentionLevel: item.tagSignal?.attentionLevel ?? 0,
        contentRecallLabels: item.contentRecallTags
          .map((tag) => tag.label)
          .filter((value): value is string => typeof value === "string" && value.trim() !== "")
          .map((value) => value.trim()),
        researchCategories,
        researchKeywords
      };
    });
  }

  async listFeedbackLogs(input?: { since?: Date; limit?: number }) {
    const rows = await this.db.candidateFeedbackLog.findMany({
      where: input?.since
        ? {
            createdAt: {
              gt: input.since
            }
          }
        : undefined,
      orderBy: [{ createdAt: "asc" }],
      take: input?.limit ?? 500
    });

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      candidateId: row.candidateId,
      actionType: fromDbFeedbackAction(row.actionType),
      oldValue: toObject(row.oldValueJson),
      newValue: toObject(row.newValueJson),
      metadata: toObject(row.metadataJson),
      createdAt: toIsoDate(row.createdAt)
    }));
  }

  async saveActiveSnapshot(input: {
    sourceLibraryVersion?: number;
    items: Array<{
      itemId: string;
      segment: "recent_core" | "stable_long_term" | "background";
      finalWeight: number;
      collectionWeight: number;
      attentionWeight: number;
      recencyWeight: number;
      representationSource: "structured_tags" | "title_abstract";
      contentRecallLabel?: string;
      researchCategory?: "method" | "biology" | "resource" | "benchmark";
      representationText: string;
    }>;
    researchPreferences: Array<{
      category: "method" | "biology" | "resource" | "benchmark";
      weight: number;
      itemCount: number;
    }>;
    summaryJson: Record<string, unknown>;
  }) {
    const snapshot = await this.db.$transaction(async (tx) => {
      await tx.profileSnapshot.updateMany({
        where: {
          status: "ACTIVE"
        },
        data: {
          status: "SUPERSEDED"
        }
      });

      return tx.profileSnapshot.create({
        data: {
          status: "ACTIVE",
          sourceLibraryVersion: input.sourceLibraryVersion ?? null,
          itemsCount: input.items.length,
          summaryJson: input.summaryJson as Prisma.InputJsonValue,
          itemSignals: {
            createMany: {
              data: input.items.map((item) => ({
                itemId: item.itemId,
                segment: toDbSegment(item.segment),
                finalWeight: item.finalWeight,
                collectionWeight: item.collectionWeight,
                attentionWeight: item.attentionWeight,
                recencyWeight: item.recencyWeight,
                representationSource: toDbRepresentationSource(item.representationSource),
                contentRecallLabel: item.contentRecallLabel ?? null,
                researchCategory: item.researchCategory
                  ? toDbResearchCategory(item.researchCategory)
                  : null,
                representationText: item.representationText
              }))
            }
          },
          researchTypePreferences: {
            createMany: {
              data: input.researchPreferences.map((entry) => ({
                category: toDbResearchCategory(entry.category),
                weight: entry.weight,
                itemCount: entry.itemCount
              }))
            }
          }
        },
        include: {
          researchTypePreferences: true
        }
      });
    });

    return mapSnapshotSummary(snapshot);
  }

  async getActiveSnapshot(): Promise<ProfileSnapshotSummary | null> {
    const snapshot = await this.db.profileSnapshot.findFirst({
      where: {
        status: "ACTIVE"
      },
      include: {
        researchTypePreferences: true
      },
      orderBy: [{ builtAt: "desc" }, { createdAt: "desc" }]
    });

    if (!snapshot) {
      return null;
    }

    return mapSnapshotSummary(snapshot);
  }

  /** Read persisted evidence without loading Zotero items or profile representations. */
  async getSnapshotForDashboard(profileSnapshotId?: string) {
    const snapshot = await this.db.profileSnapshot.findFirst({
      where: profileSnapshotId ? { id: profileSnapshotId } : { status: "ACTIVE" },
      select: {
        id: true, status: true, builtAt: true, sourceLibraryVersion: true,
        itemsCount: true, summaryJson: true,
        researchTypePreferences: { select: { category: true, weight: true, itemCount: true } }
      },
      orderBy: [{ builtAt: "desc" }, { createdAt: "desc" }]
    });
    return snapshot ? { snapshot: mapSnapshotSummary(snapshot), summaryJson: snapshot.summaryJson } : null;
  }
}

function toDbSegment(value: "recent_core" | "stable_long_term" | "background") {
  if (value === "recent_core") {
    return "RECENT_CORE";
  }
  if (value === "stable_long_term") {
    return "STABLE_LONG_TERM";
  }
  return "BACKGROUND";
}

function toDbRepresentationSource(value: "structured_tags" | "title_abstract") {
  return value === "structured_tags" ? "STRUCTURED_TAGS" : "TITLE_ABSTRACT";
}

function toDbResearchCategory(value: "method" | "biology" | "resource" | "benchmark") {
  if (value === "method") {
    return "METHOD";
  }
  if (value === "biology") {
    return "BIOLOGY";
  }
  if (value === "resource") {
    return "RESOURCE";
  }
  return "BENCHMARK";
}

function fromDbResearchCategory(value: "METHOD" | "BIOLOGY" | "RESOURCE" | "BENCHMARK") {
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

function fromDbFeedbackAction(
  value: "SAVE" | "DISMISS" | "PROMOTE" | "LABEL_EDIT" | "SUMMARY_EDIT"
): "save" | "dismiss" | "promote" | "label_edit" | "summary_edit" {
  if (value === "SAVE") {
    return "save";
  }
  if (value === "DISMISS") {
    return "dismiss";
  }
  if (value === "PROMOTE") {
    return "promote";
  }
  if (value === "LABEL_EDIT") {
    return "label_edit";
  }
  return "summary_edit";
}

function toObject(value: Prisma.JsonValue | null): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function mapSnapshotSummary(snapshot: {
  id: string;
  status: "ACTIVE" | "SUPERSEDED";
  builtAt: Date;
  sourceLibraryVersion: number | null;
  itemsCount: number;
  summaryJson: Prisma.JsonValue | null;
  researchTypePreferences: Array<{
    category: "METHOD" | "BIOLOGY" | "RESOURCE" | "BENCHMARK";
    weight: number;
    itemCount: number;
  }>;
}): ProfileSnapshotSummary {
  const summary =
    snapshot.summaryJson && typeof snapshot.summaryJson === "object" && !Array.isArray(snapshot.summaryJson)
      ? (snapshot.summaryJson as {
          segmentCounts?: { recentCore?: number; stableLongTerm?: number; background?: number };
        })
      : {};

  return {
    id: snapshot.id,
    status: snapshot.status === "ACTIVE" ? "active" : "superseded",
    builtAt: toIsoDate(snapshot.builtAt),
    sourceLibraryVersion: snapshot.sourceLibraryVersion ?? undefined,
    itemsCount: snapshot.itemsCount,
    segments: {
      recentCore: summary.segmentCounts?.recentCore ?? 0,
      stableLongTerm: summary.segmentCounts?.stableLongTerm ?? 0,
      background: summary.segmentCounts?.background ?? 0
    },
    researchTypePreferences: snapshot.researchTypePreferences.map((entry) => ({
      category: fromDbResearchCategory(entry.category),
      weight: entry.weight,
      itemCount: entry.itemCount
    }))
  };
}
