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
  noticeSha?: string;
  updatedAt?: string;
  livePaused?: boolean;
}

/** Exact head and digest are visible; the server remains the authority for every action. */
export function reviewGate(
  review: Review,
  state: ProjectState,
): { approve: boolean; promote: boolean; reason: string } {
  const cause = reviewState(review, state);
  if (cause.kind !== "current")
    return { approve: false, promote: false, reason: cause.caption || cause.label };
  // A missing fork or invalid approval binding cannot authorize an owner write.
  if (!state.forks.some((fork) => fork.repoName === review.repoName) || review.status === "stale")
    return { approve: false, promote: false, reason: "Refresh and request review again." };
  const requireReceipt = state.project.settings?.requireReceipt;
  if (requireReceipt === undefined)
    return {
      approve: false,
      promote: false,
      reason: "Receipt settings unavailable. Refresh before reviewing.",
    };
  // Failed before-promote code requires a fix; interrupted runs may be tried again.
  if (
    requireReceipt &&
    review.status === "pending" &&
    (!review.receiptDigest || review.receipt?.status !== "passed")
  ) {
    return { approve: false, promote: false, reason: receiptGateCaption(review, true) };
  }
  if (
    requireReceipt &&
    review.receipt?.trigger === "before-promote" &&
    review.receipt.status === "failed"
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

export type ReviewState = {
  kind: "current" | "promoted" | "returned" | "fork-moved" | "main-moved" | "out-of-date";
  label: string;
  caption: string;
  banner?: string;
  mainSha?: string;
};

/** First proven cause wins; main movement does not depend on core's stale flag. */
export function reviewState(review: Review, state: ProjectState): ReviewState {
  if (review.status === "promoted") return { kind: "promoted", label: "Promoted", caption: "" };
  if (review.returned) return { kind: "returned", label: "Returned", caption: "" };
  const fork = state.forks.find((entry) => entry.repoName === review.repoName);
  if (fork && fork.head !== review.sha)
    return {
      kind: "fork-moved",
      label: "Fork moved",
      caption: "The agent must request review again.",
      banner: "The fork moved after this review was requested. The agent must request review again.",
    };
  const latest = state.ledger.toSorted((a, b) => a.promotedAt.localeCompare(b.promotedAt)).at(-1);
  if (
    latest &&
    review.base &&
    latest.sha !== review.base &&
    !state.reconcilerAlerts.some((alert) => alert.id === "current-head") &&
    state.promotionPending === null
  )
    return {
      kind: "main-moved",
      label: "Main moved",
      mainSha: latest.sha,
      caption: "The agent must rebase and request review again.",
      banner: `main moved to ${latest.sha.slice(0, 7)} after this review was requested. The agent must rebase and request review again.`,
    };
  if (review.stale === true)
    return {
      kind: "out-of-date",
      label: "Out of date",
      caption: "The agent must request review again.",
      banner: "This review no longer applies. The agent must request review again.",
    };
  return { kind: "current", label: review.status === "approved" ? "Approved" : "In review", caption: "" };
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
    races: wire.races,
    forks: wire.forks,
    packets: wire.packets,
    claims: wire.claims.map((claim) => ({ ...claim, active: true })),
    blockers: wire.blockers.map((blocker) => ({
      ...blocker,
      agent: blocker.pushingAgent,
      reason: `Push from ${blocker.pushingAgent} overlaps ${blocker.claimingAgent}'s live claim.`,
      resolved: !!blocker.resolved,
    })),
    reviews: wire.reviews.map((review) =>
      reviewView(review, wire.project.settings?.requireReceipt),
    ),
    ledger: wire.ledger.map((entry) => ({
      id: entry.id,
      before: entry.before,
      review: entry.review,
      sha: entry.after,
      promotedAt: entry.recordedAt,
      receiptDigest: entry.receiptDigest,
      race: entry.race,
    })),
    reconcilerAlerts: wire.reconcilerAlerts.map((alert) => ({
      ...alert,
      sha: alert.after,
      message: alert.reason,
    })),
    promotionPending: wire.promotionPending,
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
  if (review.status === "approved" && review.receipt?.trigger === "before-promote") {
    if (status === "running") return "";
    if (status === "timed-out" || status === "infrastructure-error")
      return "Promote runs the checks again.";
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

function receiptTimestamp(review: Review & { receipt: NonNullable<Review["receipt"]> }): number {
  const value = Date.parse(review.receipt.finishedAt ?? review.receipt.startedAt);
  return Number.isFinite(value) ? value : 0;
}

/** Latest public summaries remain reachable even after their reviews leave the queue. */
export function recentReceipts(
  state: ProjectState,
): (Review & { receipt: NonNullable<Review["receipt"]> })[] {
  return state.reviews
    .filter(
      (review): review is Review & { receipt: NonNullable<Review["receipt"]> } => !!review.receipt,
    )
    .toSorted((a, b) => receiptTimestamp(b) - receiptTimestamp(a) || a.id.localeCompare(b.id))
    .slice(0, 5);
}

/** A ledger digest identifies the historical receipt, never merely the latest review for a packet. */
export function promotionReceipt(
  state: ProjectState,
  entry: ProjectState["ledger"][number],
): Review | undefined {
  if (!entry.receiptDigest) return;
  return state.reviews.find(
    (review) =>
      review.id === entry.review &&
      review.sha === entry.sha &&
      review.receipt?.digest === entry.receiptDigest &&
      review.receipt?.status !== "running",
  );
}

/** Shared public review projection keeps detail and queue approval bindings identical. */
export function reviewView(
  review: StateResponse["reviews"][number],
  requireReceipt?: boolean,
): Review {
  return {
    ...review,
    requestedAt: review.createdAt,
    status: review.promoted
      ? "promoted"
      : review.stale ||
          (review.approval !== null &&
            (review.approval.sha !== review.sha ||
              (requireReceipt !== false &&
                review.receipt?.trigger !== "before-promote" &&
                review.approval.receiptDigest !== review.receiptDigest)))
        ? "stale"
        : review.approval
          ? "approved"
          : "pending",
  };
}
