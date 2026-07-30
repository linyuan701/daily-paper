import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { selectSourceRankingAuditAttempt } from "./sqlite-attempt-selection";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");

describe("selectSourceRankingAuditAttempt", () => {
  let database: DatabaseSyncType | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("loads recall and profile identifiers from the selected rerank attempt", () => {
    database = createDatabase();
    insertRun(database, "run-1", "2026-07-29T03:00:00Z");
    insertRecall(database, "recall-used", "run-1", "profile-recall-used", "2026-07-29T03:01:00Z");
    insertRecall(database, "recall-unused", "run-1", "profile-recall-unused", "2026-07-29T03:04:00Z");
    insertRerank(database, {
      id: "rerank-selected",
      runId: "run-1",
      recallRunId: "recall-used",
      profileSnapshotId: "profile-rerank-selected",
      startedAt: "2026-07-29T03:02:00Z"
    });

    expect(selectSourceRankingAuditAttempt(database, "run-1")).toEqual({
      runId: "run-1",
      recallRunId: "recall-used",
      rerankRunId: "rerank-selected",
      profileSnapshotId: "profile-rerank-selected"
    });
  });

  it("selects the latest successful rerank while preserving its exact recall linkage", () => {
    database = createDatabase();
    insertRun(database, "run-1", "2026-07-29T03:00:00Z");
    insertRecall(database, "recall-first", "run-1", "profile-first", "2026-07-29T03:01:00Z");
    insertRecall(database, "recall-second", "run-1", "profile-second", "2026-07-29T03:03:00Z");
    insertRecall(database, "recall-unpaired-latest", "run-1", "profile-unpaired", "2026-07-29T03:06:00Z");
    insertRerank(database, {
      id: "rerank-first",
      runId: "run-1",
      recallRunId: "recall-first",
      profileSnapshotId: "profile-first",
      startedAt: "2026-07-29T03:02:00Z"
    });
    insertRerank(database, {
      id: "rerank-second",
      runId: "run-1",
      recallRunId: "recall-second",
      profileSnapshotId: "profile-second",
      startedAt: "2026-07-29T03:04:00Z"
    });

    expect(selectSourceRankingAuditAttempt(database, "run-1")).toMatchObject({
      recallRunId: "recall-second",
      rerankRunId: "rerank-second",
      profileSnapshotId: "profile-second"
    });
  });
});

function createDatabase(): DatabaseSyncType {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE DailyIngestionRun (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE DailyRecallRun (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      profileSnapshotId TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE DailyRerankRun (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      recallRunId TEXT NOT NULL,
      profileSnapshotId TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
  return database;
}

function insertRun(database: DatabaseSyncType, id: string, startedAt: string): void {
  database.prepare(`
    INSERT INTO DailyIngestionRun (id, source, status, startedAt, finishedAt, createdAt)
    VALUES (?, 'AGGREGATED', 'SUCCESS', ?, ?, ?)
  `).run(id, startedAt, startedAt, startedAt);
}

function insertRecall(
  database: DatabaseSyncType,
  id: string,
  runId: string,
  profileSnapshotId: string,
  startedAt: string
): void {
  database.prepare(`
    INSERT INTO DailyRecallRun (id, runId, profileSnapshotId, status, startedAt, createdAt)
    VALUES (?, ?, ?, 'SUCCESS', ?, ?)
  `).run(id, runId, profileSnapshotId, startedAt, startedAt);
}

function insertRerank(
  database: DatabaseSyncType,
  input: {
    id: string;
    runId: string;
    recallRunId: string;
    profileSnapshotId: string;
    startedAt: string;
  }
): void {
  database.prepare(`
    INSERT INTO DailyRerankRun (
      id, runId, recallRunId, profileSnapshotId, status, startedAt, createdAt
    ) VALUES (?, ?, ?, ?, 'SUCCESS', ?, ?)
  `).run(
    input.id,
    input.runId,
    input.recallRunId,
    input.profileSnapshotId,
    input.startedAt,
    input.startedAt
  );
}
