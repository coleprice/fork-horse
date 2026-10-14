import type { DashboardTransport } from "../src/contracts.ts";
import { ApiError } from "../src/transport.ts";

/** Client-only capture fixtures over existing fixture routes. No production endpoints or account access. */
export const freshnessScenarios = ["freshness-refreshing", "freshness-failed", "freshness-slow-review", "freshness-review-error"];
export function freshnessFixtureTransport(transport: DashboardTransport, scenario: string): DashboardTransport {
  if (!freshnessScenarios.includes(scenario)) return transport;
  const project = "review-current";
  let stateReads = 0;
  let detailReads = 0;
  return {
    ...transport,
    async getState() {
      if (++stateReads === 2) {
        if (scenario === "freshness-failed") throw new ApiError(502, "Fixture read failed.");
        if (scenario === "freshness-refreshing") await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
      const state = await transport.getState(project);
      return { ...state, project: { ...state.project, id: scenario } };
    },
    getActivity: (_id, after) => transport.getActivity(project, after),
    approve: (_id, review) => transport.approve(project, review),
    promote: (_id, review) => transport.promote(project, review),
    returnReview: transport.returnReview ? (_id, review, reason) => transport.returnReview!(project, review, reason) : undefined,
    resolveBlocker: transport.resolveBlocker ? (_id, blocker, reason) => transport.resolveBlocker!(project, blocker, reason) : undefined,
    setSettings: transport.setSettings ? (_id, settings) => transport.setSettings!(project, settings) : undefined,
    getReceipt: transport.getReceipt ? (_id, review) => transport.getReceipt!(project, review) : undefined,
    archivePacket: transport.archivePacket ? (_id, packet) => transport.archivePacket!(project, packet) : undefined,
    unarchivePacket: transport.unarchivePacket ? (_id, packet) => transport.unarchivePacket!(project, packet) : undefined,
    getReview: transport.getReview ? async (_id, review) => {
      if (++detailReads === 1) {
        if (scenario === "freshness-slow-review") await new Promise((resolve) => setTimeout(resolve, 15_000));
        if (scenario === "freshness-review-error") throw new ApiError(502, "Fixture raw body must stay hidden.", "11111111-2222-4333-8444-555555555555");
      }
      return transport.getReview!(project, review);
    } : undefined,
    getDiff: transport.getDiff ? (_id, review, path) => transport.getDiff!(project, review, path) : undefined,
  };
}
