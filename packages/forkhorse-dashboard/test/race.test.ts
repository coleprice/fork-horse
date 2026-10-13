import "./dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { installDom } from "./dom.ts";
import { raceFixtureState } from "./race-fixtures.ts";
import { stateView } from "../src/model.ts";
import { RaceView } from "../src/race.tsx";
import {
  entrantResult,
  ordinal,
  photoFinish,
  raceEntrants,
  raceSplit,
  raceStart,
  rejectionDelta,
  saddlecloth,
} from "../src/race-model.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { renderDashboard } from "../src/render.ts";
import type { ProjectState, DashboardTransport } from "../src/contracts.ts";
import type { ViewModel } from "../src/model.ts";
import type { ViewActions } from "../src/view.tsx";
const brand = { name: "Fixture app", tagline: "Fixture" };
const actions: ViewActions = {
  section: "work",
  owner: true,
  openReview() {},
  openRace() {},
  setSection() {},
  async selectProject() {},
  async action() {},
};
function view(scenario = "race-open"): ViewModel {
  const state = stateView(raceFixtureState(scenario));
  return {
    brand,
    project: scenario,
    projects: [],
    fixture: true,
    state,
    activity: state.recentActivity ?? [],
    busy: false,
  };
}
function html(value = view()) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(RaceView, { packet: "race-01", view: value, actions }),
    ),
  );
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected fixture UI did not appear");
};

