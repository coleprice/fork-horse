import { z } from "zod";
import { PublicError } from "./core";

export const tokenCount = z.number().int().min(0).max(1_000_000_000);
const record = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  model: z.string().optional(),
  source: z.enum(["reported", "metered"]),
  at: z.string(),
});
export const usageSourcesSchema = z.object({
  reported: record.extend({ source: z.literal("reported") }).nullable(),
  metered: record.extend({ source: z.literal("metered") }).nullable(),
});
export const budgetStateSchema = z.enum(["unchecked", "within", "near", "over"]);
const binding = z.object({
  agent: z.string(),
  repoName: z.string(),
  // Older core records have no usage fields. Missing means unreported, never zero.
  usage: usageSourcesSchema.optional(),
});
const usageState = z.object({
  claims: z.array(binding.extend({ packet: z.string() })),
  races: z
    .array(
      z.object({
        packet: z.string(),
        tokenBudget: z.number().int().positive().nullable().optional(),
        entrants: z.array(binding.extend({ budget: budgetStateSchema.optional() })),
      }),
    )
    .default([]),
});

/** FH-060 state projection only: core computes race budgets and enforces live bindings. */
export function callerUsage(snapshot: unknown, agent: string) {
  const state = usageState.safeParse(snapshot);
  if (!state.success) throw new PublicError(502, "Core usage state unavailable; refresh status.");
  const empty = { reported: null, metered: null };
  return [
    ...state.data.claims
      .filter((claim) => claim.agent === agent)
      .map((claim) => ({
        packet: claim.packet,
        repoName: claim.repoName,
        usage: claim.usage ?? empty,
        tokenBudget: null,
        budget: "unchecked" as const,
      })),
    ...state.data.races.flatMap((race) =>
      race.entrants
        .filter((entrant) => entrant.agent === agent)
        .map((entrant) => {
          // A budget without core's computed state must never look safe to an agent.
          if (race.tokenBudget != null && entrant.budget === undefined)
            throw new PublicError(502, "Core race budget state unavailable; FH-060 is required.");
          return {
            packet: race.packet,
            repoName: entrant.repoName,
            usage: entrant.usage ?? empty,
            tokenBudget: race.tokenBudget ?? null,
            budget: entrant.budget ?? "unchecked",
          };
        }),
    ),
  ];
}
