import { HttpError } from "./http";
import type { TokenBudgetState, UsageSources } from "./workflow-types";

/** Normalize legacy records without backfilling or inventing measurements. */
export const usageSources = (usage?: UsageSources): UsageSources => ({
  reported: usage?.reported ?? null, metered: usage?.metered ?? null,
});

export const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;

export function tokenBudgetState(tokenBudget: number | undefined, usage?: UsageSources): TokenBudgetState {
  const measured = usage?.metered ?? usage?.reported;
  if (tokenBudget === undefined || !measured) return "unchecked";
  const total = measured.inputTokens + measured.outputTokens;
  return total > tokenBudget ? "over" : total >= tokenBudget * 0.8 ? "near" : "within";
}

export function requireTokenBudget(tokenBudget: number | undefined, usage?: UsageSources): void {
  if (tokenBudget === undefined) return;
  const status = tokenBudgetState(tokenBudget, usage);
  if (status === "unchecked")
    throw new HttpError(409, "Report usage first: this race has a token budget.");
  if (status === "over")
    throw new HttpError(409, `Over its token budget (${usage?.metered ? "metered" : "reported"}).`);
}
