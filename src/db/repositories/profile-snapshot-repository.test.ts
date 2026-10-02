import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma";
import { PrismaProfileSnapshotRepository } from "./profile-snapshot-repository";

type SnapshotInput = Parameters<PrismaProfileSnapshotRepository["saveActiveSnapshot"]>[0];

function input(): SnapshotInput {
  return {
    sourceLibraryVersion: 42,
    items: [{
      itemId: "item-1",
      segment: "recent_core",
      finalWeight: 2.5,
      collectionWeight: 1,
      attentionWeight: 2.2,
      recencyWeight: 1.3,
      representationSource: "structured_tags",
      contentRecallLabel: "Single-cell analysis",
      researchCategory: "method",
      representationText: "Single-cell analysis"
    }],
    researchPreferences: [{ category: "method", weight: 1, itemCount: 1 }],
    summaryJson: { segmentCounts: { recentCore: 1, stableLongTerm: 0, background: 0 } }
  };
}

function fixture() {
  const create = vi.fn().mockResolvedValue({
    id: "snapshot-1",
    status: "ACTIVE",
    builtAt: new Date("2026-10-02T00:00:00.000Z"),
    sourceLibraryVersion: 42,
    itemsCount: 1,
    summaryJson: input().summaryJson,
    researchTypePreferences: [{ category: "METHOD", weight: 1, itemCount: 1 }]
  });
  const tx = { profileSnapshot: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create } };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  const repository = new PrismaProfileSnapshotRepository({ $transaction: transaction } as unknown as PrismaClient);
  return { create, tx, transaction, repository };
}

describe("PrismaProfileSnapshotRepository snapshot persistence", () => {
  it("gives the atomic replacement a bounded bulk-write timeout and preserves mapping", async () => {
    const { repository, transaction, tx, create } = fixture();
    const result = await repository.saveActiveSnapshot(input());

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
    expect(tx.profileSnapshot.updateMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE" }, data: { status: "SUPERSEDED" }
    });
    expect(tx.profileSnapshot.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        status: "ACTIVE",
        sourceLibraryVersion: 42,
        itemsCount: 1,
        summaryJson: input().summaryJson,
        itemSignals: { createMany: { data: [{
          itemId: "item-1", segment: "RECENT_CORE", finalWeight: 2.5,
          collectionWeight: 1, attentionWeight: 2.2, recencyWeight: 1.3,
          representationSource: "STRUCTURED_TAGS", contentRecallLabel: "Single-cell analysis",
          researchCategory: "METHOD", representationText: "Single-cell analysis"
        }] } },
        researchTypePreferences: { createMany: { data: [{ category: "METHOD", weight: 1, itemCount: 1 }] } }
      },
      include: { researchTypePreferences: true }
    });
    expect(result).toEqual({
      id: "snapshot-1", status: "active", builtAt: "2026-10-02T00:00:00.000Z",
      sourceLibraryVersion: 42, itemsCount: 1,
      segments: { recentCore: 1, stableLongTerm: 0, background: 0 },
      researchTypePreferences: [{ category: "method", weight: 1, itemCount: 1 }]
    });
  });

  it("prepares large bulk payloads before opening the transaction", async () => {
    const { repository, transaction, create } = fixture();
    const value = input();
    value.items = Array.from({ length: 1_000 }, (_, index) => ({
      ...value.items[0],
      itemId: `item-${index}`,
      get representationText() {
        expect(transaction).not.toHaveBeenCalled();
        return `Representation ${index}`;
      }
    }));

    await repository.saveActiveSnapshot(value);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data.itemSignals.createMany.data).toHaveLength(1_000);
    expect(create.mock.calls[0][0].data.itemsCount).toBe(1_000);
  });

  it.each(["updateMany", "create"] as const)("propagates %s failures without a non-transactional fallback or retry", async (operation) => {
    const { repository, transaction, tx, create } = fixture();
    const error = new Error("database write failed");
    tx.profileSnapshot[operation].mockRejectedValueOnce(error);

    await expect(repository.saveActiveSnapshot(input())).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(operation === "create" ? 1 : 0);
  });
});