test("race projection retains exact ledger reference, enrollment time and rejected attempt", () => {
  const state = view("race-photo").state!;
  assert.equal(state.races![0].ledgerEntryId, "ledger-race-1");
  assert.equal(state.ledger[0].id, "ledger-race-1");
  assert.equal(state.ledger[0].before, "a".repeat(40));
  assert.equal(state.races![0].entrants[2].promoteRejected?.found, "c".repeat(40));
  assert.equal(state.agents[0].createdAt, "2026-10-13T14:00:00Z");
});
test("saddlecloth identity follows enrollment and repeats independently of claim and response order", () => {
  const state = view().state!;
  assert.equal(saddlecloth(state, "amber"), 1);
  assert.equal(saddlecloth(state, "birch"), 2);
  assert.equal(saddlecloth(state, "cedar"), 3);
  state.agents.reverse();
  state.agents.push({ name: "alder", createdAt: "2026-10-13T14:05:00Z" });
  assert.equal(saddlecloth(state, "birch"), 2);
  assert.equal(saddlecloth(state, "alder"), 4);
  assert.equal(saddlecloth(state, "missing"), undefined);
});
test("same-time bootstrap enrollment tie-breaks alphabetically and lane order is stable", () => {
  const state = view().state!;
  state.agents = [
    { name: "birch", createdAt: "2026-10-13T14:00:00Z" },
    { name: "amber", createdAt: "2026-10-13T14:00:00Z" },
  ];
  assert.equal(saddlecloth(state, "amber"), 1);
  assert.equal(saddlecloth(state, "birch"), 2);
  const race = state.races![0];
  race.entrants[1].claimedAt = race.entrants[2].claimedAt;
  const before = raceEntrants(race).map((entrant) => entrant.agent);
  race.entrants.reverse();
  assert.deepEqual(
    raceEntrants(race).map((entrant) => entrant.agent),
    before,
  );
});
test("one recorded race clock includes late claims, seconds, hours and supplied milliseconds", () => {
  assert.equal(raceSplit("2026-10-13T14:03:00Z", Date.parse("2026-10-13T14:02:00Z")), "01:00");
  assert.equal(
    raceSplit("2026-10-13T15:06:45.400Z", Date.parse("2026-10-13T14:02:00Z")),
    "1:04:45.4",
  );
  assert.equal(raceSplit(null, 0), "");
  assert.equal(raceSplit("invalid", 0), "");
  assert.equal(rejectionDelta("2026-10-13T14:14:00.400Z", "2026-10-13T14:14:00Z"), "0.4 s after");
  assert.equal(rejectionDelta("2026-10-13T14:14:13Z", "2026-10-13T14:14:00Z"), "13 s after");
  assert.equal(rejectionDelta("2026-10-13T14:13:59Z", "2026-10-13T14:14:00Z"), "");
  assert.deepEqual([1, 2, 3, 11, 12, 13, 21].map(ordinal), [
    "1st",
    "2nd",
    "3rd",
    "11th",
    "12th",
    "13th",
    "21st",
  ]);
});
test("semantic track keeps claim order at finish, checks after request, and real evidence", () => {
  const value = view("race-finished"),
    state = value.state!,
    race = state.races![0];
  assert.deepEqual(
    raceEntrants(race).map((entry) => entry.agent),
    ["birch", "cedar", "amber"],
  );
  race.entrants.find((entry) => entry.agent === "birch")!.claimedAt = "2026-10-13T14:01:59Z";
  const dom = new JSDOM(html(value));
  const track = dom.window.document.querySelector(".race-track")!;
  assert.equal(track.querySelector("caption")!.textContent, "Race progress for race-01");
  assert.deepEqual(
    [...track.querySelectorAll("tbody tr")].map((row) => row.getAttribute("data-race-agent")),
    ["birch", "cedar", "amber"],
  );
  assert.deepEqual(
    [...track.querySelectorAll("thead th")].map((th) => th.textContent),
    [
      "Runner",
      "Claimed",
      "First push",
      "Review requested",
      "Checks passed",
      "Approved",
      "Promoted",
      "Result",
    ],
  );
  assert.match(track.textContent!, /Checks failed, plus/);
  assert.match(track.textContent!, /Promoted to main aaaaaaa → ccccccc/);
  assert.match(track.textContent!, /Closed at the finish/);
  assert.doesNotMatch(html(value), /Photo finish|progressbar|% done/);
  assert.equal(raceStart(race), Date.parse("2026-10-13T14:01:59Z"));
});
test("photo finish requires two recorded approvals before finish; rejected rows require data", () => {
  const value = view("race-photo"),
    race = value.state!.races![0];
  assert.equal(photoFinish(race), 2);
  assert.match(html(value), /2 entrants were approved/);
  assert.match(
    html(value),
    /birch.*tried to promote.*expected.*aaaaaaa.*found.*ccccccc.*0.4 s after/,
  );
  assert.match(html(value), /Main moved/);
  race.entrants.forEach((entry) => (entry.promoteRejected = null));
  assert.doesNotMatch(html(value), /tried to promote|s after/);
  race.entrants.find((entry) => entry.agent === "birch")!.approvedAt = "2026-10-13T14:15:00Z";
  assert.equal(photoFinish(race), 1);
  assert.doesNotMatch(html(value), /Photo finish/);
});
test("failed check details and later retry count come only from the entrant's own receipts", () => {
  const value = view();
  const review = value.state!.reviews.find((candidate) => candidate.agent === "birch")!;
  const failed = structuredClone(review);
  failed.id = "earlier-failed-review";
  failed.requestedAt = "2026-10-13T14:06:00Z";
  failed.receipt!.status = "failed";
  failed.receipt!.checks = [{ name: "brand", tier: "full", outcome: "failed", durationMs: 13000 }];
  value.state!.reviews.push(failed);
  const dom = new JSDOM(html(value));
  const hurdle = dom.window.document.querySelector(
    '[data-race-agent="birch"] .race-hurdle-button',
  )!;
  assert.match(
    hurdle.getAttribute("aria-label")!,
    /brand · failed · 13 s; retried, passed at \+09:00/,
  );
  assert.match(dom.window.document.querySelector(".race-results")!.textContent!, /1 of 2/);
});
test("missing ledger and activity never invent before/after or push counts", () => {
  const value = view("race-photo");
  value.state!.ledger[0].id = "different-entry";
  value.activity = [];
  assert.doesNotMatch(html(value), /aaaaaaa → ccccccc|<th[^>]*>Pushes/);
});
test("advisory approval skips hollow check marker with a connector and remains truthful", () => {
  const value = view("race-advisory");
  const dom = new JSDOM(html(value));
  const lane = dom.window.document.querySelector('[data-race-agent="cedar"]')!;
  assert.match(
    lane.querySelector('[data-milestone="receiptPassedAt"]')!.textContent!,
    /Checks failed/,
  );
  assert.match(
    lane.querySelector('[data-milestone="approvedAt"] .race-connector')!.getAttribute("style")!,
    /--race-gap:2/,
  );
});
test("receipt interruption labels remain distinct recorded events", () => {
  for (const [status, label] of [
    ["timed-out", "Timed out"],
    ["infrastructure-error", "Couldn't run"],
  ] as const) {
    const value = view("race-finished");
    value.state!.reviews.find((candidate) => candidate.agent === "amber")!.receipt!.status = status;
    const dom = new JSDOM(html(value));
    assert.match(
      dom.window.document.querySelector(
        '[data-race-agent="amber"] [data-milestone="receiptPassedAt"]',
      )!.textContent!,
      new RegExp(label),
    );
  }
});
test("closed provenance never labels release or owner close as closed at finish", () => {
  const entrant = view().state!.races![0].entrants[0];
  entrant.closedAt = entrant.claimedAt;
  entrant.closedBy = "release";
  assert.equal(entrantResult(entrant, true), "Left the race");
  entrant.closedBy = "owner";
  assert.equal(entrantResult(entrant, false), "Closed by the owner");
  entrant.closedBy = undefined;
  assert.equal(entrantResult(entrant, true), "Closed");
});
test("empty, loading, error, unknown and standard pages contain no invented lanes", () => {
  assert.match(html(view("race-empty")), /No entrants yet. Agents join by claiming race-01./);
  assert.match(html({ ...view(), state: undefined, busy: true }), /Loading race…/);
  assert.match(
    html({ ...view(), state: undefined, error: "fixture error" }),
    /Couldn&#x27;t load this race.*Try again/,
  );
  assert.match(html(view("race-unknown")), /This race doesn&#x27;t exist anymore./);
  assert.match(html(view("race-standard")), /This packet isn&#x27;t a race./);
});
test("Work and Review badges and Needs you race copy use packet mode", () => {
  const content = renderDashboard(view());
  assert.match(content, /3 entrants/);
  assert.match(content, /Racing/);
  assert.match(content, /First promote wins the race./);
  assert.match(renderDashboard(view("race-photo")), /Won by cedar/);
});
test("race route opens from Work, supports back/opaque history and stays read-only for agents", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#work" });
  installDom(dom.window as unknown as Window & typeof globalThis);
  const state: ProjectState = view().state!;
  const writes: string[] = [];
  const transport: DashboardTransport = {
    async getState() {
      return structuredClone(state);
    },
    async getActivity() {
      return { activity: [], nextAfter: 0 };
    },
    async approve() {
      writes.push("approve");
    },
    async promote() {
      writes.push("promote");
      return { sha: "fixture" };
    },
  };
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const app = mountDashboard(root, {
    brand,
    transport,
    initialProject: state.project.id,
    owner: false,
  });
  try {
    await until(() => !!root.querySelector(".packet-link"));
    const historyLength = dom.window.history.length;
    root.querySelector<HTMLButtonElement>(".packet-link")!.click();
    await until(() => !!root.querySelector(".race-track"));
    assert.equal(dom.window.history.length, historyLength + 1);
    assert.equal(dom.window.location.hash, "#race/race-01");
    await until(() => dom.window.document.activeElement?.id === "race-title");
    assert.equal(root.querySelector("#activity-panel"), null);
    assert.equal(root.querySelector('[data-action="promote"]'), null);
    assert.equal(root.querySelector('[data-action="approve"]'), null);
    assert.deepEqual(writes, []);
    await app.refresh();
    assert.ok(root.querySelector(".race-track"));
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "← Work")!
      .click();
    await until(() => !!root.querySelector("#view-work"));
    assert.equal(dom.window.location.hash, "#work");
    await until(() => dom.window.document.activeElement === root.querySelector(".packet-link"));
    dom.window.history.pushState = () => {
      throw new dom.window.DOMException("Opaque", "SecurityError");
    };
    root.querySelector<HTMLButtonElement>(".packet-link")!.click();
    await until(() => !!root.querySelector(".race-track"));
    assert.equal(dom.window.location.hash, "#race/race-01");
  } finally {
    app.dispose();
    dom.window.close();
  }
});
test("race Promote dialog states the other open entrants before owner confirmation", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#review" });
  installDom(dom.window as unknown as Window & typeof globalThis);
  const state = view().state!;
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const transport: DashboardTransport = {
    async getState() {
      return state;
    },
    async getActivity() {
      return { activity: [], nextAfter: 0 };
    },
    async approve() {},
    async promote() {
      assert.fail("Opening a dialog must never write");
    },
  };
  const app = mountDashboard(root, { brand, transport, initialProject: state.project.id });
  try {
    await until(() => !!root.querySelector('[data-action="promote"]'));
    root.querySelector<HTMLButtonElement>('[data-action="promote"]')!.click();
    await until(() => !!dom.window.document.querySelector(".promotion-dialog"));
    assert.match(
      dom.window.document.querySelector(".promotion-dialog")!.textContent!,
      /Promoting this finishes the race. amber and birch will be closed and placed./,
    );
  } finally {
    app.dispose();
    dom.window.close();
  }
});
