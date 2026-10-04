import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient as RepositoryPrismaClient } from "../../generated/prisma";
import { PrismaClient as PostgresqlPrismaClient } from "../../generated/prisma-postgresql";
import { PrismaProfileSnapshotRepository } from "./profile-snapshot-repository";

const baseUrl = process.env.TEST_POSTGRES_DATABASE_URL?.trim();
const describePostgresql = baseUrl ? describe : describe.skip;
const schemaName = `daily_paper_profile_${randomBytes(8).toString("hex")}`;
let client: PostgresqlPrismaClient | undefined;
let repository: PrismaProfileSnapshotRepository;

type SnapshotInput = Parameters<PrismaProfileSnapshotRepository["saveActiveSnapshot"]>[0];

describePostgresql("PostgreSQL profile snapshot replacement", () => {
  beforeAll(() => {
    const url = new URL(baseUrl!);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error("TEST_POSTGRES_DATABASE_URL must use postgresql: or postgres:.");
    }
    url.searchParams.set("schema", schemaName);
    const databaseUrl = url.toString();
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/postgresql/schema.prisma"],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    client = new PostgresqlPrismaClient({ datasourceUrl: databaseUrl });
    repository = new PrismaProfileSnapshotRepository(client as unknown as RepositoryPrismaClient);
  }, 120_000);

  beforeEach(async () => {
    await client!.profileSnapshot.deleteMany();
    await client!.zoteroItemRaw.deleteMany();
  });

  afterAll(async () => {
    if (!client) return;
    if (!/^daily_paper_profile_[a-f0-9]{16}$/.test(schemaName)) {
      throw new Error("Refusing to clean up an unexpected PostgreSQL schema name.");
    }
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.$disconnect();
  }, 30_000);

  it("replaces a snapshot atomically after a database write exceeds the former five-second deadline", async () => {
    const input = await createInput(1_000);
    const previous = await repository.saveActiveSnapshot(input);
    // Delay the supersede UPDATE in PostgreSQL, leaving the subsequent nested CREATE
    // beyond Prisma's former 5s interactive-transaction deadline, as in the incident.
    await client!.$executeRawUnsafe(`
      CREATE FUNCTION "${schemaName}".delay_profile_supersede() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(6);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client!.$executeRawUnsafe(`
      CREATE TRIGGER delay_profile_supersede BEFORE UPDATE ON "${schemaName}"."ProfileSnapshot"
      FOR EACH ROW WHEN (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED')
      EXECUTE FUNCTION "${schemaName}".delay_profile_supersede()
    `);

    try {
      const startedAt = performance.now();
      const snapshot = await repository.saveActiveSnapshot(input);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(6_000);
      expect(snapshot.id).not.toBe(previous.id);
      expect(snapshot).toMatchObject({ status: "active", itemsCount: 1_000, sourceLibraryVersion: 42 });
      await expectActiveSnapshot(snapshot.id);
      await expect(client!.profileSnapshot.findUnique({ where: { id: previous.id } }))
        .resolves.toMatchObject({ status: "SUPERSEDED" });
      await expect(client!.profileSnapshotItemSignal.count({ where: { snapshotId: snapshot.id } }))
        .resolves.toBe(1_000);
      await expect(client!.profileSnapshotItemSignal.findFirst({
        where: { snapshotId: snapshot.id, itemId: input.items[0].itemId }
      })).resolves.toMatchObject({
        segment: "RECENT_CORE", finalWeight: 2.5, representationSource: "STRUCTURED_TAGS",
        contentRecallLabel: "Single-cell analysis", researchCategory: "METHOD"
      });
      expect(snapshot.researchTypePreferences).toEqual(input.researchPreferences);
    } finally {
      await client!.$executeRawUnsafe(`DROP TRIGGER delay_profile_supersede ON "${schemaName}"."ProfileSnapshot"`);
      await client!.$executeRawUnsafe(`DROP FUNCTION "${schemaName}".delay_profile_supersede()`);
    }
  }, 30_000);

  it("rolls back superseding and every nested row on failure, then allows a later successful replacement", async () => {
    const input = await createInput(3);
    const previous = await repository.saveActiveSnapshot(input);
    const invalid: SnapshotInput = {
      ...input,
      items: [...input.items, { ...input.items[0], itemId: `missing-${randomUUID()}` }]
    };

    await expect(repository.saveActiveSnapshot(invalid)).rejects.toMatchObject({ code: "P2003" });
    await expectActiveSnapshot(previous.id);
    await expect(client!.profileSnapshot.count()).resolves.toBe(1);
    await expect(client!.profileSnapshotItemSignal.count()).resolves.toBe(3);
    await expect(client!.profileSnapshotResearchTypePreference.count()).resolves.toBe(1);

    const replacement = await repository.saveActiveSnapshot(input);
    await expectActiveSnapshot(replacement.id);
    await expect(client!.profileSnapshot.count()).resolves.toBe(2);
    await expect(client!.profileSnapshotItemSignal.count()).resolves.toBe(6);
  });

  it("preserves empty snapshot behavior", async () => {
    const snapshot = await repository.saveActiveSnapshot({ items: [], researchPreferences: [], summaryJson: {} });
    expect(snapshot).toMatchObject({
      itemsCount: 0, sourceLibraryVersion: undefined,
      segments: { recentCore: 0, stableLongTerm: 0, background: 0 }, researchTypePreferences: []
    });
    await expectActiveSnapshot(snapshot.id);
  });
});

async function createInput(count: number): Promise<SnapshotInput> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await client!.zoteroItemRaw.createMany({
    data: ids.map((id) => ({ id, zoteroItemKey: id, sourcePayloadJson: {}, syncedAt: new Date() }))
  });
  return {
    sourceLibraryVersion: 42,
    items: ids.map((itemId) => ({
      itemId, segment: "recent_core", finalWeight: 2.5, collectionWeight: 1,
      attentionWeight: 2.2, recencyWeight: 1.3, representationSource: "structured_tags",
      contentRecallLabel: "Single-cell analysis", researchCategory: "method",
      representationText: "Single-cell analysis"
    })),
    researchPreferences: [{ category: "method", weight: 1, itemCount: count }],
    summaryJson: { segmentCounts: { recentCore: count, stableLongTerm: 0, background: 0 } }
  };
}

async function expectActiveSnapshot(id: string) {
  await expect(client!.profileSnapshot.findMany({ where: { status: "ACTIVE" }, select: { id: true } }))
    .resolves.toEqual([{ id }]);
}
