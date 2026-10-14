import type { ProjectState, Race, RaceEntrant, Review } from "./contracts.ts";
import { promotionAvailable, reviewGate, reviewState } from "./model.ts";
import { packetPushes } from "./fork-graph-model.ts";
import { ordinal } from "./race-model.ts";

export const rankingWord = (index: number) => index === 0 ? "Pick" : `${ordinal(index + 1)} choice`;
export function entrantReview(state: ProjectState, race: Race, agent: string): Review | undefined {
  const entrant = race.entrants.find((e) => e.agent === agent);
  return state.reviews.filter((r) => r.packet === race.packet && r.agent === agent &&
    r.repoName === entrant?.repoName).toSorted((a, b) =>
      (b.requestedAt ?? "").localeCompare(a.requestedAt ?? "") || b.id.localeCompare(a.id))[0];
}
/** Ranking is of agents. Later review or push evidence must never authorize unseen work. */
export function pushedAfterAdvice(state: ProjectState, race: Race, entrant: RaceEntrant): boolean {
  const at = Date.parse(race.verdict?.at ?? "");
  if (!Number.isFinite(at)) return true;
  const review = entrantReview(state, race, entrant.agent);
  return Date.parse(review?.requestedAt ?? "") > at ||
    Date.parse(entrant.firstPushAt ?? "") > at ||
    packetPushes(state.recentActivity ?? [], entrant.repoName, state.project.defaultBranch,
      Math.max(at + 1, Date.parse(entrant.claimedAt)), Date.now()).length > 0;
}
export function judgePromotion(state: ProjectState, race: Race) {
  const pick = race.verdict?.ranking[0];
  const entrant = race.entrants.find((e) => e.agent === pick);
  const review = pick ? entrantReview(state, race, pick) : undefined;
  let reason = "";
  if (!race.judge || !pick || race.status === "finished") reason = "";
  else if (!entrant) reason = `${pick} is no longer in this race.`;
  else if (pushedAfterAdvice(state, race, entrant)) reason = `${pick} pushed after this advice.`;
  else if (entrant.closedAt) reason = `${pick} left the race.`;
  else if (!review) reason = `${pick} hasn't requested review yet.`;
  else if (state.promotionPending) reason = "Promotion outcome pending owner inspection.";
  else {
    const cause = reviewState(review, state);
    const gate = reviewGate(review, state);
    if (cause.kind !== "current") reason = cause.label;
    else if (!gate.approve && !gate.promote) reason = gate.reason;
    else if (review.status !== "approved") reason = `${pick}'s review isn't approved yet.`;
    else if (!promotionAvailable(review, state)) reason = "Re-checking…";
  }
  return { pick, review, reason, available: !!race.judge && !!pick && !!review && !!entrant &&
    race.status === "open" && !entrant.closedAt && !reason && promotionAvailable(review, state) };
}
export function adviceForReview(state: ProjectState, review: Review) {
  const race = state.races?.find((r) => r.packet === review.packet && r.judge && r.verdict);
  if (!race?.verdict || !race.entrants.some((e) => e.agent === review.agent && e.repoName === review.repoName)) return;
  const index = race.verdict.ranking.indexOf(review.agent);
  if (index < 0) return;
  return { race, index, at: race.verdict.at };
}
