import type { ProjectState, Race, RaceEntrant } from "./contracts.ts";
import { receiptWord } from "./receipts.tsx";
import { entrantReviews, raceEntrants, raceMilestones, raceSplit, raceStart, raceTimeText, timestamp } from "./race-model.ts";

/** Shared with the lane's spoken description, including a failed checks hurdle. */
export function milestoneDescription(state: ProjectState, race: Race, entrant: RaceEntrant, milestone: (typeof raceMilestones)[number]) {
  const receipt = milestone.key === "receiptPassedAt" ? entrantReviews(state, race, entrant).at(-1)?.receipt : undefined;
  const failure = !!receipt && ["failed", "timed-out", "infrastructure-error"].includes(receipt.status);
  const at = failure ? receipt!.finishedAt : entrant[milestone.key];
  const reached = timestamp(entrant[milestone.key]) !== undefined || failure;
  const label = failure ? `Checks ${receiptWord(receipt!.status).label.toLowerCase()}` : milestone.label;
  const start = raceStart(race);
  const time = raceTimeText(at, start);
  return {
    at, label, reached,
    split: raceSplit(at, start),
    description: reached ? `${label}${time ? `, ${time}` : ""}` : "Not yet",
  };
}

export function raceAnnouncementSnapshot(state: ProjectState, race: Race) {
  const milestones = new Map<string, { signature: string; message: string }>();
  for (const entrant of raceEntrants(race)) {
    for (const milestone of raceMilestones) {
      const event = milestoneDescription(state, race, entrant, milestone);
      if (!event.reached) continue;
      milestones.set(`${entrant.repoName}:${milestone.key}`, {
        signature: `${event.at}:${event.label}`,
        message: `${entrant.agent}: ${event.label}${event.split ? `, +${event.split}` : ""}`,
      });
    }
  }
  const time = raceSplit(race.finishedAt, raceStart(race));
  return {
    milestones,
    finished: race.status === "finished",
    finish: race.winner
      ? `Race finished. ${race.winner} won${time ? ` in ${time}` : ""}.`
      : "Race finished.",
  };
}

/** Compare captured values so a mutated response or clock tick cannot repeat a milestone. */
export function raceAnnouncementChanges(previous: ReturnType<typeof raceAnnouncementSnapshot>, current: ReturnType<typeof raceAnnouncementSnapshot>) {
  const messages: string[] = [];
  for (const [key, event] of current.milestones) {
    if (previous.milestones.get(key)?.signature !== event.signature) messages.push(event.message);
  }
  if (current.finished && !previous.finished) messages.push(current.finish);
  return messages.join(". ");
}
