import type {
  Activity,
  ProjectState,
  StateResponse,
  ReceiptSummary,
  ReceiptStatus,
  OwnerReceipt,
} from "../src/contracts.ts";

export const HEAD = "a".repeat(40);
export const NEXT_HEAD = "b".repeat(40);
export const DIGEST = "d".repeat(64);

/** Fictional fixture data. Neither this nor fixture routes ship in production assets. */
function fixtureData(id = "demo"): ProjectState {
  if (id === "quiet")
    return {
      project: { id, repoName: id, defaultBranch: "main", settings: { requireReceipt: true } },
      canonicalHead: HEAD,
      agents: [],
      forks: [],
      packets: [],
      claims: [],
      blockers: [],
      reviews: [],
      ledger: [],
      reconcilerAlerts: [],
    };
  return {
    project: { id, repoName: id, defaultBranch: "main", settings: { requireReceipt: true } },
    canonicalHead: HEAD,
    agents: [{ name: "builder" }, { name: "reviewer" }, { name: "docs" }],
    forks: [
      { agent: "builder", repoName: "demo--builder-1", head: NEXT_HEAD },
      { agent: "reviewer", repoName: "demo--reviewer-1", head: "c".repeat(40) },
      { agent: "docs", repoName: "demo--docs-1", head: "e".repeat(40) },
    ],
    packets: [
      {
        id: "ui-01",
        title: "Project navigation & owner review",
        goal: "Keep scoped work and its evidence together, from claim to promotion.",
        paths: ["src/dashboard/**"],
        acceptance: ["Phone and desktop layouts render", "Approve uses the review endpoint"],
      },
      {
        id: "api-02",
        title: "Claim conflict detection",
        goal: "Raise a blocker when an agent pushes into another live claim.",
        paths: ["src/claims/**"],
        acceptance: ["Conflicting path creates a blocker"],
      },
      {
        id: "docs-03",
        title: "Owner setup guide",
        goal: "Describe deployment configuration and the evidence required for release.",
        paths: ["docs/**"],
        acceptance: ["Examples use fictional fixture values"],
      },
    ],
    claims: [
      {
        packet: "ui-01",
        agent: "builder",
        repoName: "demo--builder-1",
        paths: ["src/dashboard/**"],
        active: true,
      },
      {
        packet: "api-02",
        agent: "reviewer",
        repoName: "demo--reviewer-1",
        paths: ["src/claims/**"],
        active: true,
      },
      {
        packet: "docs-03",
        agent: "docs",
        repoName: "demo--docs-1",
        paths: ["docs/**"],
        active: true,
      },
    ],
    blockers: [
      {
        id: "block-1",
        agent: "reviewer",
        packet: "api-02",
        paths: ["src/claims/index.ts"],
        reason: "Push overlaps a path held by another agent's live claim.",
        resolved: false,
      },
    ],
    reviews: [
      {
        id: "review-1",
        repoName: "demo--builder-1",
        agent: "builder",
        packet: "ui-01",
        sha: NEXT_HEAD,
        receiptDigest: DIGEST,
        status: "pending",
        receipt: fixtureReceipt("passed"),
      },
      {
        id: "review-2",
        repoName: "demo--docs-1",
        agent: "docs",
        packet: "docs-03",
        sha: "f".repeat(40),
        receiptDigest: "1".repeat(64),
        status: "stale",
        receipt: fixtureReceipt("passed"),
      },
      {
        id: "review-3",
        repoName: "demo--reviewer-1",
        agent: "reviewer",
        packet: "api-02",
        sha: "c".repeat(40),
        receiptDigest: null,
        status: "pending",
      },
    ],
    ledger: [],
    reconcilerAlerts: [],
  };
}

export function fixtureActivity(): Activity[] {
  return [
    {
      sequence: 1,
      namespace: "fixture",
      repoName: "demo--builder-1",
      agent: "builder",
      ref: "refs/heads/main",
      before: HEAD,
      after: NEXT_HEAD,
      changedPaths: ["src/dashboard/index.ts"],
      eventTimestamp: "2026-10-12T00:10:00.000Z",
      recordedAt: "2026-10-12T00:10:01.000Z",
    },
    {
      sequence: 2,
      namespace: "fixture",
      repoName: "demo--reviewer-1",
      agent: "reviewer",
      ref: "refs/heads/main",
      before: HEAD,
      after: "c".repeat(40),
      changedPaths: ["src/claims/index.ts"],
      eventTimestamp: "2026-10-12T00:12:00.000Z",
      recordedAt: "2026-10-12T00:12:01.000Z",
    },
    {
      sequence: 3,
      namespace: "fixture",
      repoName: "demo--docs-1",
      agent: "docs",
      ref: "refs/heads/main",
      before: HEAD,
      after: "e".repeat(40),
      changedPaths: ["docs/setup.md"],
      eventTimestamp: "2026-10-12T00:15:00.000Z",
      recordedAt: "2026-10-12T00:15:01.000Z",
    },
  ];
}

