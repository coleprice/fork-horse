import type { Claim, Packet, RaceEntrant, RaceResult, RaceState, Review } from "./workflow-types";

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

const milestones = ["createdAt", "firstPushAt", "reviewRequestedAt", "receiptPassedAt", "approvedAt", "promotedAt"] as const;
function progress(entrant: RaceEntrant): { rank: number; at: string } {
  for (let rank = milestones.length - 1; rank >= 0; rank--) {
    const at = entrant[milestones[rank]!];
    if (at !== null) return { rank, at };
  }
  throw new Error("Race entrant has no claim time");
}

/** Rank the finish snapshot before closing entrants; withdrawals always follow runners. */
export function placedEntrants(records: RaceEntrant[], winner: string): RaceEntrant[] {
  return records.toSorted((a, b) => {
    if (a.agent === b.agent) return 0;
    if (a.agent === winner) return -1;
    if (b.agent === winner) return 1;
    const closed = Number(a.closedAt !== null) - Number(b.closedAt !== null);
    if (closed) return closed;
    const left = progress(a), right = progress(b);
    return right.rank - left.rank || Date.parse(left.at) - Date.parse(right.at) || a.agent.localeCompare(b.agent);
  });
}

/** Separate from the refused promotion's transaction; never overwrites a first refusal. */
export async function recordPromoteRejected(storage: DurableObjectStorage, review: Review, found: string): Promise<void> {
  const at = new Date().toISOString();
  await storage.transaction(async txn => {
    const key = entrantKey(review.packet, review.agent);
    const entrant = await txn.get<RaceEntrant>(key);
    if (entrant && entrant.repoName === review.repoName && !entrant.promoteRejected)
      await txn.put(key, { ...entrant, promoteRejected: { at, expected: review.base, found } });
  });
}

/** Finish metadata and entrants are committed together by the successful promote. */
export async function raceStates(storage: Storage, packets: Packet[]): Promise<RaceState[]> {
  const records = await entrants(storage);
  const results = await storage.list<RaceResult>({ prefix: "race:" });
  return packets.filter(packet => packet.mode === "race").map(packet => {
    const result = results.get(`race:${packet.id}`);
    return {
      packet: packet.id, status: result ? "finished" : "open",
      finishedAt: result?.finishedAt ?? null, winner: result?.winner ?? null,
      ledgerEntryId: result?.ledgerEntryId ?? null, places: result?.places ?? [],
      entrants: records.filter(entrant => entrant.packet === packet.id)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agent.localeCompare(b.agent))
        .map(({ packet: _packet, paths: _paths, createdAt, ...entrant }) => ({
          ...entrant, claimedAt: createdAt, promoteRejected: entrant.promoteRejected ?? null,
        })),
    };
  });
}
