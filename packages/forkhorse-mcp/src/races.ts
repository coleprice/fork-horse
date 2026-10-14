import { z } from "zod";
import { PublicError } from "./core";
import { budgetStateSchema, usageSourcesSchema } from "./usage";

// FH-052/053 wire seam only. Core owns enrollment, milestones and placings.
const name = z.string().min(1);
const agentName = z
  .string()
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const forkName = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const packetId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const timestamp = z.string().min(1).nullable();
const entrant = z
  .object({
    agent: agentName,
    repoName: forkName,
    claimedAt: z.string().min(1),
    firstPushAt: timestamp,
    reviewRequestedAt: timestamp,
    receiptPassedAt: timestamp,
    approvedAt: timestamp,
    promotedAt: timestamp,
    place: z.number().int().min(1).max(3).nullable(),
    closedAt: timestamp,
    closedBy: z.enum(["release", "owner", "race-finished"]).nullable(),
    promoteRejected: z.object({ at: name, expected: name, found: name }).nullable().optional(),
    usage: usageSourcesSchema.optional(),
    budget: budgetStateSchema.optional(),
  })
  .passthrough();
const race = z
  .object({
    packet: packetId,
    tokenBudget: z.number().int().positive().nullable().optional(),
    status: z.enum(["open", "finished"]),
    finishedAt: timestamp,
    winner: agentName.nullable(),
    // This is ledger[].id, never a numeric sequence.
    ledgerEntryId: name.nullable(),
    // Integrated FH-053 exposes the finish's agent/place summary as well.
    places: z
      .array(z.object({ agent: agentName, place: z.number().int().min(1).max(3) }))
      .max(3)
      .optional(),
    entrants: z.array(entrant).max(3),
    judge: agentName.nullable().optional(),
    verdict: z
      .object({
        ranking: z
          .array(agentName)
          .max(3)
          .refine(
            (ranking) => new Set(ranking).size === ranking.length,
            "Duplicate entrants are not allowed.",
          ),
        rationale: z.string().min(1).max(2000),
        at: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
const packets = z.array(
  z.object({ id: packetId, mode: z.enum(["standard", "race"]).default("standard") }).passthrough(),
);
const races = z.array(race);
export type RaceState = z.infer<typeof race>;

/** Legacy state has no races; supplied race data must satisfy the fixed contract. */
export function raceSnapshot(snapshot: Record<string, unknown>) {
  return {
    packets: snapshot.packets === undefined ? undefined : packets.parse(snapshot.packets),
    races: snapshot.races === undefined ? [] : races.parse(snapshot.races),
  };
}

export function callerRaces(states: RaceState[], agent: string): RaceState[] {
  // Include closed entries: /me contains live work, standings retain race history.
  return states.filter((state) => state.entrants.some((entry) => entry.agent === agent));
}

/** Judge assignments come only from public core state, never from client arguments. */
export function judgeRaces(states: RaceState[], agent: string): RaceState[] {
  return states.filter((state) => state.judge === agent);
}

/** Select a live race binding without ever falling back to a standard claim. */
export function raceBinding(
  state: ReturnType<typeof raceSnapshot>,
  packet: string,
  agent: string,
): { packet: string; agent: string; repoName: string } | undefined {
  const metadata = state.packets?.filter((entry) => entry.id === packet) ?? [];
  const standings = state.races.filter((entry) => entry.packet === packet);
  if (metadata.length > 1 || standings.length > 1)
    throw new PublicError(409, "Exactly one race packet binding is required.");
  if (metadata[0]?.mode !== "race" && standings.length === 0) return undefined;
  if (metadata[0]?.mode === "standard")
    throw new PublicError(409, "Race state disagrees with packet mode; refresh status.");
  const active = standings[0]?.entrants.filter((entry) => entry.agent === agent) ?? [];
  if (
    standings[0]?.status !== "open" ||
    active.length !== 1 ||
    active[0]!.closedAt !== null ||
    active[0]!.closedBy !== null
  )
    throw new PublicError(409, "Exactly one live caller-owned race entrant binding is required.");
  return { packet, agent, repoName: active[0]!.repoName };
}

export function raceLine(state: RaceState): string {
  const standings = state.entrants.map((entry) => {
    const milestones = [
      ["Claimed", entry.claimedAt],
      ["First push", entry.firstPushAt],
      ["Review requested", entry.reviewRequestedAt],
      ["Checks passed", entry.receiptPassedAt],
      ["Approved", entry.approvedAt],
      ["Promoted", entry.promotedAt],
    ] as const;
    const reached = milestones.filter(([, at]) => at !== null).at(-1)!;
    return (
      `${entry.agent} on ${entry.repoName}: ${reached[0]} at ${reached[1]}` +
      (entry.place === null ? "" : `; place ${entry.place}`) +
      (entry.closedAt === null ? "" : `; closed by ${entry.closedBy} at ${entry.closedAt}`) +
      (entry.promoteRejected
        ? `; promote rejected at ${entry.promoteRejected.at} (expected ${entry.promoteRejected.expected}, found ${entry.promoteRejected.found})`
        : "")
    );
  });
  return (
    `${state.packet} race ${state.status}` +
    (state.winner === null ? "" : `; winner ${state.winner}`) +
    (state.ledgerEntryId === null ? "" : `; ledger ${state.ledgerEntryId}`) +
    ` — ${standings.join(" | ")}`
  ).replace(/[\r\n\u2028\u2029]/g, " ");
}
