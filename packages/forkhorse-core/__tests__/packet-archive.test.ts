import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { archivePacket } from "../src/packet-archive";
import type { Packet, PacketArchiveAudit } from "../src/workflow-types";

const packet: Packet = { id: "done", title: "Done", goal: "Fixture", paths: ["src"], acceptance: ["Check"], archived: null };
async function inside(callback: (storage: DurableObjectStorage) => Promise<void>) {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(`archive-${crypto.randomUUID().slice(0, 8)}`));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("packet:done", packet);
    await callback(state.storage);
  });
}
async function audits(storage: DurableObjectStorage) {
  return [...(await storage.list<PacketArchiveAudit>({ prefix: "packetArchive:" })).values()];
}

describe("FH-050 archive transaction in workerd with explicit dependency fixtures", () => {
  it.each([
    ["claim:done", { packet: "done" }, "Packet has a live claim."],
    ["review:open", { packet: "done", promoted: false, stale: false, returned: null }, "Packet has an open review."],
    ["review:legacy", { packet: "done", promoted: false, stale: false }, "Packet has an open review."],
    ["blocker:claimant", { packet: "done", pushingPacket: "other", resolved: null }, "Packet has an open blocker."],
    ["blocker:pusher", { packet: "other", pushingPacket: "done", resolved: null }, "Packet has an open blocker."],
    ["blocker:legacy", { packet: "done" }, "Packet has an open blocker."],
  ])("refuses %s without changing packet or history", async (key, value, message) => {
    await inside(async storage => {
      await storage.put(key as string, value);
      const before = await storage.list();
      await expect(archivePacket(storage, "done", "archive")).rejects.toMatchObject({ status: 409, message });
      expect(await storage.list()).toEqual(before);
    });
  });

  it("refuses an open entrant using the fixed race storage contract", async () => {
    await inside(async storage => {
      // Fixed FH-052 record shape supplied as a fixture before dependency integration.
      await storage.put("entrant:done:alpha", {
        packet: "done", agent: "alpha", repoName: "fixture--alpha-1", paths: ["src"],
        createdAt: "2026-10-13T14:19:00.000Z", firstPushAt: null,
        reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null,
        promotedAt: null, place: null, closedAt: null, closedBy: null,
      });
      await expect(archivePacket(storage, "done", "archive")).rejects.toMatchObject({ status: 409, message: "Packet has a live claim." });
      expect(await audits(storage)).toEqual([]);
      expect(await storage.get("packet:done")).toEqual(packet);
    });
  });

  it("preserves closed reviews, resolved/foreign blockers, receipts, activity and ledger", async () => {
    await inside(async storage => {
      const history = {
        "review:promoted": { packet: "done", promoted: true, stale: false, returned: null },
        "review:stale": { packet: "done", promoted: false, stale: true, returned: null },
        "review:returned": { packet: "done", promoted: false, stale: false, returned: { reason: "Revise", at: "fixture" } },
        "review:other": { packet: "other", promoted: false, stale: false, returned: null },
        "blocker:resolved": { packet: "done", pushingPacket: "done", resolved: { at: "fixture", by: "owner" } },
        "blocker:other": { packet: "other", pushingPacket: null, resolved: null },
        "claim:other": { packet: "other" },
        "entrant:done:closed": { packet: "done", agent: "closed", closedAt: "2026-10-13T14:19:00.000Z", closedBy: "release" },
        "entrant:done-other:open": { packet: "done-other", agent: "open", closedAt: null },
        "receipt:digest": { outcome: "passed" },
        "activity:0000000000000001": { sequence: 1 },
        "ledger:old": { review: "promoted" },
      };
      await storage.put(history);
      const archived = await archivePacket(storage, "done", "archive");
      expect(archived.archived).toEqual({ at: expect.any(String), by: "owner" });
      expect(await audits(storage)).toEqual([{ packet: "done", action: "archive", by: "owner", recordedAt: archived.archived!.at }]);
      await storage.put("claim:done", { packet: "done" });
      expect(await archivePacket(storage, "done", "archive")).toEqual(archived);
      expect(await audits(storage)).toHaveLength(1);
      const active = await archivePacket(storage, "done", "unarchive");
      expect(active.archived).toBeNull();
      expect(await archivePacket(storage, "done", "unarchive")).toEqual(active);
      expect((await audits(storage)).map(a => a.action)).toEqual(["archive", "unarchive"]);
      for (const [key, value] of Object.entries(history)) expect(await storage.get(key)).toEqual(value);
    });
  });

  it("keeps rapid transition audit keys distinct", async () => {
    await inside(async storage => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-13T14:19:00.000Z"));
      try {
        for (const action of ["archive", "unarchive", "archive", "unarchive"] as const)
          await archivePacket(storage, "done", action);
        const entries = await audits(storage);
        expect(entries.map(a => a.action)).toEqual(["archive", "unarchive", "archive", "unarchive"]);
        expect(new Set(entries.map(a => a.recordedAt)).size).toBe(4);
      } finally { vi.restoreAllMocks(); }
    });
  });

  it("normalizes legacy packets, refuses unknown packets and rolls back a failed audit write", async () => {
    await inside(async storage => {
      const legacy = { ...packet } as Partial<Packet>;
      delete legacy.archived;
      await storage.put("packet:done", legacy);
      expect((await archivePacket(storage, "done", "unarchive")).archived).toBeNull();
      expect(await storage.get("packet:done")).toEqual(legacy);
      for (const action of ["archive", "unarchive"] as const)
        await expect(archivePacket(storage, "missing", action)).rejects.toMatchObject({ status: 404 });
      const transaction = storage.transaction.bind(storage);
      vi.spyOn(storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          throw new Error("offline audit persistence failure");
        });
        return callback(txn);
      }));
      try {
        await expect(archivePacket(storage, "done", "archive")).rejects.toThrow("offline audit persistence failure");
        expect(await storage.get("packet:done")).toEqual(legacy);
        expect(await audits(storage)).toEqual([]);
      } finally { vi.restoreAllMocks(); }
      expect((await archivePacket(storage, "done", "archive")).archived).not.toBeNull();
    });
  });
});
