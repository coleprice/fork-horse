import type { RaceEntrant, StateResponse } from "../src/contracts.ts";
import { fixtureReceipt, fixtureState, HEAD } from "./fixtures.ts";

export const raceScenarios = [
  "race-open",
  "race-finished",
  "race-photo",
  "race-photo-unattempted",
  "race-empty",
  "race-loading",
  "race-error",
  "race-unknown",
  "race-standard",
  "race-advisory",
];
const at = (seconds: number) =>
  new Date(Date.parse("2026-10-13T14:02:00Z") + seconds * 1000).toISOString().replace(".000Z", "Z");
const entrant = (agent: string, claimed: number): RaceEntrant => ({
  agent,
  repoName: `race--${agent}-1`,
  claimedAt: at(claimed),
  firstPushAt: null,
  reviewRequestedAt: null,
  receiptPassedAt: null,
  approvedAt: null,
  promotedAt: null,
  place: null,
  closedAt: null,
  closedBy: null,
  promoteRejected: null,
});
/** Fixed offline FH-052/053 snapshots. Never implies an enrolled/live race. */
export function raceFixtureState(scenario = "race-open"): StateResponse {
  const state = fixtureState("quiet");
  state.project.id = scenario;
  state.project.repoName = "race-fixture";
  state.project.settings = { requireReceipt: scenario !== "race-advisory" };
  // Response order deliberately differs from stable identity and lane order.
  state.agents = [
    { name: "cedar", createdAt: "2026-10-13T14:00:00Z" },
    { name: "amber", createdAt: null },
    { name: "birch", createdAt: null },
  ];
  state.packets = [
    {
      id: "race-01",
      title: "Add retries to the webhook client",
      goal: "Retry transient webhook errors.",
      paths: ["src/webhooks/**"],
      acceptance: ["Retries stay bounded"],
      mode: scenario === "race-standard" ? "standard" : "race",
    },
  ];
  const birch = entrant("birch", 0),
    cedar = entrant("cedar", 10),
    amber = entrant("amber", 60);
  Object.assign(birch, {
    firstPushAt: at(240),
    reviewRequestedAt: at(360),
    receiptPassedAt: at(540),
  });
  Object.assign(cedar, {
    firstPushAt: at(180),
    reviewRequestedAt: at(300),
    receiptPassedAt: at(480),
    approvedAt: at(600),
  });
  const finished = ["race-finished", "race-photo", "race-photo-unattempted"].includes(scenario);
  const race = {
    packet: "race-01",
    status: finished ? ("finished" as const) : ("open" as const),
    finishedAt: finished ? at(720) : null,
    winner: finished ? "cedar" : null,
    ledgerEntryId: finished ? "ledger-race-1" : null,
    entrants: [amber, cedar, birch],
  };
  if (finished) {
    Object.assign(cedar, {
      promotedAt: at(720),
      place: 1,
      closedAt: at(720),
      closedBy: "race-finished",
    });
    Object.assign(birch, {
      approvedAt: scenario.startsWith("race-photo") ? at(660) : null,
      place: 2,
      closedAt: at(720),
      closedBy: "race-finished",
    });
    Object.assign(amber, {
      firstPushAt: at(420),
      reviewRequestedAt: at(540),
      place: 3,
      closedAt: at(720),
      closedBy: "race-finished",
    });
    if (scenario === "race-photo")
      birch.promoteRejected = {
        at: "2026-10-13T14:14:00.400Z",
        expected: HEAD,
        found: "c".repeat(40),
      };
    state.ledger = [
      {
        id: "ledger-race-1",
        review: "race-review-cedar",
        repoName: cedar.repoName,
        ref: "refs/heads/main",
        before: HEAD,
        after: "c".repeat(40),
        receiptDigest: "d".repeat(64),
        recordedAt: at(720),
      },
    ];
  }
  if (scenario === "race-advisory") cedar.receiptPassedAt = null;
  if (scenario === "race-empty") race.entrants = [];
  state.races = scenario === "race-standard" || scenario === "race-unknown" ? [] : [race];
  state.forks = [birch, cedar, amber].map((entry, index) => ({
    agent: entry.agent,
    repoName: entry.repoName,
    head: ["b", "c", "e"][index].repeat(40),
    remote: `https://git.idiot.tax/${entry.repoName}`,
    createdAt: entry.claimedAt,
  }));
  state.claims = race.entrants
    .filter((entry) => !entry.closedAt)
    .map((entry) => ({
      packet: race.packet,
      agent: entry.agent,
      repoName: entry.repoName,
      paths: state.packets[0].paths,
      createdAt: entry.claimedAt,
    }));
  state.reviews = race.entrants
    .filter((entry) => entry.reviewRequestedAt)
    .map((entry) => {
      const fork = state.forks.find((candidate) => candidate.repoName === entry.repoName)!;
      const receipt = fixtureReceipt(
        entry.agent === "amber" || (scenario === "race-advisory" && entry.agent === "cedar")
          ? "failed"
          : "passed",
      );
      receipt.startedAt = entry.reviewRequestedAt!;
      receipt.finishedAt = entry.receiptPassedAt ?? at(600);
      receipt.durationMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt);
      receipt.checks = [
        { name: "brand", tier: "full", outcome: receipt.status, durationMs: 13000 },
      ];
      return {
        id: `race-review-${entry.agent}`,
        packet: race.packet,
        repoName: entry.repoName,
        agent: entry.agent,
        sha: fork.head,
        base: HEAD,
        receiptDigest: receipt.digest,
        receipt,
        approval: entry.approvedAt ? { sha: fork.head, receiptDigest: receipt.digest } : null,
        stale: finished && !entry.promotedAt,
        promoted: !!entry.promotedAt,
        createdAt: entry.reviewRequestedAt!,
      };
    });
  state.activity = race.entrants
    .filter((entry) => entry.firstPushAt)
    .map((entry, index) => ({
      sequence: index + 1,
      namespace: "fixture",
      repoName: entry.repoName,
      agent: entry.agent,
      ref: "refs/heads/main",
      before: HEAD,
      after: state.forks.find((fork) => fork.repoName === entry.repoName)!.head,
      changedPaths: ["src/webhooks/client.ts"],
      eventTimestamp: entry.firstPushAt!,
      recordedAt: entry.firstPushAt!,
    }));
  return state;
}
