import type { StateResponse } from "../src/contracts.ts";
import { fixtureState, fixtureReceipt } from "./fixtures.ts";
export const forkScenarios = [
  "fork-hero",
  "fork-history",
  "fork-resolved",
  "fork-old",
  "fork-many",
  "fork-empty",
  "fork-dense",
  "fork-live",
];
/** Clock-relative, explicitly fictional loopback fixtures. No browser clock freezing needed. */
export function forkFixtureState(id: string, now = Date.now()): StateResponse {
  const state = fixtureState("quiet");
  state.project.id = id;
  state.project.repoName = "fixture-project";
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  state.agents = [
    { name: "fixture-alpha", createdAt: null },
    { name: "fixture-beta", createdAt: null },
    { name: "fixture-gamma", createdAt: at(400) },
  ];
  if (id === "fork-empty") return state;
  const names = state.agents.map((a) => a.name);
  state.packets = [];
  state.forks = [];
  state.claims = [];
  state.reviews = [];
  state.activity = [];
  state.ledger = [];
  for (let i = 0; i < (id === "fork-many" ? 11 : 3); i++) {
    const agent = names[i % 3],
      packet = `fixture-${String(i + 1).padStart(2, "0")}`,
      repoName = `fixture-fork-${i + 1}`,
      sha = String(i + 1)
        .repeat(40)
        .slice(0, 40);
    state.packets.push({
      id: packet,
      title: `Fixture packet ${i + 1}`,
      goal: "Fixture graph evidence",
      paths: [`fixture-${i}/**`],
      acceptance: ["Fixture checks"],
    });
    state.forks.push({
      agent,
      repoName,
      head: sha,
      remote: "https://git.idiot.tax/fixture",
      createdAt: at(220),
    });
    if (i !== 0)
      state.claims.push({
        packet,
        agent,
        repoName,
        paths: [`fixture-${i}/**`],
        createdAt: at(id === "fork-old" ? 500 : 180 - i * 20),
      });
    const receipt = {
      ...fixtureReceipt(i === 2 ? "running" : "passed"),
      startedAt: at(75 - i * 10),
      finishedAt: i === 2 ? null : at(70 - i * 10),
    };
    state.reviews.push({
      id: `fixture-review-${i}`,
      packet,
      repoName,
      agent,
      sha,
      base: "a".repeat(40),
      receiptDigest: receipt.digest,
      receipt,
      approval: i === 2 ? null : { sha, receiptDigest: receipt.digest },
      approvedAt: i === 2 ? null : at(60 - i * 10),
      stale: false,
      promoted: i === 0,
      createdAt: at(100 - i * 10),
    });
    if (i === 1)
      state.reviews.unshift({
        ...state.reviews.at(-1)!,
        id: "fixture-failed",
        createdAt: at(120),
        approval: null,
        approvedAt: null,
        receipt: { ...fixtureReceipt("failed"), startedAt: at(115), finishedAt: at(110) },
      });
    for (const [j, minute] of [150 - i * 10, 90 - i * 10].entries())
      state.activity.push({
        sequence: i * 2 + j + 1,
        namespace: "fixture",
        repoName,
        agent,
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: sha,
        changedPaths: [`fixture-${i}/index.ts`],
        eventTimestamp: at(minute + 2),
        recordedAt: at(minute),
      });
    if (i === 0)
      state.ledger.push({
        id: "fixture-merge",
        review: "fixture-review-0",
        repoName: state.project.repoName,
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: sha,
        receiptDigest: receipt.digest,
        recordedAt: at(30),
      });
  }
  if (id === "fork-history") {
    const latest = state.reviews.find((r) => r.id === "fixture-review-1")!;
    const basePush = state.activity.find((a) => a.repoName === latest.repoName)!;
    for (const [i, minutes] of [130, 125, 115, 105, 95, 85].entries()) {
      state.activity.push({
        ...basePush,
        sequence: 100 + i,
        recordedAt: at(minutes),
        eventTimestamp: at(minutes),
      });
      state.reviews.unshift({
        ...latest,
        id: `fixture-history-review-${i}`,
        createdAt: at(minutes - 1),
        approvedAt: at(minutes - 3),
        receipt: { ...latest.receipt!, finishedAt: at(minutes - 2) },
      });
    }
    const merged = state.reviews.find((r) => r.id === "fixture-review-0")!;
    for (const [i, minutes] of [95, 70, 29, 27, 2].entries()) {
      const sha = String(i + 4).repeat(40);
      const review = {
        ...merged,
        id: `fixture-history-merge-${i}`,
        sha,
        createdAt: at(minutes + 5),
        approvedAt: at(minutes + 2),
        receipt: { ...merged.receipt!, finishedAt: at(minutes + 3) },
      };
      state.reviews.push(review);
      state.ledger.push({
        ...state.ledger[0],
        id: `fixture-ledger-${i}`,
        review: review.id,
        after: sha,
        recordedAt: at(minutes),
      });
    }
  }
  state.blockers = [
    {
      id: "fixture-collision",
      packet: "fixture-03",
      pushingPacket: "fixture-02",
      claimingAgent: names[2],
      pushingAgent: names[1],
      repoName: "fixture-fork-2",
      sha: "2".repeat(40),
      paths: ["fixture-2/index.ts"],
      at: at(85),
      resolved: id === "fork-resolved" ? { at: at(40), by: "owner" } : null,
    },
  ];
  if (id === "fork-dense") {
    const review = state.reviews.find((r) => r.id === "fixture-review-1")!;
    review.createdAt = at(45);
    review.approvedAt = at(43);
    review.receipt!.finishedAt = at(44);
    state.activity.push({
      ...state.activity[2],
      sequence: 99,
      recordedAt: at(46),
      eventTimestamp: at(46),
    });
    state.blockers[0].at = at(44.5);
  }
  state.races = [
    {
      packet: "fixture-race",
      status: "open",
      finishedAt: null,
      winner: null,
      ledgerEntryId: null,
      entrants: names.slice(0, 2).map((agent, i) => ({
        agent,
        repoName: `fixture-race-fork-${i}`,
        claimedAt: at(35 - i * 2),
        firstPushAt: i ? null : at(25),
        reviewRequestedAt: null,
        receiptPassedAt: null,
        approvedAt: null,
        promotedAt: null,
        place: null,
        closedAt: null,
        closedBy: null,
      })),
    },
  ];
  state.packets.push({
    id: "fixture-race",
    title: "Fixture race",
    goal: "Fixture",
    paths: [],
    acceptance: [],
    mode: "race",
  });
  return state;
}
