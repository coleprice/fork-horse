import type { StateResponse } from "../src/contracts.ts";
import type { RaceFixture } from "./race-fixtures.ts";
import { reviewFixtureState } from "./review-fixtures.ts";

/** FH-050/052 contract fixtures. Never evidence of core, Cloudflare or owner acceptance. */
export const archiveScenarios = [
  "archive-ready",
  "archive-list",
  "archive-claim",
  "archive-race",
  "archive-finished-race",
  "archive-review",
  "archive-main-moved",
  "archive-blocker",
  "archive-conflict",
  "archive-missing",
  "archive-error",
];
export function archiveFixtureState(id = "archive-ready"): StateResponse {
  const state = reviewFixtureState("review-promoted");
  state.project.id = id;
  state.claims = [];
  state.races = [];
  state.activity = [];
  state.reconcilerAlerts = [];
  state.packets[0].archived = null;
  state.packets.push({
    id: "FH-READY",
    title: "Next packet",
    goal: "Keep active work visible.",
    paths: ["docs/**"],
    acceptance: ["Visible in Work"],
    archived: null,
  });
  if (id === "archive-list")
    state.packets[0].archived = { at: "2026-10-13T14:20:00Z", by: "owner" };
  if (id === "archive-claim")
    state.claims = [
      {
        packet: "FH-040",
        agent: "builder",
        repoName: state.forks[0].repoName,
        paths: ["packages/forkhorse-dashboard/**"],
        createdAt: "2026-10-13T14:00:00Z",
      },
    ];
  if (id === "archive-race") {
    state.packets[0].mode = "race";
    const race = archiveRace();
    const entrant = race.entrants[0];
    state.races = [race];
    state.claims = [{ packet: race.packet, agent: entrant.agent, repoName: entrant.repoName,
      paths: state.packets[0].paths, createdAt: entrant.claimedAt, usage: entrant.usage }];
    state.reviews = [];
    state.ledger = [];
  }
  if (id === "archive-finished-race") {
    state.packets[0].mode = "race";
    const finishedAt = "2026-10-13T14:10:00Z";
    const race = archiveRace(finishedAt);
    const review = state.reviews[0];
    // The promoted review and exact ledger reference identify the winning entrant.
    const winner = { ...race.entrants[0], agent: review.agent, repoName: review.repoName,
      firstPushAt: "2026-10-13T14:01:00Z", reviewRequestedAt: "2026-10-13T14:02:00Z",
      receiptPassedAt: "2026-10-13T14:03:00Z", approvedAt: "2026-10-13T14:04:00Z",
      promotedAt: finishedAt, place: 1, closedBy: null };
    const other = { ...race.entrants[0], place: 2, closedBy: "race-finished" as const };
    if (!state.agents.some((agent) => agent.name === winner.agent))
      state.agents.push({ name: winner.agent, createdAt: "2026-10-13T13:59:00Z" });
    review.createdAt = winner.reviewRequestedAt;
    review.approvedAt = winner.approvedAt;
    state.ledger[0].recordedAt = finishedAt;
    state.ledger[0].race = race.packet;
    state.races = [{ ...race, status: "finished", finishedAt, winner: winner.agent,
      ledgerEntryId: state.ledger[0].id, places: [{ agent: winner.agent, place: 1 },
        { agent: other.agent, place: 2 }], entrants: [winner, other] }];
  }
  if (id === "archive-review" || id === "archive-main-moved") {
    state.reviews[0].promoted = false;
    if (id === "archive-main-moved") state.ledger[0].after = "7".repeat(40);
  }
  if (id === "archive-blocker")
    state.blockers = [
      {
        id: "1-collision",
        packet: "FH-READY",
        pushingPacket: "FH-040",
        claimingAgent: "docs",
        pushingAgent: "builder",
        repoName: state.forks[0].repoName,
        sha: state.reviews[0].sha,
        paths: ["docs/**"],
        resolved: null,
      },
    ];
  return state;
}

/** Complete accepted FH-052/053 race wire shape for archive gate fixtures. */
export function archiveRace(closedAt: string | null = null): RaceFixture["races"][number] {
  return {
    packet: "FH-040", tokenBudget: null, places: [], status: "open", finishedAt: null, winner: null, ledgerEntryId: null,
    entrants: [{
      agent: "builder", repoName: "demo--builder-1", claimedAt: "2026-10-13T14:00:00Z",
      firstPushAt: null, reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null,
      promotedAt: null, place: null, closedAt, closedBy: closedAt ? "release" : null,
      usage: { reported: null, metered: null }, budget: "unchecked",
    }],
  };
}
