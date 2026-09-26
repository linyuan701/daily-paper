import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logging";
import { ArxivSourceAdapter } from "./arxiv-adapter";
import {
  buildDailyRunRequestKey,
  createAdapterMap,
  DefaultDailyIngestionService
} from "./ingestion-foundation.service";
import type {
  DailyIngestionRepository,
  DailySourceAdapter,
  DailySourceAdapterCandidate
} from "./types";

class FakeRepository implements DailyIngestionRepository {
  private cursors = new Map<string, Date>();
  private seen = new Map<string, Set<string>>();
  private latestRun: {
    id: string;
    source: "biorxiv" | "arxiv" | "pubmed" | "journal" | "aggregated";
    status: "running" | "success" | "failed";
    runDate: string;
    startedAt: string;
    candidatesCount: number;
    attempt: number;
    requestKey?: string;
  } | null = null;

  private candidates: Array<{
    id: string;
    runId: string;
    source: "biorxiv" | "arxiv" | "pubmed" | "journal";
    externalId: string;
    sourcePayload: Record<string, unknown>;
    authors: string[];
  }> = [];
  private cursorReadCounts = new Map<string, number>();
  pipelineInitialization?: {
    ingestionStatus: "success" | "partial";
    ingestionDetails: Record<string, unknown>;
  };

  seedCursor(source: "biorxiv" | "arxiv" | "pubmed" | "journal", value: Date) {
    this.cursors.set(source, value);
  }

  seedSeen(source: "biorxiv" | "arxiv" | "pubmed" | "journal", values: string[]) {
    this.seen.set(source, new Set(values));
  }

  async acquireRun(input: {
    source: "biorxiv" | "arxiv" | "pubmed" | "journal" | "aggregated";
    runDate: Date;
    requestKey: string;
  }) {
    this.latestRun = {
      id: "run-1",
      source: input.source,
      status: "running",
      runDate: input.runDate.toISOString(),
      startedAt: new Date().toISOString(),
      candidatesCount: 0,
      attempt: 1,
      requestKey: input.requestKey
    };
    return { run: this.latestRun, disposition: "acquired" as const };
  }

  async finalizeRunSuccess(input: {
    runId: string;
    attempt: number;
    entries: Array<{
      source: "biorxiv" | "arxiv" | "pubmed" | "journal";
      candidate: DailySourceAdapterCandidate;
    }>;
    checkpoints: Array<{
      source: "biorxiv" | "arxiv" | "pubmed" | "journal";
      successfulAt: Date;
      seenExternalIds?: string[];
    }>;
    pipelineInitialization?: {
      ingestionStatus: "success" | "partial";
      ingestionDetails: Record<string, unknown>;
    };
  }) {
    this.pipelineInitialization = input.pipelineInitialization;
    const candidatesCount = await this.saveCandidates({ runId: input.runId, entries: input.entries });
    for (const checkpoint of input.checkpoints) {
      await this.commitSourceSuccess(checkpoint);
    }
    return this.markRunSucceeded({ runId: input.runId, candidatesCount });
  }

  async saveCandidates(input: {
    runId: string;
    entries: Array<{
      source: "biorxiv" | "arxiv" | "pubmed" | "journal";
      candidate: DailySourceAdapterCandidate;
    }>;
  }) {
    this.candidates = input.entries.map((entry, index) => ({
      id: `c-${index + 1}`,
      runId: input.runId,
      source: entry.source,
      externalId: entry.candidate.externalId,
      sourcePayload: entry.candidate.sourcePayload,
      authors: entry.candidate.authors
    }));

    return this.candidates.length;
  }

  async markRunSucceeded(input: { runId: string; candidatesCount: number }) {
    this.latestRun = {
      id: input.runId,
      source: this.latestRun?.source ?? "biorxiv",
      status: "success",
      runDate: this.latestRun?.runDate ?? new Date().toISOString(),
      startedAt: this.latestRun?.startedAt ?? new Date().toISOString(),
      candidatesCount: input.candidatesCount,
      attempt: this.latestRun?.attempt ?? 1,
      requestKey: this.latestRun?.requestKey
    };

    return {
      ...this.latestRun,
      finishedAt: new Date().toISOString()
    };
  }

