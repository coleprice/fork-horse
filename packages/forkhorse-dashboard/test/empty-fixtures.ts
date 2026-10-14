import { fixtureState } from "./fixtures.ts";

/** FH-073 synthetic first-run snapshots. No account connection or owner writes. */
export const emptyScenarios = [
  "empty-projects",
  "empty-agents",
  "empty-packets",
  "empty-reviews",
  "empty-forks",
  "empty-races",
];

export function emptyFixtureState(id: string) {
  const state = fixtureState("quiet");
  state.project.id = id;
  state.project.repoName = "fixture-project";
  state.races = [];
  if (id === "empty-packets") state.agents = [{ name: "fixture-builder" }];
  if (id === "empty-reviews" || id === "empty-forks" || id === "empty-races") {
    const populated = fixtureState();
    state.agents = populated.agents;
    state.packets = populated.packets;
  }
  return state;
}
