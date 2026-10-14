import type { StateResponse } from "../src/contracts.ts";
import { fixtureReceipt, fixtureState, HEAD } from "./fixtures.ts";

export const agentStatusScenarios = ["agents-status", "agents-short-activity", "agent-resume", "agent-idle"];
export const AGENT_STATUS_NOW = Date.parse("2026-10-14T16:00:00Z");

/** Synthetic /state fixtures; relative ages stay useful for light/dark UI capture. */
export function agentStatusFixtureState(id = "agents-status", now = Date.now()): StateResponse {
  const state = fixtureState("quiet");
  state.project.id = id;
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const labels = ["blocked", "returned", "failed", "timeout", "couldnt-run", "checking", "review", "approved", "fixture-agent", "racing", "held", "new", "idle", "legacy"];
  for (const [index, name] of labels.entries()) {
    const repoName = `fixture--${name}`;
    const sha = (index + 1).toString(16).repeat(40).slice(0, 40);
    state.agents.push({ name, ...(name === "legacy" ? {} : { createdAt: at(120 - index) }) });
    state.forks.push({ agent: name, repoName, head: sha, remote: `https://git.idiot.tax/fixture/${repoName}.git`, createdAt: at(120) });
    if (["idle", "legacy"].includes(name)) continue;
    const packet = `fixture-${name}`;
    state.packets.push({ id: packet, title: `${name} status fixture`, goal: "Inspect the public agent status", paths: [`src/${name}/**`], acceptance: ["Status evidence is truthful"], mode: name === "racing" ? "race" : "standard" });
    state.claims.push({ agent: name, packet, repoName, paths: [`src/${name}/**`], createdAt: at(name === "new" ? 1 : 90) });
    if (name !== "new") state.activity.push({ sequence: index + 2, namespace: "fixture", repoName, agent: name, ref: "refs/heads/main", before: HEAD, after: sha, changedPaths: [`src/${name}/index.ts`], eventTimestamp: at(name === "held" ? 45 : 10), recordedAt: at(name === "held" ? 45 : 10) });
    if (index <= 7) {
      const receipt = fixtureReceipt(index === 2 ? "failed" : index === 3 ? "timed-out" : index === 4 ? "infrastructure-error" : index === 5 ? "running" : "passed");
      receipt.startedAt = at(8);
      receipt.finishedAt = index === 5 ? null : at(7);
      state.reviews.push({ id: `review-${name}`, agent: name, repoName, packet, sha, base: HEAD, receipt, receiptDigest: receipt.digest,
        approval: name === "approved" ? { sha, receiptDigest: receipt.digest } : null,
        stale: false, promoted: false, createdAt: at(9),
        ...(name === "returned" ? { returned: { at: at(6), reason: "Push a fixture fix" } } : {}) });
    }
    if (name === "blocked") state.blockers.push({ id: "fixture-collision", packet, pushingPacket: packet, claimingAgent: name, pushingAgent: name, repoName, sha, paths: [`src/${name}/index.ts`] });
    if (name === "racing") state.races = [{ packet, status: "open", entrants: [{ agent: name, repoName, claimedAt: at(90), firstPushAt: at(10), reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null, promotedAt: null, place: null, closedAt: null }] }];
  }
  // A canonical event bounds the loaded activity; it never becomes an agent push.
  state.activity.unshift({ sequence: 1, namespace: "fixture", repoName: state.project.repoName, agent: null, ref: "refs/heads/main", before: HEAD, after: HEAD, changedPaths: [], eventTimestamp: at(60), recordedAt: at(60) });
  state.activity.sort((a, b) => a.sequence - b.sequence);
  if (id === "agents-short-activity") state.activity = state.activity.filter((event) => Date.parse(event.recordedAt) > now - 30 * 60_000);
  if (id === "agent-idle") state.claims = state.claims.filter((claim) => claim.agent !== "fixture-agent");
  return state;
}
