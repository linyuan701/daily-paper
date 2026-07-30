import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma";
import { PrismaFeedbackLogRepository } from "./feedback-log-repository";

describe("PrismaFeedbackLogRepository.listLogs", () => {
  it("queries only current feed candidates, removes the global cap, and sorts stably", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      candidateFeedbackLog: { findMany }
    } as unknown as PrismaClient;
    const repository = new PrismaFeedbackLogRepository(db);

    await repository.listLogs({
      runId: "run-1",
      candidateIds: ["candidate-2", "candidate-1", "candidate-2"]
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        candidateId: { in: ["candidate-2", "candidate-1"] }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
  });

  it("keeps the bounded legacy log listing behavior for non-feed callers", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaFeedbackLogRepository({
      candidateFeedbackLog: { findMany }
    } as unknown as PrismaClient);

    await repository.listLogs({ runId: "run-1", limit: 500 });

    expect(findMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 500
    });
  });
});
