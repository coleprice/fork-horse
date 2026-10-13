import type { StateResponse, UsageSources } from "../src/contracts.ts";
import { reviewFixtureState, reviewFixtureDetail } from "./review-fixtures.ts";

export const usageScenarios = [
  "usage-race",
  "usage-over",
  "usage-unchecked",
  "usage-both",
  "usage-legacy",
];
export function usageFixtureState(id = "usage-race", now = Date.now()): StateResponse {
  const state = reviewFixtureState("review-approved");
  state.project.id = id;
  state.ledger = [];
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const usage = (total: number): UsageSources => ({
    reported: {
      inputTokens: total - 20000,
      outputTokens: 20000,
      model: "fixture-model",
      source: "reported",
      at: at(2),
    },
    metered: null,
  });
  const baseReview = structuredClone(state.reviews[0]);
  state.agents = ["fixture-agent", "fixture-peer", "fixture-third"].map((name, i) => ({
    name,
    createdAt: at(60 - i),
  }));
  state.reviews = state.agents.map((a, i) => ({
    ...structuredClone(baseReview),
    agent: a.name,
    id: `usage-review-${i}`,
    repoName: `fixture-fork-${i}`,
    sha: String(i + 1).repeat(40),
    createdAt: at(10 - i),
    approvedAt: at(5 - i),
    usageAtReview: usage([420000, 820000, 1100000][i]),
  }));
  state.forks = state.reviews.map((r) => ({
    agent: r.agent,
    repoName: r.repoName,
    head: r.sha,
    remote: "https://fixture.idiot.tax/repo.git",
    createdAt: at(50),
  }));
  for (const [i, r] of state.reviews.entries()) {
    if (r.receipt) { r.receipt.startedAt = at(10 - i); r.receipt.finishedAt = at(8 - i); }
  }
  for (const r of state.reviews) r.approval = { sha: r.sha, receiptDigest: r.receiptDigest };
  state.packets[0].mode = "race";
  state.packets[0].tokenBudget = 1000000;
  state.races = [
    {
      packet: state.packets[0].id,
      status: "open",
      finishedAt: null,
      winner: null,
      ledgerEntryId: null,
      tokenBudget: 1000000,
      entrants: state.reviews.map((r, i) => ({
        agent: r.agent,
        repoName: r.repoName,
        claimedAt: at(30 - i),
        firstPushAt: at(20 - i),
        reviewRequestedAt: r.createdAt,
        receiptPassedAt: at(8 - i),
        approvedAt: r.approvedAt!,
        promotedAt: null,
        place: null,
        closedAt: null,
        closedBy: null,
        usage: structuredClone(r.usageAtReview),
        budget: (["within", "near", "over"] as const)[i],
      })),
    },
  ];
  state.claims = state.races[0].entrants.map((e) => ({
    packet: state.packets[0].id,
    agent: e.agent,
    repoName: e.repoName,
    paths: state.packets[0].paths,
    createdAt: e.claimedAt,
    usage: e.usage,
  }));
  state.activity = state.races[0].entrants.map((e, i) => ({
    sequence: i + 1,
    namespace: "fixture",
    agent: e.agent,
    repoName: e.repoName,
    ref: "refs/heads/main",
    before: baseReview.base,
    after: state.reviews[i].sha,
    changedPaths: ["src/example.ts"],
    recordedAt: e.firstPushAt!,
    eventTimestamp: e.firstPushAt!,
  }));
  if (id === "usage-over") {
    state.reviews = [state.reviews[2]];
  }
  if (id === "usage-unchecked") {
    state.races[0].entrants[0].usage = { reported: null, metered: null };
    state.races[0].entrants[0].budget = "unchecked";
    state.claims[0].usage = state.races[0].entrants[0].usage;
    state.reviews[0].usageAtReview = state.races[0].entrants[0].usage;
  }
  if (id === "usage-both") {
    for (const e of state.races[0].entrants)
      e.usage!.metered = { inputTokens: 240000, outputTokens: 10000, source: "metered", at: at(1) };
    for (const r of state.reviews)
      r.usageAtReview = structuredClone(
        state.races[0].entrants.find((e) => e.agent === r.agent)!.usage,
      );
    for (const e of state.races[0].entrants) e.budget = "within";
  }
  if (id === "usage-legacy") {
    for (const r of state.reviews) delete r.usageAtReview;
    for (const c of state.claims) delete c.usage;
    for (const e of state.races[0].entrants) {
      delete e.usage;
      delete e.budget;
    }
    delete state.races[0].tokenBudget;
    delete state.packets[0].tokenBudget;
  }
  return state;
}
export function usageFixtureDetail(state: StateResponse, id: string) {
  const review = state.reviews.find((r) => r.id === id)!;
  const detail = reviewFixtureDetail({ ...state, reviews: [review] });
  detail.changes.fileCount = detail.changes.files.length;
  return detail;
}
