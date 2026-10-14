import type { Activity, ProjectState } from "./contracts.ts";
import { oldestLoadedActivity, packetPushes, timestamp } from "./fork-graph-model.ts";
import { agentIdentities, type AgentIdentity } from "./lane.tsx";
import { reviewState } from "./model.ts";

export interface AgentClaimStatus {
  claim: ProjectState["claims"][number];
  priority: number;
  label: string;
  tone: "warning" | "danger" | "info" | "success" | "brand";
  waiting: "owner" | "checks" | "agent";
  caption?: string;
  quietSince?: number;
}
export interface AgentStatusRow {
  agent: ProjectState["agents"][number];
  identity?: AgentIdentity;
  claims: AgentClaimStatus[];
  status?: AgentClaimStatus;
  fork?: ProjectState["forks"][number];
  lastPush?: Activity;
  missingPush: "No push yet" | "Not in loaded activity";
}
const RECENT = 30 * 60_000;

/** First proven match wins. Claims and loaded pushes are evidence, never a heartbeat. */
export function claimStatus(
  state: ProjectState, claim: ProjectState["claims"][number], activity: Activity[], now = Date.now(),
): AgentClaimStatus {
  const result = (priority: number, label: string, tone: AgentClaimStatus["tone"],
    waiting: AgentClaimStatus["waiting"], caption?: string): AgentClaimStatus =>
    ({ claim, priority, label, tone, waiting, caption });
  const pushed = packetPushes(activity, claim.repoName, state.project.defaultBranch,
    timestamp(claim.createdAt) ?? 0, now).toSorted((a, b) =>
    (timestamp(b.recordedAt) ?? 0) - (timestamp(a.recordedAt) ?? 0) || b.sequence - a.sequence)[0];
  const pushAt = timestamp(pushed?.recordedAt) ?? -Infinity;
  const review = state.reviews.filter((entry) => entry.packet === claim.packet &&
    entry.agent === claim.agent && entry.repoName === claim.repoName &&
    (timestamp(entry.requestedAt) ?? Infinity) >= (timestamp(claim.createdAt) ?? 0))
    .toSorted((a, b) => (timestamp(b.requestedAt) ?? 0) - (timestamp(a.requestedAt) ?? 0))[0];
  // Match the Work/review gate: a claimant's own packet is not the blocked pushing fork.
  if (state.blockers.some((blocker) => !blocker.resolved && blocker.repoName === claim.repoName &&
    (blocker.pushingPacket == null || blocker.pushingPacket === claim.packet)))
    return result(1, "Blocked", "warning", "owner", "Resolve the collision");
  const sameHead = !review || state.forks.find((fork) => fork.repoName === claim.repoName)?.head === review.sha;
  if (review?.returned && sameHead && pushAt <= (timestamp(review.returned.at) ?? Infinity))
    return result(2, "Returned", "danger", "agent", "Push a fix");
  const receipt = review?.receipt;
  if (receipt && sameHead && pushAt <= (timestamp(receipt.finishedAt) ?? timestamp(review?.requestedAt) ?? Infinity)) {
    const failed = {
      failed: ["Checks failed", "danger"],
      "timed-out": ["Timed out", "warning"],
      "infrastructure-error": ["Couldn't run", "warning"],
    } as const;
    if (receipt.status in failed) {
      const [label, tone] = failed[receipt.status as keyof typeof failed];
      return result(3, label, tone, "agent", "Push a fix or request review again");
    }
  }
  const current = review && sameHead && reviewState(review, state).kind === "current" &&
    review.status !== "stale" && pushAt <= (timestamp(review.requestedAt) ?? Infinity);
  if (current && receipt?.status === "running")
    return result(4, "Checks running", "info", "checks");
  if (current && review.status === "pending" &&
    (receipt?.status === "passed" || state.project.settings?.requireReceipt === false))
    return result(5, "In review", "info", "owner", "Review");
  if (current && review.status === "approved")
    return result(6, "Approved", "success", "owner", "Promote");
  // The oldest loaded event bounds what we can say about an absence of pushes.
  if (Math.max(pushAt, timestamp(claim.createdAt) ?? -Infinity) < now - RECENT &&
    oldestLoadedActivity(activity) <= now - RECENT)
    return { ...result(8, "Claimed, no recent push", "warning", "agent"),
      quietSince: timestamp(pushed?.recordedAt) ?? timestamp(claim.createdAt) };
  const racing = state.races?.some((race) => race.packet === claim.packet && race.status === "open" &&
    race.entrants.some((entrant) => entrant.agent === claim.agent && entrant.repoName === claim.repoName && !entrant.closedAt));
  return result(7, racing ? "Racing" : "In progress", "brand", "agent");
}

/** One row per enrolled identity; urgency chooses the packet, rank chooses the row order. */
export function agentStatusRows(state: ProjectState, activity = state.recentActivity ?? [], now = Date.now()): AgentStatusRow[] {
  const identities = agentIdentities(state.agents);
  const oldest = oldestLoadedActivity(activity);
  return state.agents.map((agent) => {
    const claims = state.claims.filter((claim) => claim.active && claim.agent === agent.name)
      .map((claim) => claimStatus(state, claim, activity, now))
      .toSorted((a, b) => a.priority - b.priority || a.claim.packet.localeCompare(b.claim.packet));
    const forks = state.forks.filter((fork) => fork.agent === agent.name);
    const lastPush = activity.filter((event) =>
      forks.some((fork) => fork.repoName === event.repoName) && !/^0+$/.test(event.after) &&
      (timestamp(event.recordedAt) ?? Infinity) <= now)
      .toSorted((a, b) => (timestamp(b.recordedAt) ?? 0) - (timestamp(a.recordedAt) ?? 0) || b.sequence - a.sequence)[0];
    return { agent, identity: identities.get(agent.name), claims, status: claims[0], lastPush,
      fork: forks.find((fork) => fork.repoName === claims[0]?.claim.repoName) ?? forks[0],
      missingPush: claims.length && claims.every((entry) => (timestamp(entry.claim.createdAt) ?? -Infinity) > oldest)
        ? "No push yet" as const : "Not in loaded activity" as const };
  }).toSorted((a, b) => (a.identity?.number ?? Infinity) - (b.identity?.number ?? Infinity));
}
