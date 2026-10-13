import type { StateResponse } from "../src/contracts.ts";
import { reviewFixtureState } from "./review-fixtures.ts";

export const collisionScenarios = [
  "collision-open",
  "collision-history",
  "collision-missing",
  "collision-error",
  "collision-race-release",
  "collision-race-promote",
];
/** FH-048 contract fixtures only: no owner session or Cloudflare access. */
export function collisionFixtureState(id = "collision-open"): StateResponse {
  const state = reviewFixtureState("review-current");
  state.project.id = id;
  state.claims = [];
  state.activity = [];
  state.reconcilerAlerts = [];
  state.ledger = [];
  const r = state.reviews[0];
  r.packet = "pushing-packet";
  state.packets[0].id = r.packet;
  state.packets[0].title = "Pushing packet";
  state.packets.push({ ...state.packets[0], id: "claimant-packet", title: "Claimant packet" });
  const claimantFork = state.forks.find((f) => f.repoName !== r.repoName)!;
  state.reviews.push({
    ...r,
    id: "claimant-review",
    packet: "claimant-packet",
    repoName: claimantFork.repoName,
    sha: claimantFork.head,
  });
  state.blockers = [
    {
      id: "collision-1",
      packet: "claimant-packet",
      pushingPacket: r.packet,
      pushingAgent: r.agent,
      claimingAgent: "fixture-claimant",
      repoName: r.repoName,
      sha: r.sha,
      paths: ["src/claimed.ts", "src/other.ts"],
      at: "2026-10-13T14:00:00Z",
      resolved: null,
    },
  ];
  if (id === "collision-history") {
    for (const [i, by] of (["promote", "release", "owner"] as const).entries())
      state.blockers.push({
        ...state.blockers[0],
        id: `resolved-${by}`,
        at: null,
        resolved: {
          at: `2026-10-13T14:0${i + 1}:00Z`,
          by,
          ...(by === "owner"
            ? { reason: "Agreed on ownership.\n<script>plain text</script>" }
            : {}),
        },
      });
  }
  return state;
}