  async markRunFailed(input: { runId: string; attempt: number; errorMessage: string }) {
    this.latestRun = {
      id: input.runId,
      source: this.latestRun?.source ?? "biorxiv",
      status: "failed",
      runDate: this.latestRun?.runDate ?? new Date().toISOString(),
      startedAt: this.latestRun?.startedAt ?? new Date().toISOString(),
      candidatesCount: 0,
      attempt: this.latestRun?.attempt ?? 1,
      requestKey: this.latestRun?.requestKey
    };

    return {
      ...this.latestRun,
      finishedAt: new Date().toISOString(),
      errorMessage: input.errorMessage
    };
  }

  async setPipelineOutcome(input: {
    runId: string;
    status: "complete" | "complete_with_warnings" | "partial" | "failed";
  }) {
    if (!this.latestRun || this.latestRun.id !== input.runId) throw new Error("run not found");
    return {
      ...this.latestRun,
      pipelineStatus: input.status,
      pipelineFinishedAt: new Date().toISOString()
    };
  }

  async getLatestRun() {
    return this.latestRun;
  }

  async getRun(runId: string) {
    return this.latestRun?.id === runId ? this.latestRun : null;
  }

  async listCandidatesByRun() {
    return this.candidates;
  }

  async getSourceCursor(source: "biorxiv" | "arxiv" | "pubmed" | "journal") {
    this.cursorReadCounts.set(source, (this.cursorReadCounts.get(source) ?? 0) + 1);
    return this.cursors.get(source);
  }

  getSourceCursorReadCount(source: "biorxiv" | "arxiv" | "pubmed" | "journal") {
    return this.cursorReadCounts.get(source) ?? 0;
  }

  async listSeenExternalIds(source: "biorxiv" | "arxiv" | "pubmed" | "journal", externalIds: string[]) {
    const seen = this.seen.get(source) ?? new Set<string>();
    return new Set(externalIds.filter((id) => seen.has(id)));
  }

  async commitSourceSuccess(input: {
    source: "biorxiv" | "arxiv" | "pubmed" | "journal";
    successfulAt: Date;
    seenExternalIds?: string[];
  }) {
    this.cursors.set(input.source, input.successfulAt);
    const seen = this.seen.get(input.source) ?? new Set<string>();
    input.seenExternalIds?.forEach((id) => seen.add(id));
    this.seen.set(input.source, seen);
  }
}

