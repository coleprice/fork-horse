import type { StateResponse } from "../src/contracts.ts";
import { raceFixtureState } from "./race-fixtures.ts";
import { reviewFixtureDetail } from "./review-fixtures.ts";

/** FH-063 fixed contract fixtures only. Not an accepted core or live judge. */
export const judgeScenarios = ["judge-waiting", "judge-open", "judge-unapproved", "judge-entrant-push",
  "judge-pick-push", "judge-pick-review", "judge-over", "judge-unchecked", "judge-main-moved",
  "judge-pending", "judge-recheck", "judge-closed", "judge-finish-pick", "judge-finish-other",
  "judge-finish-none", "judge-long", "judge-nojudge"];
export const adviceAt = "2026-10-13T14:13:00Z";
export function judgeFixtureState(scenario = "judge-open"): StateResponse {
  const finished = scenario.startsWith("judge-finish");
  const state: StateResponse = raceFixtureState(finished ? "race-finished" : "race-open");
  state.project.id = scenario;
  state.agents.push({ name: "cfos-1", createdAt: "2026-10-13T14:01:00Z" });
  const race = state.races![0];
  race.judge = "cfos-1";
  race.verdict = { ranking: ["cedar", "birch", "amber"], at: adviceAt,
    rationale: "Cedar keeps retries bounded and makes failures readable.\nBirch needs clearer edge-case coverage. Amber should revisit its failed check." };
  if (scenario === "judge-waiting" || scenario === "judge-finish-none") race.verdict = null;
  if (scenario === "judge-nojudge") { race.judge = null; race.verdict = null; }
  if (scenario === "judge-finish-other") race.verdict!.ranking = ["birch", "cedar", "amber"];
  const pick = race.entrants.find((e) => e.agent === "cedar")!;
  const review = state.reviews.find((r) => r.agent === "cedar")!;
  if (scenario === "judge-unapproved") { review.approval = null; pick.approvedAt = null; }
  if (scenario === "judge-pick-review") review.createdAt = "2026-10-13T14:15:00Z";
  if (scenario === "judge-pick-push" || scenario === "judge-entrant-push") {
    const entrant = scenario === "judge-pick-push" ? pick : race.entrants.find((e) => e.agent === "birch")!;
    const original = state.activity.find((event) => event.repoName === entrant.repoName)!;
    state.activity.push({ ...original, sequence: 100, recordedAt: "2026-10-13T14:15:00Z", eventTimestamp: "2026-10-13T14:15:00Z" });
  }
  if (scenario === "judge-over" || scenario === "judge-unchecked") {
    race.tokenBudget = 1000;
    pick.budget = scenario === "judge-over" ? "over" : "unchecked";
    pick.usage = { reported: scenario === "judge-over" ? { inputTokens: 1001, outputTokens: 20,
      source: "reported", at: "2026-10-13T14:12:00Z" } : null, metered: null };
  }
  if (scenario === "judge-main-moved") state.ledger = [{ id: "later", review: "other", repoName: state.project.repoName,
    ref: "refs/heads/main", before: review.base, after: "7".repeat(40), receiptDigest: null, recordedAt: "2026-10-13T14:12:00Z" }];
  if (scenario === "judge-pending") state.promotionPending = { id: "pending", review: review.id,
    repoName: state.project.repoName, ref: "refs/heads/main", before: review.base, after: review.sha,
    receiptDigest: review.receiptDigest, recordedAt: "2026-10-13T14:12:00Z" };
  if (scenario === "judge-recheck") { review.receipt!.status = "running"; review.receipt!.trigger = "before-promote"; }
  if (scenario === "judge-closed") { pick.closedAt = "2026-10-13T14:14:00Z"; pick.closedBy = "release"; }
  if (scenario === "judge-long") race.verdict!.rationale = ["<strong>This is plain text, not markup.</strong>",
    "Cedar makes a bounded retry policy clear.", "Its request path stays easy to follow.",
    "Birch covers the happy path.", "Amber needs to revisit its failed check.",
    "The owner should still inspect the changes.", "The rationale is the judge's own explanation.",
    "Reported token totals are the entrants' reports.", "This advice leaves promotion with the owner."].join("\n");
  return state;
}
export function judgeFixtureDetail(state: StateResponse, id: string) {
  const review = state.reviews.find((r) => r.id === id)!;
  return reviewFixtureDetail({ ...state, reviews: [review] });
}
