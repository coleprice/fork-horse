import type { ProjectState, Race, RaceEntrant, Review } from "./contracts.ts";
import { duration } from "./receipts.tsx";

/** This order also determines core placings; a missing milestone is never inferred. */
export const raceMilestones = [
  { key: "claimedAt", label: "Claimed" },
  { key: "firstPushAt", label: "First push" },
  { key: "reviewRequestedAt", label: "Review requested" },
  { key: "receiptPassedAt", label: "Checks passed" },
  { key: "approvedAt", label: "Approved" },
  { key: "promotedAt", label: "Promoted" },
] as const;
export const timestamp = (value?: string | null): number | undefined => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
};
export function raceEntrants(race: Race): RaceEntrant[] {
  return race.entrants.toSorted(
    (a, b) =>
      (timestamp(a.claimedAt) ?? Infinity) - (timestamp(b.claimedAt) ?? Infinity) ||
      a.agent.localeCompare(b.agent),
  );
}
export function raceStart(race: Race): number | undefined {
  return timestamp(raceEntrants(race)[0]?.claimedAt);
}
export function ordinal(value: number): string {
  const suffix =
    value % 100 >= 11 && value % 100 <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th");
  return `${value}${suffix}`;
}
/** Show recorded precision on one shared clock; never count up with wall time. */
export function raceSplit(at: string | null | undefined, start: number | undefined): string {
  const time = timestamp(at);
  if (time === undefined || start === undefined || time < start) return "";
  const elapsed = time - start;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const clock =
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return /\.\d+/.test(at!) ? `${clock}.${Math.floor((elapsed % 1000) / 100)}` : clock;
}
export function raceTimeText(at: string | null | undefined, start: number | undefined): string {
  const time = timestamp(at);
  if (time === undefined || start === undefined || time < start) return "";
  const seconds = Math.floor((time - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const words = [
    hours && `${hours} ${hours === 1 ? "hour" : "hours"}`,
    minutes && `${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
    (seconds % 60 || !seconds) && `${seconds % 60} ${seconds % 60 === 1 ? "second" : "seconds"}`,
  ].filter(Boolean);
  return `plus ${words.join(" ")} on the race clock`;
}
export function entrantReviews(state: ProjectState, race: Race, entrant: RaceEntrant): Review[] {
  return state.reviews
    .filter((review) => review.packet === race.packet && review.repoName === entrant.repoName)
    .toSorted((a, b) => (timestamp(a.requestedAt) ?? 0) - (timestamp(b.requestedAt) ?? 0));
}
export function entrantResult(entrant: RaceEntrant, owner: boolean): string {
  if (entrant.promotedAt) return "Won";
  if (!entrant.closedAt) return "Racing";
  if (entrant.closedBy === "race-finished") return "Closed at the finish";
  if (entrant.closedBy === "release") return "Left the race";
  if (entrant.closedBy === "owner") return owner ? "Closed by you" : "Closed by the owner";
  return "Closed";
}
export function photoFinish(race: Race): number {
  const finished = timestamp(race.finishedAt);
  return race.status === "finished" && finished !== undefined
    ? race.entrants.filter((entrant) => {
        const at = timestamp(entrant.approvedAt);
        return at !== undefined && at <= finished;
      }).length
    : 0;
}
export function rejectionDelta(at: string, finishedAt?: string | null): string {
  const time = timestamp(at),
    finished = timestamp(finishedAt);
  if (time === undefined || finished === undefined || time < finished) return "";
  const delta = time - finished;
  return delta < 10_000 ? `${(delta / 1000).toFixed(1)} s after` : `${duration(delta)} after`;
}
