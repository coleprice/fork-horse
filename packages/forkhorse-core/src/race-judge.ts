import { HttpError } from "./http";
import { entrantKey, entrants } from "./race-entrants";
import type { Packet, RaceEntrant, RaceRecord, RaceVerdict, Review } from "./workflow-types";

type Storage = DurableObjectStorage | DurableObjectTransaction;

/** A verdict-only record does not finish a race or block an owner promotion. */
export async function raceFinished(storage: Storage, packet: string): Promise<boolean> {
  return Boolean((await storage.get<RaceRecord>(`race:${packet}`))?.finishedAt);
}

/** The sole cross-agent review exception: immutable judge and exact entrant binding. */
export async function judgeMayRead(storage: Storage, agent: string | undefined, review: Review): Promise<boolean> {
  if (!agent) return false;
  const packet = await storage.get<Packet>(`packet:${review.packet}`);
  if (packet?.mode !== "race" || packet.judge !== agent) return false;
  const entrant = await storage.get<RaceEntrant>(entrantKey(review.packet, review.agent));
  return entrant?.packet === review.packet && entrant.agent === review.agent && entrant.repoName === review.repoName;
}

/** Invoked under the Supervisor gate; persist the roster check and advice together. */
export async function saveVerdict(storage: DurableObjectStorage, packet: string, data: Record<string, unknown>): Promise<RaceVerdict> {
  return storage.transaction(async txn => {
    const key = `race:${packet}`;
    const current = await txn.get<RaceRecord>(key);
    if (current?.finishedAt) throw new HttpError(409, "Race finished.");
    const roster = await entrants(txn, packet);
    const { ranking, rationale } = data;
    if (!Array.isArray(ranking) || ranking.length !== roster.length ||
        !ranking.every(agent => typeof agent === "string" && roster.some(entrant => entrant.agent === agent)) ||
        new Set(ranking).size !== ranking.length ||
        typeof rationale !== "string" || rationale.trim().length === 0 || rationale.length > 2000)
      throw new HttpError(400, "ranking must be a permutation of the current entrants; rationale must be 1–2000 characters.");
    const verdict: RaceVerdict = { ranking, rationale, at: new Date().toISOString() };
    await txn.put(key, { ...current, verdict } satisfies RaceRecord);
    return verdict;
  });
}
