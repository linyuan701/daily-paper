import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(), client: vi.fn(), release: vi.fn(), forbidden: vi.fn(() => { throw new Error("Forbidden side effect"); })
}));
vi.mock("../../../../lib/http/cloudflare-access", () => ({ verifySiteDashboardAccess: mocks.access }));
vi.mock("../../../../db/prisma/application-client", () => ({
  getApplicationPrismaClient: mocks.client, releaseApplicationPrismaClient: mocks.release
}));
vi.mock("../../../../jobs/daily-recommendation-pipeline", () => new Proxy({}, { get: () => mocks.forbidden }));
vi.mock("../../../../modules/scheduler/daily-pipeline", () => ({ runDailyRecommendationPipeline: mocks.forbidden }));
vi.mock("../../../../modules/profile-build/factory", () => ({
  createProfileBuildService: mocks.forbidden, createProfileRefreshService: mocks.forbidden
}));
vi.mock("../../../../modules/zotero-sync/factory", () => ({ createZoteroSyncService: mocks.forbidden }));

import { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } from "./route";

const request = (method = "GET") => new Request("https://daily.example/api/site/dashboard", { method });

function databaseFixture() {
  const date = new Date("2026-09-11T00:15:00Z");
  const later = new Date("2026-09-11T00:30:00Z");
  const profile = { id: "profile-1", status: "ACTIVE", builtAt: date, sourceLibraryVersion: 7, itemsCount: 3,
    summaryJson: { privateText: "PRIVATE_PROFILE", feedbackIntegration: { logsConsumed: 0, negativeFeedback: { signals: [] } } },
    researchTypePreferences: [] };
  const candidate = { id: "candidate-1", title: "Stored paper", publishedAt: date, doi: null, pmid: null,
    arxivId: null, bioRxivId: null, summary: null, labels: [], provenances: [] };
  const run = { id: "daily-1", requestKey: "PRIVATE_REQUEST_KEY", attempt: 1, status: "SUCCESS", pipelineStatus: "COMPLETE",
    runDate: date, startedAt: date, updatedAt: later, pipelineStartedAt: date, finishedAt: later,
    pipelineFinishedAt: later, errorMessage: null, pipelineStages: [
      { stage: "RECALL", status: "SUCCESS", startedAt: later, finishedAt: later, errorMessage: null,
        detailsJson: { recallRunId: "recall-1", recallProfileSnapshotId: "profile-1" } },
      { stage: "RERANK", status: "SUCCESS", startedAt: later, finishedAt: later, errorMessage: null,
        detailsJson: { rerankRunId: "rerank-1" } }
    ] };
  const result = { canonicalCandidateId: candidate.id, canonicalCandidate: candidate, rank: 1, selected: true,
    finalScore: 0.8, recallScore: 0.7, semanticScore: 0.6, tagOverlapScore: 0.5, researchTypeScore: 0.4,
    sourceScopeScore: 1, recentCoreScore: 0.3, stableLongTermScore: 0.2, highAttentionScore: 0.1,
    contentTagScore: 0.5, collectionWeightScore: 1, sourcePriorityScore: 1, journalQualityScore: 0,
    userCorrectedScore: 0, recencyScore: 1, reasonsJson: [], featureWeightsJson: {} };
  const rankingRun = { runId: run.id, profileSnapshotId: profile.id, status: "SUCCESS", startedAt: later,
    finishedAt: later, requestedTopN: 20, candidateCount: 1, recalledCount: 1, recommendedCount: 1,
    errorMessage: null, results: [result] };
  const reads: Record<string, ReturnType<typeof vi.fn>> = {
    "dailyIngestionRun.findMany": vi.fn(async () => [run]),
    "profileSnapshot.findFirst": vi.fn(async () => profile),
    "candidateFeedbackLog.findMany": vi.fn(async () => []),
    "dailyRecallRun.findFirst": vi.fn(async () => ({ ...rankingRun, id: "recall-1" })),
    "dailyRerankRun.findFirst": vi.fn(async () => ({ ...rankingRun, id: "rerank-1", recallRunId: "recall-1" }))
  };
  // This is the actual repository boundary. Any other model/method, transaction,
  // raw SQL or mutation is recorded and throws, even if application code catches it.
  const client = new Proxy({}, { get: (_target, model) => {
    if (typeof model !== "string" || model.startsWith("$")) return mocks.forbidden;
    return new Proxy({}, { get: (_delegate, method) => reads[`${model}.${String(method)}`] ?? mocks.forbidden });
  } });
  return { reads, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ ok: true });
  mocks.release.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", mocks.forbidden);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/site/dashboard read-only route", () => {
  it("preserves production v1 query behavior without exposing historical or wider reads", async () => {
    const { reads, client } = databaseFixture();
    mocks.client.mockReturnValue(client);
    const response = await GET(new Request("https://daily.example/api/site/dashboard?runId=other&limit=500"));
    expect(response.status).toBe(200);
    expect((await response.json()).currentRun.runId).toBe("daily-1");
    for (const [args] of reads["dailyRerankRun.findFirst"].mock.calls) expect(args.where.runId).toBe("daily-1");
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("uses the real aggregation and repositories with only allowlisted reads and releases its client", async () => {
    const { reads, client } = databaseFixture();
    mocks.client.mockReturnValue(client);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", schemaVersion: 1, currentRun: { runId: "daily-1", sha: null },
      profile: { id: "profile-1", sourceLibraryVersion: 7 }, recommendations: { items: [{ candidateId: "candidate-1" }] } });
    expect(JSON.stringify(body)).not.toContain("PRIVATE_");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.client).toHaveBeenCalledOnce();
    expect(mocks.release.mock.calls[0][0] === client).toBe(true);
    expect(mocks.forbidden).not.toHaveBeenCalled();
    expect(reads["dailyIngestionRun.findMany"]).toHaveBeenCalledWith(expect.objectContaining({ take: 10, where: { source: "AGGREGATED" } }));
    expect(reads["candidateFeedbackLog.findMany"]).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(reads["profileSnapshot.findFirst"]).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" },
      select: { id: true, status: true, builtAt: true, sourceLibraryVersion: true, itemsCount: true, summaryJson: true,
        researchTypePreferences: { select: { category: true, weight: true, itemCount: true } } } }));
    expect(reads["dailyRerankRun.findFirst"]).toHaveBeenCalledTimes(2);
    for (const [args] of reads["dailyRerankRun.findFirst"].mock.calls) expect(args.where.runId).toBe("daily-1");
  });

  it("rejects unauthenticated requests before creating a database client", async () => {
    mocks.access.mockResolvedValue({ ok: false, code: "ACCESS_TOKEN_REQUIRED" });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("reads the ranking snapshot by exact ID without replacing the active-profile getter", async () => {
    const { reads, client } = databaseFixture();
    mocks.client.mockReturnValue(client);
    const profileRead = reads["profileSnapshot.findFirst"].getMockImplementation()!;
    reads["profileSnapshot.findFirst"].mockImplementation(async (args) => {
      const profile = await profileRead();
      return args.where.id ? { ...profile, status: "SUPERSEDED" } : { ...profile, id: "new-active" };
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: { id: "new-active" },
      ranking: { profile: { id: "profile-1", status: "superseded" }, usesActiveProfile: false } });
    expect(reads["profileSnapshot.findFirst"]).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "profile-1" }
    }));
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it.each(Object.entries({ POST, PUT, PATCH, DELETE, HEAD, OPTIONS }))("rejects %s without reads or writes", async (method, handler) => {
    const response = await handler(request(method));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("fails safely without returning or logging raw database errors, including on an empty database", async () => {
    const { reads, client } = databaseFixture();
    mocks.client.mockReturnValue(client);
    reads["dailyIngestionRun.findMany"].mockResolvedValue([]);
    reads["profileSnapshot.findFirst"].mockResolvedValue(null);
    expect((await (await GET(request())).json()).recommendations).toBeNull();
    expect(reads["dailyRerankRun.findFirst"]).not.toHaveBeenCalled();
    reads["profileSnapshot.findFirst"].mockRejectedValue(new Error("postgresql://operator:PRIVATE_PASSWORD@private.example/db"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failed = await GET(request());
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ status: "error", code: "SITE_DASHBOARD_READ_FAILED" });
      expect(errorLog).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledTimes(2);
      expect(mocks.forbidden).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });
});
