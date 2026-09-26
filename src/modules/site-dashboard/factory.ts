import { getApplicationPrismaClient, releaseApplicationPrismaClient } from "../../db/prisma/application-client";
import { PrismaOperationsRepository } from "../../db/repositories/operations-repository";
import { PrismaProfileSnapshotRepository } from "../../db/repositories/profile-snapshot-repository";
import { PrismaFeedbackLogRepository } from "../../db/repositories/feedback-log-repository";
import { PrismaRecallRankingRepository } from "../../db/repositories/recall-ranking-repository";
import { PrismaRerankRepository } from "../../db/repositories/rerank-repository";
import { PrismaDailyRecommendationRepository } from "../../db/repositories/daily-recommendations-repository";
import { OperationsService } from "../operations/operations.service";
import { DefaultDailyRecommendationService } from "../ranking/explain/daily-recommendations.service";
import { readSiteDashboard } from "./service";

// Only read methods enter the aggregator. No pipeline, refresh or sync factories.
export async function getSiteDashboard() {
  const db = getApplicationPrismaClient();
  const operations = new OperationsService(new PrismaOperationsRepository(db));
  const profiles = new PrismaProfileSnapshotRepository(db);
  const feedback = new PrismaFeedbackLogRepository(db);
  const recall = new PrismaRecallRankingRepository(db);
  const rerank = new PrismaRerankRepository(db);
  const recommendations = new DefaultDailyRecommendationService(new PrismaDailyRecommendationRepository(db));
  try {
    return await readSiteDashboard({
      listRuns: () => operations.listRecentRuns(10),
      getProfile: (id) => profiles.getSnapshotForDashboard(id),
      listFeedback: () => feedback.listLogs({ limit: 100 }),
      getRecall: (runId) => recall.getLatestRecallRun({ runId }),
      getRerank: (runId) => rerank.getLatestRerankRun(runId),
      getFeed: (runId) => recommendations.getDailyFeed({ runId, selectedOnly: true })
    });
  } finally {
    await releaseApplicationPrismaClient(db);
  }
}