/** Fixture API emits the FH-005 wire contract, not the view's normalized projection. */
export function fixtureState(id = "demo"): StateResponse {
  const data = fixtureData(id);
  const createdAt = "2026-10-12T00:00:00.000Z";
  const result: StateResponse = {
    project: {
      ...data.project,
      namespace: "fixture",
      events: "active",
      remote: `https://git.idiot.tax/fixture/${id}.git`,
    },
    agents: data.agents,
    forks: data.forks.map((fork, index) => ({
      events: index === 0 ? "active" : "pending",
      ...fork,
      remote: `https://git.idiot.tax/fixture/${fork.repoName}.git`,
      createdAt,
    })),
    packets: data.packets,
    claims: data.claims.map(({ active: _active, ...claim }) => ({ ...claim, createdAt })),
    blockers: data.blockers.map((blocker) => ({
      id: blocker.id,
      packet: blocker.packet,
      claimingAgent: "builder",
      pushingAgent: blocker.agent,
      repoName: "demo--reviewer-1",
      sha: "c".repeat(40),
      paths: blocker.paths,
    })),
    reviews: data.reviews.map(({ status, ...review }) => ({
      ...review,
      base: HEAD,
      approval:
        status === "approved" ? { sha: review.sha, receiptDigest: review.receiptDigest } : null,
      stale: status === "stale",
      promoted: status === "promoted",
      createdAt,
    })),
    ledger: [],
    activity: id === "quiet" ? [] : fixtureActivity(),
    reconcilerAlerts: [],
    promotionPending: null,
  };
  if (["large", "truncated"].includes(id)) {
    const agent = "oauth-aee4061c-representative-long-agent-name";
    result.agents[0].name = agent;
    result.forks[0].agent = agent;
    result.claims[0].agent = agent;
    result.reviews[0].agent = agent;
    result.activity[0].agent = agent;
  }
  if (id === "superseded") {
    const stale = structuredClone(result.reviews[0]);
    stale.id = "superseded-stale";
    stale.stale = true;
    stale.sha = "9".repeat(40);
    stale.createdAt = "2026-10-11T00:00:00Z";
    result.reviews[0].promoted = true;
    result.reviews = [result.reviews[0], stale];
  }
  if (["large", "first", "partial", "truncated", "deleted"].includes(id)) {
    const paths = Array.from(
      { length: 450 },
      (_, i) => `src/imported/assets/group-${i}/very-long-filename-for-path-overflow-check-${i}.ts`,
    );
    for (const packet of result.packets) packet.paths = paths;
    for (const claim of result.claims) claim.paths = paths;
    for (const blocker of result.blockers) blocker.paths = paths;
    for (const activity of result.activity) {
      activity.changedPaths =
        id === "partial" ? paths.slice(0, 30) : id === "truncated" ? paths.slice(0, 50) : paths;
      if (id === "first") activity.before = "0".repeat(40);
      if (id === "deleted") {
        activity.after = "0".repeat(40);
        activity.ref = "refs/heads/topic";
      }
      if (id === "truncated") {
        activity.changedPathCount = 205;
        activity.changedPathsTruncated = true;
      }
      if (id === "partial") {
        activity.changedPathCount = 450;
        activity.changedPathsTruncated = true;
      }
    }
  }
  if (
    [
      "receipts",
      "advisory",
      "recheck",
      "rerun-failed",
      "gating-recheck",
      "history-required",
      "history-advisory",
    ].includes(id)
  ) {
    const statuses: (ReceiptStatus | null)[] = [
      "running",
      "running",
      "passed",
      "failed",
      "timed-out",
      "infrastructure-error",
      null,
    ];
    result.project.settings = { requireReceipt: id !== "advisory" && id !== "receipts" };
    result.blockers = [];
    result.claims = [];
    result.packets = [];
    result.forks = [];
    result.reviews = statuses.map((status, index) => {
      const sha = String(index + 1).repeat(40);
      const packet = `ui-${String(index + 1).padStart(2, "0")}`;
      const agent = `builder-${index + 1}`;
      const repoName = `${id}--${agent}-1`;
      result.packets.push({
        id: packet,
        title: `Receipt ${packet}`,
        goal: "Inspect fixture checks",
        paths: ["src/dashboard/**"],
        acceptance: ["Receipt state shown"],
      });
      result.forks.push({
        agent,
        repoName,
        head: sha,
        remote: `https://git.idiot.tax/fixture/${repoName}.git`,
        createdAt,
      });
      const receipt = status
        ? fixtureReceipt(status, index === 1 ? "before-promote" : "review-created")
        : null;
      return {
        id: `receipt-${index + 1}`,
        packet,
        agent,
        repoName,
        sha,
        base: HEAD,
        receiptDigest: receipt?.digest ?? null,
        receipt,
        approval:
          index === 2 || (index === 1 && id !== "advisory")
            ? { sha, receiptDigest: index === 1 ? DIGEST : (receipt?.digest ?? null) }
            : null,
        stale: false,
        promoted: false,
        createdAt,
      };
    });
    // A truthful required gate fixture also carries the two queue running trigger variants.
    if (id === "receipts") result.project.settings.requireReceipt = true;
    if (id === "advisory") result.reviews[1].receipt!.trigger = "review-created";
    if (id === "gating-recheck") {
      for (const index of [2, 4, 5]) {
        const review = result.reviews[index];
        review.receipt = fixtureReceipt(
          index === 2 ? "failed" : index === 4 ? "timed-out" : "infrastructure-error",
          "before-promote",
        );
        review.receiptDigest = review.receipt.digest;
        review.approval = { sha: review.sha, receiptDigest: DIGEST };
      }
    }
  }
  if (id === "history-required" || id === "history-advisory") {
    result.project.settings = { requireReceipt: id === "history-required" };
    for (const review of result.reviews) {
      if (review.receipt?.status === "running") review.receipt.startedAt = "2026-10-12T00:00:00Z";
    }
    const source = result.reviews[2];
    // Shuffled history spans repeated packet IDs and both promotion modes.
    const promoted = Array.from({ length: 7 }, (_, index) => {
      const receipt = fixtureReceipt(
        index === 6 && id === "history-advisory" ? "failed" : "passed",
        id === "history-required" ? "before-promote" : "review-created",
      );
      receipt.digest = String(index + 1).repeat(64);
      receipt.finishedAt = `2026-10-12T01:0${index}:41Z`;
      const review = {
        ...structuredClone(source),
        id: `promoted-${index}`,
        packet: `history-${index}`,
        sha: String(index + 1).repeat(40),
        receipt,
        receiptDigest: receipt.digest,
        approval: null,
        promoted: true,
      };
      result.ledger.push({
        id: `promotion-${index}`,
        review: review.id,
        repoName: id,
        ref: "refs/heads/main",
        before: HEAD,
        after: review.sha,
        receiptDigest: receipt.digest,
        recordedAt: receipt.finishedAt,
      });
      return review;
    });
    result.reviews.push(...promoted.toReversed());
  }
  return result;
}

