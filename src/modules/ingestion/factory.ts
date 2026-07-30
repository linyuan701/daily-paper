import { getEnv } from "../../lib/config";
import { getApplicationPrismaClient } from "../../db/prisma/application-client";
import { PrismaDailyIngestionRepository, PrismaJournalFeedRepository } from "../../db/repositories";
import { ArxivSourceAdapter } from "./arxiv-adapter";
import { BioRxivSourceAdapter } from "./biorxiv-adapter";
import { createAdapterMap, DefaultDailyIngestionService } from "./ingestion-foundation.service";
import { JournalFeedSourceAdapter } from "./journal-feed-adapter";
import { PubmedSourceAdapter } from "./pubmed-adapter";
import type { DailySourceAdapter } from "./types";

export function createDailyIngestionService(adapters: DailySourceAdapter[] = []) {
  const prisma = getApplicationPrismaClient();
  const env = getEnv();
  const repository = new PrismaDailyIngestionRepository(prisma, {
    staleAfterMs: env.DAILY_RUN_STALE_AFTER_MINUTES * 60 * 1000
  });
  const journalFeedRepository = new PrismaJournalFeedRepository(prisma);
  const builtInAdapters: DailySourceAdapter[] = [
    new BioRxivSourceAdapter({
      subjectScopes: env.BIORXIV_SUBJECT_SCOPES
    }),
    new ArxivSourceAdapter({
      categoryScopes: env.ARXIV_CATEGORY_SCOPES,
      maxPages: env.ARXIV_MAX_PAGES,
      timeoutMs: env.SOURCE_HTTP_TIMEOUT_MS,
      retryBackoffMs: env.ARXIV_RETRY_BACKOFF_MS,
      retryAfterCapMs: env.ARXIV_RETRY_AFTER_CAP_MS
    }),
    new PubmedSourceAdapter({
      queryScope: env.PUBMED_QUERY_SCOPE
    }),
    new JournalFeedSourceAdapter(journalFeedRepository)
  ];

  const adapterMap = createAdapterMap([...builtInAdapters, ...adapters]);
  return new DefaultDailyIngestionService(adapterMap, repository);
}
