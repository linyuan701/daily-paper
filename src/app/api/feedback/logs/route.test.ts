import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLogs: vi.fn()
}));

vi.mock("../../../../modules/feedback", () => ({
  createFeedbackService: () => ({
    listLogs: mocks.listLogs
  })
}));

import { GET } from "./route";

describe("/api/feedback/logs", () => {
  beforeEach(() => {
    mocks.listLogs.mockReset();
  });

  it("returns logs", async () => {
    mocks.listLogs.mockResolvedValueOnce([]);

    const response = await GET(new Request("http://localhost/api/feedback/logs?runId=run-1"));
    const payload = (await response.json()) as { status: string };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(mocks.listLogs).toHaveBeenCalledWith({
      runId: "run-1",
      candidateId: undefined,
      candidateIds: undefined,
      limit: 100
    });
  });

  it("scopes state reconstruction to feed candidates without a history limit", async () => {
    mocks.listLogs.mockResolvedValueOnce([]);

    await GET(new Request(
      "http://localhost/api/feedback/logs?runId=run-1" +
      "&candidateId=candidate-1&candidateId=candidate-2&candidateId=candidate-1&limit=500"
    ));

    expect(mocks.listLogs).toHaveBeenCalledWith({
      runId: "run-1",
      candidateId: undefined,
      candidateIds: ["candidate-1", "candidate-2"],
      limit: undefined
    });
  });

  it("does not cap a single feed candidate at 100 or 500 logs", async () => {
    mocks.listLogs.mockResolvedValueOnce([]);

    await GET(new Request(
      "http://localhost/api/feedback/logs?runId=run-1&candidateId=candidate-1"
    ));

    expect(mocks.listLogs).toHaveBeenCalledWith({
      runId: "run-1",
      candidateId: undefined,
      candidateIds: ["candidate-1"],
      limit: undefined
    });
  });
});
