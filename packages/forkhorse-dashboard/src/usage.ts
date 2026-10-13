import type { Brand, ProjectState, Review, Usage, UsageSources } from "./contracts.ts";

export const totalTokens = (usage: Usage) => usage.inputTokens + usage.outputTokens;
export function tokenNumber(value: number): string {
  if (value < 100000) return value.toLocaleString("en-US");
  return `${Number((value / (value >= 1000000 ? 1000000 : 1000)).toFixed(1))}${value >= 1000000 ? "M" : "k"}`;
}
export const usageValues = (sources?: UsageSources) =>
  [sources?.reported, sources?.metered].filter((value): value is Usage => !!value);
export function usageTooltip(usage: Usage, agent: string, brand: Brand): string {
  return usage.source === "metered"
    ? `Metered by AI Gateway for ${agent}.`
    : `Reported by ${agent} through ${brand.name}. ${brand.name} can't verify it.`;
}
/** The current entrant's budget controls promotion; a review's older snapshot never overrides it. */
export function usagePromotionCaption(review: Review, state: ProjectState): string {
  const race = state.races?.find((r) => r.packet === review.packet);
  if (!race?.tokenBudget) return "";
  const entrant = race.entrants.find(
    (e) => e.agent === review.agent && e.repoName === review.repoName,
  );
  if (!entrant) return "";
  if (entrant.budget === "over") {
    const source = entrant.usage?.metered ? "metered" : "reported";
    return `Over its token budget (${source}). It can't win this race.`;
  }
  if (entrant.budget === "unchecked" || !usageValues(entrant.usage).length)
    return "Report usage first: this race has a token budget.";
  if (entrant.budget === undefined) return "Budget status unavailable. Refresh before promoting.";
  return "";
}
/** Latest source per binding, not sum of live claims and their review snapshots. */
export function agentUsageToday(
  state: ProjectState,
  agent: string,
  now = Date.now(),
): UsageSources {
  const latest = new Map<string, Usage>();
  const add = (packet: string, repo: string, sources?: UsageSources) => {
    for (const value of usageValues(sources)) {
      const at = Date.parse(value.at);
      if (!Number.isFinite(at) || at > now) continue;
      const key = JSON.stringify([packet, repo, value.source]);
      if (!latest.has(key) || Date.parse(latest.get(key)!.at) < at) latest.set(key, value);
    }
  };
  for (const claim of state.claims.filter((c) => c.active && c.agent === agent))
    add(claim.packet, claim.repoName, claim.usage);
  for (const race of state.races ?? [])
    for (const entrant of race.entrants.filter((e) => e.agent === agent))
      add(race.packet, entrant.repoName, entrant.usage);
  for (const review of state.reviews.filter((r) => r.agent === agent))
    add(review.packet, review.repoName, review.usageAtReview);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const result: UsageSources = { reported: null, metered: null };
  for (const value of latest.values()) {
    if (Date.parse(value.at) < start.getTime()) continue;
    const sum = result[value.source];
    result[value.source] = {
      inputTokens: (sum?.inputTokens ?? 0) + value.inputTokens,
      outputTokens: (sum?.outputTokens ?? 0) + value.outputTokens,
      source: value.source,
      at: !sum || sum.at < value.at ? value.at : sum.at,
    };
  }
  return result;
}
/** Graph lanes are binding-specific; historical promotions keep the review snapshot. */
export function laneUsage(
  state: ProjectState,
  lane: { packet: string; repoName: string; review?: Review; promoted?: unknown },
): UsageSources | undefined {
  if (lane.promoted) return lane.review?.usageAtReview;
  return (
    state.races
      ?.find((r) => r.packet === lane.packet)
      ?.entrants.find((e) => e.repoName === lane.repoName)?.usage ??
    state.claims.find((c) => c.active && c.packet === lane.packet && c.repoName === lane.repoName)
      ?.usage ??
    lane.review?.usageAtReview
  );
}
