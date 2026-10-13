import type { ReviewDetail, ReviewDiff, StateResponse } from "../src/contracts.ts";
import { fixtureState } from "./fixtures.ts";

/** FH-039 contract fixtures only; no core or owner account is contacted. */
export const reviewScenarios = [
  "review-current",
  "review-approved",
  "review-promoted",
  "review-returned",
  "review-stale",
  "review-advisory",
  "review-changes",
  "review-error",
  "review-loading",
  "review-not-found",
  "review-conflict",
];
export function reviewFixtureState(id: string): StateResponse {
  const state = fixtureState("receipts");
  state.project.id = id;
  state.reviews = [state.reviews[2]];
  const r = state.reviews[0];
  r.id = "review-1";
  r.packet = "FH-040";
  r.returned = null;
  r.approval = null;
  state.project.settings = { requireReceipt: id !== "review-advisory" };
  state.packets = [
    {
      id: r.packet,
      title: "Review in a minute",
      goal: "Understand the request and inspect each claim.\nKeep the evidence separate.",
      paths: ["packages/forkhorse-dashboard/**"],
      acceptance: [
        "Owner and agent see the request.",
        "Return records a reason.",
        "Changed files open inline diffs.",
      ],
    },
  ];
  state.blockers = [];
  if (id === "review-approved" || id === "review-promoted")
    r.approval = { sha: r.sha, receiptDigest: r.receiptDigest };
  if (id === "review-promoted") {
    r.promoted = true;
    state.ledger = [
      {
        id: "promotion-1",
        review: r.id,
        repoName: state.project.repoName,
        ref: "refs/heads/main",
        before: r.base,
        after: r.sha,
        receiptDigest: r.receiptDigest,
        recordedAt: "2026-10-13T08:00:00Z",
      },
    ];
  }
  if (id === "review-returned")
    r.returned = {
      reason:
        "Explain the changed behavior.\n<script>plain text</script>\nPreserve the acceptance evidence.",
      at: "2026-10-13T08:00:00Z",
    };
  if (id === "review-stale") {
    r.stale = true;
    state.forks.find((f) => f.repoName === r.repoName)!.head = "9".repeat(40);
  }
  if (id === "review-advisory")
    r.receipt = {
      ...r.receipt!,
      status: "failed",
      checks: [{ ...r.receipt!.checks[0], outcome: "failed" }],
    };
  if (id === "review-changes") {
    state.activity[0].changedPaths = Array.from({ length: 400 }, (_, i) => `src/path-${i}.ts`);
    state.activity[0].changedPathCount = 400;
  }
  return state;
}
export function reviewFixtureDetail(state: StateResponse): ReviewDetail {
  const review = state.reviews[0];
  const large = state.project.id === "review-changes";
  const extraCommits = large
    ? Array.from({ length: 48 }, (_, i) => ({
        sha: (i + 16).toString(16).padStart(40, "0"),
        subject: `Earlier fixture change ${i + 1}`,
        authorName: "fixture-agent",
        packetTrailer: null,
        agentTrailer: null,
      }))
    : [];
  return {
    review,
    packet: state.packets[0],
    changes: {
      base: review.base,
      head: review.sha,
      fileCount: large ? 400 : 4,
      truncated: large,
      files: ([
        { path: "src/review.tsx", status: "modified" },
        { path: "assets/image.bin", status: "added" },
        { path: "docs/large.txt", status: "deleted" },
        { path: "missing.txt", status: "modified" },
        ...(large
          ? Array.from({ length: 196 }, (_, i) => ({
              path: `src/very/long/nested/fixture/path-${i}.ts`,
              status: "modified" as const,
            }))
          : []),
      ] satisfies ReviewDetail["changes"]["files"]).toSorted((a, b) => a.path.localeCompare(b.path)),
    },
    commits: [
      {
        sha: review.sha,
        subject: "🐎 Add the review view",
        authorName: "fixture-agent",
        packetTrailer: "FH-040",
        agentTrailer: "codex",
      },
      {
        sha: "8".repeat(40),
        subject: "Prepare review contract",
        authorName: "fixture-agent",
        packetTrailer: null,
        agentTrailer: null,
      },
      ...extraCommits,
    ],
    commitsTruncated: large,
    promotion: state.ledger.find((l) => l.review === review.id) ?? null,
    blockers: state.blockers,
  };
}
export function reviewFixtureDiff(path: string): ReviewDiff {
  return {
    path,
    status:
      path === "assets/image.bin" ? "added" : path === "docs/large.txt" ? "deleted" : "modified",
    binary: path === "assets/image.bin",
    truncated: path === "docs/large.txt",
    patch:
      path === "docs/large.txt"
        ? "@@ -1,2 +0,0 @@\n-old content\n-more removed content"
        : "--- a/src/review.tsx\n+++ b/src/review.tsx\n@@ -1 +1 @@\n-previous value\n+<script>plain text only</script>\n context with a very long " +
          "fixture ".repeat(40),
  };
}
