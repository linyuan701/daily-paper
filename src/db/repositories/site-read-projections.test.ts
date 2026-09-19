import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma";
import { PrismaDailyRecommendationRepository } from "./daily-recommendations-repository";
import { PrismaProfileSnapshotRepository } from "./profile-snapshot-repository";

describe("Site additive persisted read projections", () => {
  it("returns the persisted abstract without modifying score, rank or selection", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "rerank", runId: "run", startedAt: new Date("2026-09-18T00:00:00Z"), results: [{ rank: 2, selected: true, finalScore: 0.71, reasonsJson: ["stored-reason"], canonicalCandidate: { id: "candidate", title: "Fixture title", abstractNote: "Persisted original abstract", publishedAt: null, doi: null, pmid: null, arxivId: null, bioRxivId: null, summary: null, labels: [], provenances: [] } }] });
    const repository = new PrismaDailyRecommendationRepository({ dailyRerankRun: { findFirst } } as unknown as PrismaClient);
    const feed = await repository.getLatestFeed("run");
    expect(feed?.recommendations[0]).toMatchObject({ abstractNote: "Persisted original abstract", rank: 2, selected: true, finalScore: 0.71, reasons: ["stored-reason"] });
    expect(findFirst).toHaveBeenCalledOnce();
  });
  it("projects active snapshot evidence and limits positive labels using saved weights", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "snapshot", status: "ACTIVE", builtAt: new Date("2026-09-18T00:00:00Z"), sourceLibraryVersion: null, itemsCount: 4, summaryJson: { segmentCounts: { recentCore: 4 }, feedbackIntegration: { logsConsumed: 3, actionCounts: { dismiss: 3 }, negativeFeedback: { signalCount: 2, signals: [] } } }, researchTypePreferences: [], itemSignals: [{ contentRecallLabel: "#a" }, { contentRecallLabel: "#a" }, { contentRecallLabel: "#b" }] });
    const repository = new PrismaProfileSnapshotRepository({ profileSnapshot: { findFirst } } as unknown as PrismaClient);
    const snapshot = await repository.getActiveSnapshot();
    expect(snapshot?.positiveLabels).toEqual(["#a", "#b"]);
    expect(snapshot?.feedbackIntegration?.logsConsumed).toBe(3);
    expect(snapshot?.feedbackIntegration?.negativeFeedback?.signalCount).toBe(2);
    expect(findFirst.mock.calls[0][0].include.itemSignals).toMatchObject({ take: 100, orderBy: [{ finalWeight: "desc" }, { id: "asc" }] });
  });
});
