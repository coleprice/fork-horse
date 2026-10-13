import type { StateResponse } from "../src/contracts.ts";
import { reviewFixtureState } from "./review-fixtures.ts";

/** FH-050/052 contract fixtures. Never evidence of core, Cloudflare or owner acceptance. */
export const archiveScenarios = [
  "archive-ready",
  "archive-list",
  "archive-claim",
  "archive-race",
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
  if (id === "archive-race") state.races = [{ packet: "FH-040", entrants: [{ closedAt: null }] }];
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
