import type { Activity, ProjectState, StateResponse } from "../src/contracts.ts";

export const HEAD = "a".repeat(40);
export const NEXT_HEAD = "b".repeat(40);
export const DIGEST = "d".repeat(64);

/** Fictional fixture data. Neither this nor fixture routes ship in production assets. */
function fixtureData(id = "demo"): ProjectState {
  if (id === "quiet")
    return {
      project: { id, repoName: id, defaultBranch: "main" },
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
    project: { id, repoName: id, defaultBranch: "main" },
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
        receipt: { status: "passed", commands: ["pnpm test", "pnpm lint"] },
      },
      {
        id: "review-2",
        repoName: "demo--docs-1",
        agent: "docs",
        packet: "docs-03",
        sha: "f".repeat(40),
        receiptDigest: "1".repeat(64),
        status: "stale",
        receipt: { status: "passed", commands: ["pnpm test"] },
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
  return {
    project: {
      ...data.project,
      namespace: "fixture",
      remote: `https://git.idiot.tax/fixture/${id}.git`,
    },
    agents: data.agents,
    forks: data.forks.map((fork) => ({
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
    reviews: data.reviews.map(({ status, receipt: _receipt, ...review }) => ({
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
}