export function fixtureReceipt(
  status: ReceiptStatus,
  trigger: ReceiptSummary["trigger"] = "review-created",
): ReceiptSummary {
  return {
    status,
    trigger,
    digest: status === "running" ? null : DIGEST,
    startedAt:
      status === "running" ? new Date(Date.now() - 12000).toISOString() : "2026-10-12T00:00:00Z",
    finishedAt: status === "running" ? null : "2026-10-12T00:00:41Z",
    durationMs: status === "running" ? null : 41000,
    checks: [
      fixtureCheck(
        "brand",
        status,
        status === "running" ? null : status === "timed-out" ? 110000 : 13000,
      ),
      fixtureCheck(
        "types",
        status === "running" ? "running" : "passed",
        status === "running" ? null : 14000,
      ),
      fixtureCheck(
        "tests",
        status === "running" ? "running" : "passed",
        status === "running" ? null : 14000,
      ),
    ],
  };
}
export function fixtureOwnerReceipt(review: StateResponse["reviews"][number]): OwnerReceipt {
  return {
    digest: review.receipt!.digest!,
    receipt: {
      commit: review.sha,
      checks: review.receipt!.checks.map((check) => ({
        check: { name: check.name },
        logs: {
          stdout: Array.from(
            { length: 220 },
            (_, index) =>
              `${check.name} fixture output ${index + 1}${index === 219 ? " <script>fixture</script>" : ""}`,
          ).join("\n"),
          stderr: "Fixture stderr",
          truncated: false,
        },
      })),
    },
  };
}

function fixtureCheck(name: string, outcome: ReceiptStatus, durationMs: number | null) {
  return { name, tier: "full" as const, outcome, durationMs };
}
