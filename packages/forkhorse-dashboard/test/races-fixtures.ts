import type { Race, StateResponse } from "../src/contracts.ts";
import { raceFixtureState } from "./race-fixtures.ts";

export const racesScenarios = ["races-list", "races-empty"];

/** Synthetic FH-081 read snapshots, including every requested list/capture state. */
export function racesFixtureState(scenario = "races-list"): StateResponse {
  const state: StateResponse = raceFixtureState("race-open");
  state.project.id = scenario;
  state.races = [];
  state.packets = [];
  state.claims = [];
  state.reviews = [];
  state.forks = [];
  state.activity = [];
  state.ledger = [];
  if (scenario === "races-empty") return state;
  const add = (id: string, title: string, source = "race-open", offset = 0) => {
    const fixture = raceFixtureState(source);
    const race: Race = structuredClone(fixture.races[0]);
    race.packet = id;
    const shift = (at: string | null | undefined) => at
      ? new Date(Date.parse(at) + offset * 60_000).toISOString() : null;
    race.finishedAt = shift(race.finishedAt);
    for (const entrant of race.entrants) {
      entrant.repoName = `${id}--${entrant.agent}`;
      for (const key of ["claimedAt", "firstPushAt", "reviewRequestedAt", "receiptPassedAt", "approvedAt", "promotedAt", "closedAt"] as const) {
        // The original claimedAt is always present in these fixed fixtures.
        const at = shift(entrant[key]);
        if (key === "claimedAt") entrant.claimedAt = at!;
        else entrant[key] = at;
      }
    }
    state.races!.push(race);
    state.packets.push({ ...fixture.packets[0], id, title });
    state.forks.push(...fixture.forks.map((fork) => ({ ...fork, repoName: `${id}--${fork.agent}` })));
    state.claims.push(...race.entrants.filter((entrant) => !entrant.closedAt).map((entrant) => ({
      packet: id, agent: entrant.agent, repoName: entrant.repoName,
      paths: fixture.packets[0].paths, createdAt: entrant.claimedAt,
    })));
    return race;
  };
  add("race-three", "Bound retries for transient webhook failures", "race-open", 30);
  const one = add("race-one", "Make delivery failures readable", "race-open", 40);
  one.entrants = one.entrants.filter((entrant) => entrant.agent === "cedar");
  state.claims = state.claims.filter((claim) => claim.packet !== one.packet || claim.agent === "cedar");
  add("race-zero", "Prepare the next race", "race-empty");
  add("race-winner", "Record delivery outcomes", "race-finished", 10);
  const photo = add("race-photo", "Handle simultaneous approved changes", "race-photo", 20);
  state.packets.find((packet) => packet.id === photo.packet)!.archived = {
    at: "2026-10-13T15:00:00Z", by: "owner",
  };
  const judged = add("race-judged", "Compare bounded retry strategies", "race-open", 50);
  judged.judge = "fixture-judge";
  judged.verdict = { ranking: ["birch", "cedar", "amber"], rationale: "Fixture advice only.", at: "2026-10-13T15:10:00Z" };
  const waiting = add("race-advice", "Review timeout handling", "race-open", 60);
  waiting.judge = "fixture-judge";
  waiting.verdict = null;
  // Reverse response order to exercise the recorded-time sort rather than API order.
  state.races.reverse();
  return state;
}
