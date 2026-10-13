import type { ProjectState, Review } from "./contracts.ts";
import { agentIdentities, type AgentIdentity, type LaneMarkKind } from "./lane.tsx";

export interface ForkEvent {
  id: string;
  kind: LaneMarkKind;
  at: number;
  label: string;
}
export interface ForkLane {
  id: string;
  agent: string;
  packet: string;
  repoName: string;
  identity?: AgentIdentity;
  claimedAt?: number;
  start?: number;
  end?: number;
  review?: Review;
  events: ForkEvent[];
  state: string;
  race?: string;
  promotedAt?: number;
  promoted?: ProjectState["ledger"][number];
  releasedAt?: number;
  earlierPushes: boolean;
}
export type WindowChoice = "recent" | "four" | "today" | "day";
export const timestamp = (value?: string | null) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};
export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
/** Put the collision beside its pushing lane; unrelated lanes interrupt the connector. */
export function collisionLink(pushingY: number, claimingY: number, laneYs: number[]) {
  const top = Math.min(pushingY, claimingY);
  const bottom = Math.max(pushingY, claimingY);
  const crossings = laneYs.filter((y) => y > top && y < bottom).toSorted((a, b) => a - b);
  const direction = Math.sign(claimingY - pushingY);
  const nextY = direction > 0 ? (crossings[0] ?? claimingY) : (crossings.at(-1) ?? claimingY);
  const ringY = pushingY + direction * Math.min(32, Math.abs(nextY - pushingY) / 2);
  const segments: { top: number; height: number }[] = [];
  let start = top;
  for (const crossing of crossings) {
    if (crossing - 8 > start) segments.push({ top: start, height: crossing - 8 - start });
    start = crossing + 8;
  }
  if (bottom > start) segments.push({ top: start, height: bottom - start });
  return { ringY, segments };
}
const HOUR = 3600000;
const eventLabels: Record<LaneMarkKind, string> = {
  claim: "claimed",
  push: "push",
  review: "review requested",
  passed: "checks passed",
  failed: "checks failed",
  approved: "approved",
  promoted: "promoted to main",
};
export function forkGraph(state: ProjectState, now = Date.now(), choice: WindowChoice = "recent") {
  const identities = agentIdentities(state.agents);
  const lanes = new Map<string, ForkLane>();
  const addLane = (agent: string, packet: string, repoName: string, suffix = "") => {
    const id = `${packet}:${repoName}${suffix}`;
    if (!lanes.has(id))
      lanes.set(id, {
        id,
        agent,
        packet,
        repoName,
        identity: identities.get(agent),
        events: [],
        state: "In progress",
        earlierPushes: false,
      });
    return lanes.get(id)!;
  };
  const add = (
    lane: ForkLane,
    kind: LaneMarkKind,
    value?: string | null,
    id: string = kind,
    label = eventLabels[kind],
  ) => {
    const at = timestamp(value);
    if (at === undefined || at > now) return;
    if (!lane.events.some((e) => e.kind === kind && e.at === at))
      lane.events.push({ id: `${lane.id}:${id}:${at}`, kind, at, label });
  };
  for (const claim of state.claims.filter((c) => c.active)) {
    const lane = addLane(claim.agent, claim.packet, claim.repoName);
    lane.claimedAt = timestamp(claim.createdAt);
    add(lane, "claim", claim.createdAt);
  }
  for (const race of state.races ?? [])
    for (const entrant of race.entrants) {
      const lane = addLane(entrant.agent, race.packet, entrant.repoName);
      lane.race = race.packet;
      lane.claimedAt = timestamp(entrant.claimedAt);
      lane.releasedAt =
        entrant.closedBy === "release" || entrant.closedBy === "owner"
          ? timestamp(entrant.closedAt)
          : undefined;
      lane.promotedAt = timestamp(entrant.promotedAt);
      lane.end = lane.promotedAt ?? timestamp(entrant.closedAt);
      lane.state = entrant.promotedAt
        ? "Promoted to main"
        : lane.releasedAt
          ? "Released"
          : entrant.closedAt
            ? "Closed at the finish"
            : "Racing";
      for (const [kind, value] of [
        ["claim", entrant.claimedAt],
        ["push", entrant.firstPushAt],
        ["review", entrant.reviewRequestedAt],
        ["passed", entrant.receiptPassedAt],
        ["approved", entrant.approvedAt],
        ["promoted", entrant.promotedAt],
      ] as const)
        add(lane, kind, value);
    }
  for (const entry of state.ledger) {
    const review = state.reviews.find((r) => r.id === entry.review);
    if (!review) continue; // The ledger proves main's dot even if its lane is no longer loaded.
    const current = lanes.get(`${review.packet}:${review.repoName}`);
    const historical =
      current?.claimedAt !== undefined && current.claimedAt > (timestamp(entry.promotedAt) ?? now);
    const lane = addLane(
      review.agent,
      review.packet,
      review.repoName,
      historical ? `:promotion:${entry.review}` : "",
    );
    lane.promotedAt = timestamp(entry.promotedAt);
    lane.promoted = entry;
    lane.end = timestamp(entry.promotedAt);
    lane.state = "Promoted to main";
    add(
      lane,
      "promoted",
      entry.promotedAt,
      entry.review,
      `promoted to main ${entry.sha.slice(0, 7)}`,
    );
  }
  for (const lane of lanes.values()) {
    const reviews = state.reviews
      .filter(
        (r) =>
          r.packet === lane.packet &&
          r.repoName === lane.repoName &&
          (timestamp(r.requestedAt) ?? 0) >= (lane.claimedAt ?? 0) &&
          (timestamp(r.requestedAt) ?? 0) <= (lane.end ?? now),
      )
      .toSorted((a, b) => (timestamp(a.requestedAt) ?? 0) - (timestamp(b.requestedAt) ?? 0));
    lane.review = reviews.at(-1);
    for (const review of reviews) {
      add(lane, "review", review.requestedAt, review.id);
      add(lane, "approved", review.approvedAt, review.id);
      const receipt = review.receipt;
      if (receipt && receipt.status !== "running")
        add(
          lane,
          receipt.status === "passed" ? "passed" : "failed",
          receipt.finishedAt,
          `${review.id}:${receipt.digest}`,
          `${receipt.status === "passed" ? "checks passed" : receipt.status === "timed-out" ? "checks timed out" : receipt.status === "infrastructure-error" ? "checks couldn't run" : "checks failed"}${receipt.checks
            .filter((c) => c.outcome !== "passed")
            .map((c) => ` · ${c.name}: ${c.outcome}`)
            .join("")}`,
        );
    }
    const latest = lane.review;
    if (!lane.end && latest)
      lane.state =
        latest.receipt?.status === "running"
          ? "Checks running"
          : latest.status === "approved"
            ? "Approved"
            : latest.receipt && latest.receipt.status !== "passed"
              ? "Checks failed"
              : "In review";
    // Activity is Git pushes only. A fork reused for a later packet must not inherit earlier pushes.
    const previousEnd = Math.max(
      0,
      ...state.ledger
        .filter(
          (e) =>
            e.review !== lane.promoted?.review &&
            state.reviews.some((r) => r.id === e.review && r.repoName === lane.repoName) &&
            (timestamp(e.promotedAt) ?? Infinity) <
              (lane.claimedAt ?? timestamp(latest?.requestedAt) ?? 0),
        )
        .map((e) => timestamp(e.promotedAt) ?? 0),
    );
    for (const activity of state.recentActivity ?? []) {
      const at = timestamp(activity.recordedAt);
      if (
        activity.repoName !== lane.repoName ||
        activity.ref !== `refs/heads/${state.project.defaultBranch}` ||
        /^0+$/.test(activity.after) ||
        at === undefined ||
        at < (lane.claimedAt ?? previousEnd) ||
        at > (lane.end ?? now)
      )
        continue;
      add(lane, "push", activity.recordedAt, String(activity.sequence));
    }
    lane.events.sort((a, b) => a.at - b.at);
    lane.start = lane.claimedAt ?? lane.events[0]?.at;
    const oldestLoaded = Math.min(
      Infinity,
      ...(state.recentActivity ?? []).map((a) => timestamp(a.recordedAt) ?? Infinity),
    );
    lane.earlierPushes =
      lane.claimedAt !== undefined && (oldestLoaded === Infinity || lane.claimedAt < oldestLoaded);
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const liveTimes = [...lanes.values()]
    .filter((l) => !l.end)
    .flatMap((l) => l.events.map((e) => e.at))
    .filter((at) => at >= now - 24 * HOUR);
  const start =
    choice === "four"
      ? now - 4 * HOUR
      : choice === "day"
        ? now - 24 * HOUR
        : choice === "today"
          ? midnight.getTime()
          : Math.max(now - 24 * HOUR, Math.min(now - 4 * HOUR, ...liveTimes));
  const visible = [...lanes.values()]
    .filter((l) => !l.end || l.end >= start)
    .toSorted(
      (a, b) =>
        Number(!!a.race) - Number(!!b.race) ||
        (a.race ?? "").localeCompare(b.race ?? "") ||
        (a.claimedAt ?? a.start ?? now) - (b.claimedAt ?? b.start ?? now),
    );
  const live = visible.filter((l) => !l.end).length;
  const races = new Set(visible.filter((l) => l.race).map((l) => l.race)).size;
  const promotions = state.ledger.filter(
    (e) =>
      (timestamp(e.promotedAt) ?? 0) >= midnight.getTime() &&
      (timestamp(e.promotedAt) ?? Infinity) <= now,
  ).length;
  const summary = [
    live ? `${live} live claim${live === 1 ? "" : "s"}` : "",
    races ? `${races} race${races === 1 ? "" : "s"}` : "",
    promotions ? `${promotions} promotion${promotions === 1 ? "" : "s"} today` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    lanes: visible,
    start,
    now,
    summary: summary || "No forks in flight",
    live,
    races,
    promotions,
    ledger: state.ledger.filter((e) => {
      const at = timestamp(e.promotedAt);
      return at !== undefined && at >= start && at <= now;
    }),
  };
}

/** Prefer the newest main label; older labels must fit without touching a chosen label. */
export function mainShaLabels(marks: { id: string; at: number; x: number }[], width: number) {
  const labels = new Map<string, number>();
  const half = 30;
  const nowSpace = 20;
  if (width < 52 + nowSpace + half * 2) return labels;
  for (const mark of marks.toSorted((a, b) => b.at - a.at)) {
    const center = Math.max(12 + half, Math.min(width - 40 - nowSpace - half, mark.x));
    if ([...labels.values()].every((x) => Math.abs(x - center) >= half * 2 + 12))
      labels.set(mark.id, center);
  }
  return labels;
}
/** Visible cells retain the three newest events in chronological order. */
export function tableEvents(events: ForkEvent[], kinds: string[]) {
  const matching = events
    .filter((event) => kinds.includes(event.kind))
    .toSorted((a, b) => a.at - b.at);
  return { shown: matching.slice(-3), earlier: matching.slice(0, -3) };
}

const significance: Record<LaneMarkKind, number> = {
  claim: 0,
  push: 1,
  review: 2,
  approved: 3,
  promoted: 4,
  passed: 5,
  failed: 5,
};
/** Adjacent dense events form one cluster; its tooltip retains every recorded event. */
export function foldMarks(events: ForkEvent[], start: number, now: number, width: number) {
  const groups: { event: ForkEvent; events: ForkEvent[]; x: number }[] = [];
  for (const event of events
    .filter((e) => e.at >= start && e.at <= now)
    .toSorted((a, b) => a.at - b.at)) {
    const x = ((event.at - start) / Math.max(1, now - start)) * width;
    const last = groups.at(-1);
    const previous = last?.events.at(-1);
    if (last && previous && x - ((previous.at - start) / Math.max(1, now - start)) * width < 16) {
      last.events.push(event);
      if (significance[event.kind] >= significance[last.event.kind]) {
        last.event = event;
        last.x = x;
      }
    } else groups.push({ event, events: [event], x });
  }
  return groups;
}
