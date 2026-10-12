import type {
  Activity,
  Brand,
  ProjectOption,
  ProjectState,
  Review,
  StateResponse,
} from "./contracts.ts";

export interface ViewModel {
  brand: Brand;
  projects: ProjectOption[];
  project: string;
  fixture: boolean;
  state?: ProjectState;
  activity: Activity[];
  busy: boolean;
  error?: string;
  notice?: string;
  updatedAt?: string;
  livePaused?: boolean;
}

/** Exact head and digest are visible; the server remains the authority for every action. */
export function reviewGate(
  review: Review,
  state: ProjectState,
): { approve: boolean; promote: boolean; reason: string } {
  const fork = state.forks.find((entry) => entry.repoName === review.repoName);
  if (!fork || fork.head !== review.sha || review.status === "stale") {
    return { approve: false, promote: false, reason: "Fork moved · request a fresh review" };
  }
  if (review.status === "promoted")
    return { approve: false, promote: false, reason: "Promoted to canonical" };
  const requireReceipt = state.project.settings?.requireReceipt;
  if (requireReceipt === undefined)
    return {
      approve: false,
      promote: false,
      reason: "Receipt settings unavailable. Refresh before reviewing.",
    };
  // An approved review may always enter promote: core freshly re-runs the gate there.
  if (
    requireReceipt &&
    review.status === "pending" &&
    (!review.receiptDigest || review.receipt?.status !== "passed")
  ) {
    return { approve: false, promote: false, reason: receiptGateCaption(review, true) };
  }
  const blocked = state.blockers.some(
    (blocker) => !blocker.resolved && blocker.packet === review.packet,
  );
  if (blocked)
    return { approve: false, promote: false, reason: "Resolve the packet's blockers first" };
  return {
    approve: review.status === "pending",
    promote: review.status === "approved",
    reason: receiptGateCaption(review, requireReceipt),
  };
}

/** Refuse incomplete snapshots instead of silently filling missing live data with fixtures. */
export function assertState(value: ProjectState): void {
  if (
    !value?.project?.id ||
    (value.canonicalHead !== undefined && typeof value.canonicalHead !== "string") ||
    ![
      value.agents,
      value.forks,
      value.packets,
      value.claims,
      value.blockers,
      value.reviews,
      value.ledger,
      value.reconcilerAlerts,
    ].every(Array.isArray)
  ) {
    throw new Error(
      "The state response does not match the dashboard contract. Check the host adapter.",
    );
  }
}

/** Map the concrete FH-005 wire fields once; embedding capabilities can return the same view. */
export function stateView(wire: StateResponse): ProjectState {
  if (
    !wire?.project?.id ||
    ![
      wire.agents,
      wire.forks,
      wire.packets,
      wire.claims,
      wire.blockers,
      wire.reviews,
      wire.ledger,
      wire.reconcilerAlerts,
    ].every(Array.isArray)
  ) {
    throw new Error(
      "The state response does not match the dashboard contract. Check the host adapter.",
    );
  }
  return {
    project: wire.project,
    recentActivity: wire.activity,
    agents: wire.agents,
    forks: wire.forks,
    packets: wire.packets,
    claims: wire.claims.map((claim) => ({ ...claim, active: true })),
    blockers: wire.blockers.map((blocker) => ({
      ...blocker,
      agent: blocker.pushingAgent,
      reason: `Push from ${blocker.pushingAgent} overlaps ${blocker.claimingAgent}'s live claim.`,
      resolved: false,
    })),
    reviews: wire.reviews.map((review) => ({
      ...review,
      requestedAt: review.createdAt,
      status: review.promoted
        ? "promoted"
        : review.stale ||
            (review.approval !== null &&
              (review.approval.sha !== review.sha ||
                (wire.project.settings?.requireReceipt !== false &&
                  review.receipt?.trigger !== "before-promote" &&
                  review.approval.receiptDigest !== review.receiptDigest)))
          ? "stale"
          : review.approval
            ? "approved"
            : "pending",
    })),
    ledger: wire.ledger.map((entry) => ({
      review: entry.review,
      sha: entry.after,
      promotedAt: entry.recordedAt,
    })),
    reconcilerAlerts: [
      ...wire.reconcilerAlerts.map((alert) => ({ sha: alert.after, message: alert.reason })),
      ...(wire.promotionPending
        ? [
            {
              sha: wire.promotionPending.after,
              message: "Promotion outcome pending owner inspection.",
            },
          ]
        : []),
    ],
  };
}

/** Keep unsuperseded stale rows visible, but count only actionable review states. */
export function reviewQueue(state: ProjectState): Review[] {
  return state.reviews.filter(
    (review) =>
      review.status !== "promoted" &&
      !(
        review.status === "stale" &&
        state.reviews.some(
          (other) =>
            other.packet === review.packet &&
            other.id !== review.id &&
            (other.status === "promoted" ||
              Date.parse(other.requestedAt ?? "") > Date.parse(review.requestedAt ?? "")),
        )
      ),
  );
}

/** Farrier receipt copy, with advisory semantics from the 16:55 ruling. */
export function receiptGateCaption(review: Review, required: boolean): string {
  const status = review.receipt?.status;
  if (!required) {
    if (!status) return "Receipts aren't required in this project.";
    if (status === "running")
      return "Checks are running. They're advisory here, so you can approve now.";
    return status === "passed" ? "" : "Advisory: this doesn't block approval.";
  }
  switch (status) {
    case "passed":
      return "";
    case "failed":
      return "Checks failed. The agent must push a fix.";
    case "timed-out":
      return "Checks timed out. A new push runs them again.";
    case "infrastructure-error":
      return "Checks couldn't start. A new push runs them again.";
    default:
      return "Waiting for checks.";
  }
}
