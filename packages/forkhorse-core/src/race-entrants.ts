import type { Claim, Packet, RaceEntrant, RaceState } from "./workflow-types";

export type { RaceEntrant } from "./workflow-types";

type Storage = DurableObjectStorage | DurableObjectTransaction;
export const MAX_RACE_ENTRANTS = 3;
export const entrantKey = (packet: string, agent: string) => `entrant:${packet}:${agent}`;
export const publicPacket = (packet: Packet) => ({ ...packet, mode: packet.mode ?? "standard" });

export async function entrants(storage: Storage, packet?: string): Promise<RaceEntrant[]> {
  return [...(await storage.list<RaceEntrant>({
    prefix: packet === undefined ? "entrant:" : `entrant:${packet}:`,
  })).entries()]
    .filter(([key, entrant]) => key === entrantKey(entrant.packet, entrant.agent))
    .map(([, entrant]) => entrant);
}

/** Shared archive/claim boundary: only closedAt === null is open. Never deletes history. */
export async function openEntrants(storage: Storage, packet?: string): Promise<RaceEntrant[]> {
  return (await entrants(storage, packet)).filter(entrant => entrant.closedAt === null);
}

/** Standard records retain their existing key and shape. Race lookup is caller-scoped. */
export async function claimForAgent(storage: Storage, packet: string, agent: string): Promise<Claim | undefined> {
  if ((await storage.get<Packet>(`packet:${packet}`))?.mode !== "race")
    return storage.get<Claim>(`claim:${packet}`);
  const entrant = await storage.get<RaceEntrant>(entrantKey(packet, agent));
  return entrant?.closedAt === null ? entrant : undefined;
}

export async function liveClaims(storage: Storage): Promise<Claim[]> {
  return [...(await storage.list<Claim>({ prefix: "claim:" })).values(), ...await openEntrants(storage)];
}

type Milestone = "firstPushAt" | "reviewRequestedAt" | "receiptPassedAt" | "approvedAt" | "promotedAt";
/** Call inside the same transaction as the milestone's authoritative event. */
export async function markEntrant(
  storage: Storage, claim: Pick<Claim, "packet" | "agent" | "repoName">,
  milestone: Milestone, at: string,
): Promise<void> {
  const key = entrantKey(claim.packet, claim.agent);
  const entrant = await storage.get<RaceEntrant>(key);
  if (entrant?.closedAt === null && entrant.repoName === claim.repoName && entrant[milestone] === null)
    await storage.put(key, { ...entrant, [milestone]: at });
}

/** FH-053 owns the finish record; absent finish metadata stays explicitly null. */
export async function raceStates(storage: Storage, packets: Packet[]): Promise<RaceState[]> {
  const records = await entrants(storage);
  return packets.filter(packet => packet.mode === "race").map(packet => ({
    packet: packet.id, status: "open", finishedAt: null, winner: null, ledgerEntryId: null,
    entrants: records.filter(entrant => entrant.packet === packet.id)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agent.localeCompare(b.agent))
      .map(({ packet: _packet, paths: _paths, createdAt, ...entrant }) => ({ ...entrant, claimedAt: createdAt })),
  }));
}
