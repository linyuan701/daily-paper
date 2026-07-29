import { describe, expect, it, vi } from "vitest";

import { PrismaDailyRecommendationRepository } from "./daily-recommendations-repository";

describe("PrismaDailyRecommendationRepository", () => {
  it("projects existing detail fields without changing recommendation semantics", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "rerank-1",
      runId: "run-1",
      startedAt: new Date("2026-07-30T01:00:00.000Z"),
      results: [{
        rank: 1,
        selected: true,
        finalScore: 0.92,
        reasonsJson: ["topic_match"],
        canonicalCandidate: {
          id: "candidate-1",
          title: "A paper",
          abstractNote: "Existing abstract",
          publishedAt: new Date("2026-07-29T00:00:00.000Z"),
          url: "https://example.test/paper",
          journalName: "Genome Research",
          doi: "10.1000/example",
          pmid: null,
          arxivId: null,
          bioRxivId: null,
          summary: null,
          labels: [],
          provenances: [{
            source: "PUBMED",
            externalId: "12345",
            sourceCandidate: {
              journalEnrichment: {
                status: "ENRICHED",
                quartile: "Q1",
                impactScore: 12.3
              }
            }
          }]
        }
      }]
    });
    const repository = new PrismaDailyRecommendationRepository({
      dailyRerankRun: { findFirst }
    } as never);

    const feed = await repository.getLatestFeed("run-1");

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { runId: "run-1", status: "SUCCESS" }
    }));
    expect(feed?.recommendations[0]).toMatchObject({
      abstract: "Existing abstract",
      url: "https://example.test/paper",
      sourceIdentifiers: [{ source: "pubmed", externalId: "12345" }],
      journal: { name: "Genome Research", quartile: "Q1", impactScore: 12.3 }
    });
  });

  it("keeps optional details absent when the stored candidate does not have them", async () => {
    const repository = new PrismaDailyRecommendationRepository({
      dailyRerankRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: "rerank-2",
          runId: "run-2",
          startedAt: new Date("2026-07-30T01:00:00.000Z"),
          results: [{
            rank: 2,
            selected: true,
            finalScore: 0.4,
            reasonsJson: null,
            canonicalCandidate: {
              id: "candidate-2",
              title: null,
              abstractNote: null,
              publishedAt: null,
              url: null,
              journalName: null,
              doi: null,
              pmid: null,
              arxivId: null,
              bioRxivId: null,
              summary: null,
              labels: [],
              provenances: []
            }
          }]
        })
      }
    } as never);

    const feed = await repository.getLatestFeed("run-2");

    expect(feed?.recommendations[0]).toMatchObject({
      sources: [],
      sourceIdentifiers: [],
      identifiers: {},
      labels: {},
      reasons: []
    });
    expect(feed?.recommendations[0].abstract).toBeUndefined();
    expect(feed?.recommendations[0].journal).toBeUndefined();
  });
});
