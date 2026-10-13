import type { StateResponse } from "../src/contracts.ts";
import { fixtureReceipt, fixtureState, HEAD, NEXT_HEAD } from "./fixtures.ts";

/** FH-043 synthetic snapshots. No owner connection or live action. */
export const needsScenarios = [
  "needs-all",
  "needs-promotion",
  "needs-reconciler",
  "needs-blocker",
  "needs-failed",
  "needs-promote",
  "needs-approve",
  "needs-advisory",
  "needs-empty",
  "needs-main-moved",
];
export function needsFixtureState(id: string): StateResponse {
  const state = fixtureState("quiet");
  state.project.id = id;
  state.project.repoName = "fixture-project";
  state.project.settings = { requireReceipt: id !== "needs-advisory" };
  const all = id === "needs-all";
  function review(packet: string, status: "pending" | "approved" | "failed") {
    const index = state.reviews.length;
    const agent = `fixture-agent-${index + 1}`;
    const repoName = `fixture-project--agent-${index + 1}`;
    const sha = (index + 11).toString(16).repeat(40);
    const receipt = fixtureReceipt(
      status === "failed" || id === "needs-advisory" ? "failed" : "passed",
    );
    const r: StateResponse["reviews"][number] = {
      id: `needs-review-${index + 1}`,
      packet,
      agent,
      repoName,
      sha,
      base: HEAD,
      receiptDigest: receipt.digest,
      receipt,
      returned: null,
      approval: status === "approved" ? { sha, receiptDigest: receipt.digest } : null,
      stale: false,
      promoted: false,
      createdAt: "2026-10-13T12:00:00Z",
    };
    state.agents.push({ name: agent });
    state.forks.push({
      agent,
      repoName,
      head: sha,
      remote: `https://git.idiot.tax/${repoName}`,
      createdAt: r.createdAt,
    });
    state.reviews.push(r);
    state.packets.push({
      id: packet,
      title: packet,
      goal: "Inspect synthetic evidence.",
      paths: ["src/fixture.ts"],
      acceptance: ["Fixture only"],
    });
    return r;
  }
  if (all || id === "needs-promotion") {
    const r = review("fixture-01", "approved");
    r.promoted = true;
    state.promotionPending = {
      id: "pending-1",
      review: r.id,
      repoName: state.project.repoName,
      ref: "refs/heads/main",
      before: HEAD,
      after: NEXT_HEAD,
      receiptDigest: r.receiptDigest,
      recordedAt: "2026-10-13T11:00:00Z",
    };
  }
  if (all || id === "needs-reconciler") {
    state.agents.push({ name: "fixture-external" });
    state.forks.push({
      agent: "fixture-external",
      repoName: "fixture-project--external",
      head: NEXT_HEAD,
      remote: "https://git.idiot.tax/external",
      createdAt: "2026-10-13T11:00:00Z",
    });
    state.reconcilerAlerts.push({
      id: "2",
      repoName: "fixture-project--external",
      ref: "refs/heads/main",
      before: HEAD,
      after: NEXT_HEAD,
      reason: "Synthetic outside movement.",
    });
  }
  if (all || id === "needs-blocker") {
    state.packets.push({
      id: "fixture-02",
      title: "Collision evidence",
      goal: "Resolve the synthetic claim collision.",
      paths: ["src/claims.ts"],
      acceptance: ["Fixture only"],
    });
    state.blockers.push({
      id: "3-fixture-02",
      packet: "fixture-02",
      pushingAgent: "fixture-reviewer",
      claimingAgent: "fixture-builder",
      repoName: "fixture-project--external",
      sha: NEXT_HEAD,
      paths: ["src/claims.ts", "src/claim-test.ts"],
    });
  }
  if (all || id === "needs-failed") review("fixture-03", "failed");
  if (all || id === "needs-promote") review("fixture-04", "approved");
  if (all || id === "needs-approve" || id === "needs-advisory") review("fixture-05", "pending");
  if (id === "needs-main-moved") {
    review("fixture-main-moved", "approved");
    const currentMain = "7".repeat(40);
    const ready = review("fixture-ready", "approved");
    ready.base = currentMain;
    state.ledger = [
      {
        id: "fixture-main-promotion",
        review: "fixture-other-review",
        repoName: state.project.repoName,
        ref: "refs/heads/main",
        before: HEAD,
        after: currentMain,
        receiptDigest: null,
        recordedAt: "2026-10-13T12:01:00Z",
      },
    ];
  }
  return state;
}
