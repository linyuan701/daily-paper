import type { DatabaseSync } from "node:sqlite";

export type SourceRankingAuditAttempt = {
  runId: string;
  recallRunId: string;
  rerankRunId: string;
  profileSnapshotId: string;
};

type ReadonlyDatabase = Pick<DatabaseSync, "prepare">;

export function selectSourceRankingAuditAttempt(
  database: ReadonlyDatabase,
  runId?: string
): SourceRankingAuditAttempt | undefined {
  const requestedRunFilter = runId ? "AND run.id = ?" : "";
  const sourceFilter = runId ? "" : "AND run.source = 'AGGREGATED'";
  const statement = database.prepare(`
    SELECT
      rerank.runId AS runId,
      rerank.recallRunId AS recallRunId,
      rerank.id AS rerankRunId,
      rerank.profileSnapshotId AS profileSnapshotId
    FROM DailyRerankRun rerank
    JOIN DailyIngestionRun run ON run.id = rerank.runId
    JOIN DailyRecallRun recall ON recall.id = rerank.recallRunId
    WHERE rerank.status = 'SUCCESS'
      AND recall.status = 'SUCCESS'
      AND recall.runId = rerank.runId
      ${requestedRunFilter}
      ${sourceFilter}
      AND run.status = 'SUCCESS'
    ORDER BY
      COALESCE(run.finishedAt, run.startedAt) DESC,
      run.createdAt DESC,
      rerank.startedAt DESC,
      rerank.createdAt DESC
    LIMIT 1
  `);
  const row = (runId ? statement.get(runId) : statement.get()) as
    | Record<string, unknown>
    | undefined;

  if (!row) return undefined;
  return {
    runId: requiredString(row.runId, "runId"),
    recallRunId: requiredString(row.recallRunId, "recallRunId"),
    rerankRunId: requiredString(row.rerankRunId, "rerankRunId"),
    profileSnapshotId: requiredString(row.profileSnapshotId, "profileSnapshotId")
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Selected audit attempt has an invalid ${field}.`);
  }
  return value;
}