describe("DefaultDailyIngestionService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds one stable key for equivalent source sets", () => {
    const date = new Date("2026-03-07T00:00:00.000Z");
    expect(buildDailyRunRequestKey(date, ["pubmed", "arxiv"], true)).toBe(
      buildDailyRunRequestKey(date, ["arxiv", "pubmed", "arxiv"], true)
    );
  });
  it("uses a bounded watermark lookback and deduplicates fetched candidates", async () => {
    const adapter: DailySourceAdapter = {
      source: "arxiv",
      async fetchCandidatesForDay(window) {
        return [
          {
            externalId: " today-1 ",
            publishedAt: new Date(window.dayStart.getTime() + 60 * 60 * 1000),
            sourcePayload: { id: 1 },
            authors: ["Alice", " Alice "]
          },
          {
            externalId: "today-1",
            publishedAt: new Date(window.dayStart.getTime() + 90 * 60 * 1000),
            sourcePayload: { id: "duplicate" },
            authors: ["Duplicate"]
          },
          {
            externalId: "old-1",
            publishedAt: new Date(window.dayStart.getTime() - 60 * 60 * 1000),
            sourcePayload: { id: 2 },
            authors: []
          },
          {
            externalId: "watermark-boundary",
            publishedAt: window.sourceStart,
            sourcePayload: { id: 3 },
            authors: []
          },
          {
            externalId: "before-watermark",
            publishedAt: new Date((window.sourceStart ?? window.dayStart).getTime() - 1),
            sourcePayload: { id: 4 },
            authors: []
          }
        ];
      }
    };

    const service = new DefaultDailyIngestionService(createAdapterMap([adapter]), new FakeRepository());

    const result = await service.runSourceIngestion({
      source: "arxiv",
      runDate: "2026-03-07T00:00:00.000Z"
    });

    expect(result.run.status).toBe("success");
    expect(result.run.candidatesCount).toBe(3);
    expect(result.candidates[0].externalId).toBe("today-1");
    expect(result.candidates[0].sourcePayload.id).toBe(1);
    expect(result.candidates[1].externalId).toBe("old-1");
    expect(result.candidates[2].externalId).toBe("watermark-boundary");
  });

  it("throws controlled error when adapter is missing", async () => {
    const service = new DefaultDailyIngestionService(createAdapterMap([]), new FakeRepository());

    await expect(service.runSourceIngestion({ source: "pubmed" })).rejects.toBeInstanceOf(AppError);
  });

  it("runs aggregated ingestion and preserves per-source provenance", async () => {
    const adapters: DailySourceAdapter[] = [
      {
        source: "arxiv",
        async fetchCandidatesForDay(window) {
          return [
            {
              externalId: "ax-1",
              publishedAt: new Date(window.dayStart.getTime() + 30 * 60 * 1000),
              sourcePayload: { id: "ax-1" },
              authors: ["Author A"]
            }
          ];
        }
      },
      {
        source: "pubmed",
        async fetchCandidatesForDay(window) {
          return [
            {
              externalId: "pm-1",
              publishedAt: new Date(window.dayEnd.getTime() + 1),
              indexedAt: new Date(window.dayStart.getTime() + 45 * 60 * 1000),
              sourcePayload: { id: "pm-1" },
              authors: ["Author P"]
            }
          ];
        }
      }
    ];

    const service = new DefaultDailyIngestionService(createAdapterMap(adapters), new FakeRepository());
    const result = await service.runAggregatedIngestion({
      runDate: "2026-03-07T00:00:00.000Z",
      sources: ["arxiv", "pubmed"]
    });

    expect(result.run.source).toBe("aggregated");
    expect(result.run.status).toBe("success");
    expect(result.run.candidatesCount).toBe(2);
    expect(result.sourceSummaries).toEqual([
      expect.objectContaining({
        source: "arxiv", status: "success", candidatesCount: 1,
        fetchedCount: 1, filteredCount: 0, filterMode: "watermark"
      }),
      expect.objectContaining({
        source: "pubmed", status: "success", candidatesCount: 1,
        fetchedCount: 1, filteredCount: 0, filterMode: "indexed_day"
      })
    ]);
    expect(result.candidates.map((candidate) => candidate.source)).toEqual(["arxiv", "pubmed"]);
  });

  it("continues aggregated ingestion when one source fails and another succeeds", async () => {
    const adapters: DailySourceAdapter[] = [
      {
        source: "biorxiv",
        async fetchCandidatesForDay() {
          throw new Error("bioRxiv unavailable");
        }
      },
      {
        source: "arxiv",
        async fetchCandidatesForDay(window) {
          return [
            {
              externalId: "ax-1",
              publishedAt: new Date(window.dayStart.getTime() + 30 * 60 * 1000),
              sourcePayload: { id: "ax-1" },
              authors: []
            }
          ];
        }
      }
    ];

    const service = new DefaultDailyIngestionService(createAdapterMap(adapters), new FakeRepository());
    const result = await service.runAggregatedIngestion({
      runDate: "2026-03-07T00:00:00.000Z",
      sources: ["biorxiv", "arxiv"]
    });

    expect(result.run.status).toBe("success");
    expect(result.run.candidatesCount).toBe(1);
    expect(result.sourceSummaries).toEqual([
      {
        source: "biorxiv",
        status: "failed",
        candidatesCount: 0,
        errorMessage: "bioRxiv unavailable"
      },
      expect.objectContaining({ source: "arxiv", status: "success", candidatesCount: 1 })
    ]);
    expect(result.candidates.map((candidate) => candidate.source)).toEqual(["arxiv"]);
  });

  it("classifies missing arXiv configuration before cursor or network access", async () => {
    const repository = new FakeRepository();
    const fetchMock = vi.fn();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const service = new DefaultDailyIngestionService(createAdapterMap([
      new ArxivSourceAdapter({ categoryScopes: [] }),
      {
        source: "pubmed",
        async fetchCandidatesForDay() {
          return [];
        }
      }
    ]), repository);

    const result = await service.runAggregatedIngestion({
      runDate: "2026-03-07T00:00:00.000Z",
      sources: ["arxiv", "pubmed"]
    });

    const diagnostic = {
      source: "arxiv" as const,
      failureCode: "ARXIV_SCOPE_REQUIRED" as const,
      stage: "configuration" as const,
      failureCategory: "configuration_error" as const,
      retryable: false
    };
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.getSourceCursorReadCount("arxiv")).toBe(0);
    expect(repository.getSourceCursorReadCount("pubmed")).toBe(1);
    expect(result.sourceSummaries).toEqual([
      {
        source: "arxiv",
        status: "failed",
        candidatesCount: 0,
        errorMessage: "arXiv category scope configuration is missing",
        diagnostic
      },
      expect.objectContaining({ source: "pubmed", status: "success" })
    ]);
    expect(repository.pipelineInitialization).toMatchObject({
      ingestionStatus: "partial",
      ingestionDetails: { sources: result.sourceSummaries }
    });
    expect(warn).toHaveBeenCalledWith("Daily arXiv source ingestion failed", diagnostic);

  });

  it("persists request diagnostics while preserving failed source watermarks and other sources", async () => {
    const repository = new FakeRepository();
    const oldWatermark = new Date("2026-03-05T23:59:59.999Z");
    repository.seedCursor("arxiv", oldWatermark);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const evidence = {
      endpointHost: "export.arxiv.org", categoryIndex: 2, page: 3, start: 200,
      attempts: 3, elapsedMs: 105000, attemptElapsedMs: 20000, timeoutMs: 20000,
      requestPhase: "headers", transportCode: "ETIMEDOUT"
    };
    const service = new DefaultDailyIngestionService(createAdapterMap([
      { source: "arxiv", async fetchCandidatesForDay() {
        throw new AppError("ARXIV_API_ERROR", "private upstream body", 502, {
          ...evidence, failureCategory: "timeout", responseBody: "private"
        });
      } },
      { source: "pubmed", async fetchCandidatesForDay() {
        return [{ externalId: "fixture", publishedAt: new Date("2026-03-07T12:00:00Z"),
          indexedAt: new Date("2026-03-07T12:00:00Z"), sourcePayload: {}, authors: [] }];
      } }
    ]), repository);
    const result = await service.runAggregatedIngestion({ runDate: "2026-03-07", sources: ["arxiv", "pubmed"] });
    expect(result.sourceSummaries[0]).toMatchObject({
      source: "arxiv", status: "failed", candidatesCount: 0, diagnostic: evidence
    });
    expect(repository.pipelineInitialization?.ingestionDetails.sources).toEqual(result.sourceSummaries);
    expect(await repository.getSourceCursor("arxiv")).toEqual(oldWatermark);
    expect(await repository.getSourceCursor("pubmed")).toEqual(new Date("2026-03-07T23:59:59.999Z"));
    expect(result.candidates.map(candidate => candidate.source)).toEqual(["pubmed"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("uses first-seen journal IDs after a bounded bootstrap", async () => {
    const repository = new FakeRepository();
    const adapter: DailySourceAdapter = {
      source: "journal",
      async fetchCandidatesForDay(window) {
        return [
          {
            externalId: "recent",
            publishedAt: new Date((window.sourceEnd ?? window.dayEnd).getTime() - 60_000),
            sourcePayload: {}, authors: []
          },
          {
            externalId: "historical",
            publishedAt: new Date("2020-01-01T00:00:00.000Z"),
            sourcePayload: {}, authors: []
          }
        ];
      }
    };
    const service = new DefaultDailyIngestionService(createAdapterMap([adapter]), repository);

    const first = await service.runSourceIngestion({ source: "journal", runDate: "2026-03-07" });
    expect(first.candidates.map((item) => item.externalId)).toEqual(["recent"]);
    expect(await repository.listSeenExternalIds("journal", ["recent", "historical"])).toEqual(
      new Set(["recent", "historical"])
    );
  });

  it("uses a rolling lookback and first-seen version IDs for bioRxiv", async () => {
    const repository = new FakeRepository();
    repository.seedCursor("biorxiv", new Date("2026-03-07T06:00:00.000Z"));
    repository.seedSeen("biorxiv", ["10.1101/already-seenv1"]);
    let requestedStart: Date | undefined;
    const adapter: DailySourceAdapter = {
      source: "biorxiv",
      async fetchCandidatesForDay(window) {
        requestedStart = window.sourceStart;
        return [
          { externalId: "10.1101/already-seenv1", publishedAt: window.dayStart, sourcePayload: {}, authors: [] },
          { externalId: "10.1101/new-versionv2", publishedAt: window.dayStart, sourcePayload: {}, authors: [] }
        ];
      }
    };

    const service = new DefaultDailyIngestionService(createAdapterMap([adapter]), repository);
    const result = await service.runSourceIngestion({ source: "biorxiv", runDate: "2026-03-07" });

    expect(requestedStart?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(result.candidates.map((item) => item.externalId)).toEqual(["10.1101/new-versionv2"]);
    expect(await repository.listSeenExternalIds("biorxiv", ["10.1101/new-versionv2"])).toEqual(
      new Set(["10.1101/new-versionv2"])
    );
  });
});
