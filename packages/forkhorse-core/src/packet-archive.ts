import { HttpError } from "./http";
import { publicPacket } from "./packets";
import type { Blocker, Packet, PacketArchiveAudit, Review } from "./workflow-types";

/** FH-048 records; absent legacy resolution and pushing identity remain open/null. */
type ArchiveBlocker = Pick<Blocker, "packet"> & {
  resolved?: unknown | null;
  pushingPacket?: string | null;
};

/** The race dependency supplies its live-entrant reader inside this transaction. */
export type HasOpenRaceEntrant = (txn: DurableObjectTransaction, packet: string) => Promise<boolean>;

/** Called only after owner authorization, under the Supervisor serialization gate. */
export async function archivePacket(
  storage: DurableObjectStorage,
  packetId: string,
  action: PacketArchiveAudit["action"],
  hasOpenRaceEntrant: HasOpenRaceEntrant,
): Promise<Packet> {
  return storage.transaction(async txn => {
    const stored = await txn.get<Packet>(`packet:${packetId}`);
    if (!stored) throw new HttpError(404, "Packet not found.");
    const packet = publicPacket(stored);
    // Repeats preserve the timestamp and audit, even if later history is inconsistent.
    if ((action === "archive") === (packet.archived !== null)) return packet;
    if (action === "archive") {
      if (await txn.get(`claim:${packetId}`) || await hasOpenRaceEntrant(txn, packetId))
        throw new HttpError(409, "Packet has a live claim.");
      const reviews = await txn.list<Review>({ prefix: "review:" });
      if ([...reviews.values()].some(review => review.packet === packetId &&
          !review.promoted && !review.stale && !review.returned))
        throw new HttpError(409, "Packet has an open review.");
      const blockers = await txn.list<ArchiveBlocker>({ prefix: "blocker:" });
      if ([...blockers.values()].some(blocker => blocker.resolved == null &&
          (blocker.packet === packetId || blocker.pushingPacket === packetId)))
        throw new HttpError(409, "Packet has an open blocker.");
    }
    // Keep the fixed timestamp key unique during rapid transitions in one millisecond.
    const previous = [...(await txn.list<PacketArchiveAudit>({
      prefix: `packetArchive:${packetId}:`, reverse: true, limit: 1,
    })).values()][0];
    const recordedAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.recordedAt) + 1 : 0)).toISOString();
    packet.archived = action === "archive" ? { at: recordedAt, by: "owner" } : null;
    const audit: PacketArchiveAudit = { packet: packetId, action, by: "owner", recordedAt };
    await txn.put({ [`packet:${packetId}`]: packet, [`packetArchive:${packetId}:${recordedAt}`]: audit });
    return packet;
  });
}
