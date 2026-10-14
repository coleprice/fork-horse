import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { DashboardView, type Section, type ViewActions } from "../src/view.tsx";
import { ForkGraph } from "../src/fork-graph.tsx";
import { RaceView } from "../src/race.tsx";
import { ReceiptCell, receiptWord } from "../src/receipts.tsx";
import { Saddlecloth } from "../src/lane.tsx";
import { CollisionBanner } from "../src/collisions.tsx";
import { blockerPacket, stateView, type ViewModel } from "../src/model.ts";
import { raceSplit, raceStart } from "../src/race-model.ts";
import { fixtureReceipt, fixtureState } from "./fixtures.ts";
import { forkFixtureState } from "./fork-graph-fixtures.ts";
import { raceFixtureState } from "./race-fixtures.ts";
import { computeAccessibleDescription, getAllByRole, getByRole, queryByRole } from "./roles.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture app", tagline: "Offline fixture" };
const actions: ViewActions = {
  section: "overview", owner: true, openReview() {}, setSection() {},
  async selectProject() {}, async action() {},
};
const model = (state = stateView(fixtureState("history-required"))): ViewModel => ({
  brand, project: state.project.id, projects: [], fixture: true, state,
  activity: state.recentActivity ?? [], busy: false,
});
function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
  return new JSDOM(renderToStaticMarkup(element));
}

test("fork controls stay accessible within a named group; decorative legend and hint retain spoken words", () => {
  const now = Date.parse("2026-10-13T16:00:00Z");
  const state = stateView(forkFixtureState("fork-hero", now));
  const dom = markup(createElement(TooltipProvider, null, createElement(ForkGraph, {
    state, brand, owner: true, openReview() {}, openPacket() {}, openReceipt() {}, now,
  })));
  try {
    const root = dom.window.document.body;
    const group = getByRole(root, "group", { name: /^Fork graph: / });
    assert.equal(queryByRole(root, "img", { name: /^Fork graph: / }), null);
    assert.ok(getAllByRole(group, "button", { name: /.+/ }).length > 0);
    assert.ok(getByRole(group, "link", { name: /^Race · / }));
    const buttons = getAllByRole(group, "button", { name: /^Agent number / });
    assert.ok(buttons.length);
    assert.ok(buttons.every((button) => button.title.startsWith("Tokens: ")));
    assert.ok(buttons.some((button) => button.title === "Tokens: not reported"));
    const legend = root.querySelector(".fork-legend")!;
    assert.equal(legend.querySelectorAll('[aria-hidden="true"]').length, 5);
    assert.match(legend.textContent!, /push · .* review requested · .* checks passed\/failed/);
    const hint = root.querySelector(".fork-window")!;
    assert.match(hint.textContent!, /now\. hover a mark for its time/);
    assert.equal(hint.querySelector(".sr-only")!.textContent, ". ");
  } finally { dom.window.close(); }
});

test("each receipt names its packet, exact short head and status, and exposes its caption as description", () => {
  for (const status of ["running", "passed", "failed", "timed-out", "infrastructure-error"] as const) {
    const receipt = fixtureReceipt(status);
    const dom = markup(createElement("div", null,
      createElement(ReceiptCell, { packet: "fixture-01", sha: "a".repeat(40), receipt, required: true, open() {} }),
      createElement(ReceiptCell, { packet: "fixture-02", sha: "b".repeat(40), receipt, required: true, open() {} }),
    ));
    try {
      const root = dom.window.document.body;
      const first = getByRole(root, "button", { name: `View receipt for fixture-01 at aaaaaaa: ${receiptWord(status).label}` });
      const second = getByRole(root, "button", { name: `View receipt for fixture-02 at bbbbbbb: ${receiptWord(status).label}` });
      assert.ok(computeAccessibleDescription(first).length);
      assert.equal(computeAccessibleDescription(first), first.querySelector(".caption")!.textContent!.trim());
      assert.notEqual(first.getAttribute("aria-describedby"), second.getAttribute("aria-describedby"));
      assert.equal(queryByRole(root, "button", { name: `View receipt: ${receiptWord(status).label}` }), null);
      assert.equal(queryByRole(root, "button", { name: /at ccccccc/ }), null);
    } finally { dom.window.close(); }
  }
});

test("collision packet buttons identify the packet they open", () => {
  const blockers = stateView(fixtureState()).blockers;
  const first = blockers[0];
  assert.ok(first);
  const second = { ...first, id: "fixture-collision-2", pushingPacket: "fixture-other" };
  const dom = markup(createElement(TooltipProvider, null, createElement("div", null,
    ...[first, second].map((blocker) => createElement(CollisionBanner, { key: blocker.id, blocker, owner: true, showPacket() {} })),
  )));
  try {
    for (const blocker of [first, second]) {
      assert.ok(getByRole(dom.window.document.body, "button", { name: `View packet ${blockerPacket(blocker)}` }));
    }
    assert.equal(queryByRole(dom.window.document.body, "button", { name: "View packet" }), null);
  } finally { dom.window.close(); }
});

test("summary values leave the heading outline, panels use title case, tabs separate counts and all four tables are named", () => {
  const view = model();
  for (const section of ["overview", "work", "review", "agents"] as Section[]) {
    const dom = markup(createElement(DashboardView, { view, actions: { ...actions, section } }));
    try {
      const root = dom.window.document.body;
      const name = { overview: "Overview", work: "Work", review: "Review", agents: "Agents" }[section];
      assert.ok(getByRole(root, "tabpanel", { name }));
      assert.equal(queryByRole(root, "tabpanel", { name: section }), null);
      assert.ok(getByRole(root, "tab", { name: /^Work\s*,\s+\d+$/ }));
      assert.ok(getByRole(root, "tab", { name: /^Review\s*,\s+\d+$/ }));
      assert.equal(queryByRole(root, "tab", { name: /^Work\d+$/ }), null);
      if (section === "overview") {
        const summary = getByRole(root, "region", { name: "Project summary" });
        assert.equal(summary.querySelectorAll("h3").length, 0);
        assert.equal(summary.querySelectorAll("p.metric-value").length, 4);
        assert.equal(queryByRole(summary, "heading", { name: /^\d+$/ }), null);
        assert.ok(summary.querySelector('.warning-dot[aria-hidden="true"]'));
        assert.match(summary.textContent!, /\d+ open blockers/);
      }
      const tableNames = { overview: [], work: ["Packets and claims"], review: ["Review queue", "Recent receipts"], agents: ["Agents"] }[section];
      for (const tableName of tableNames) {
        assert.ok(getByRole(root, "table", { name: tableName }));
      }
    } finally { dom.window.close(); }
  }
});

test("saddlecloth exposes spoken identity once, including unknown agents; the race flag is decorative", () => {
  for (const number of [1, 12]) {
    const dom = markup(createElement("button", null,
      createElement(Saddlecloth, { identity: { number, silk: 1 } }), " cedar",
    ));
    try {
      const button = getByRole(dom.window.document.body, "button", { name: `Agent number ${number} cedar` });
      assert.equal(queryByRole(dom.window.document.body, "button", { name: `${number} cedar` }), null);
      assert.equal(button.querySelector('[aria-hidden="true"]')!.textContent, String(number));
    } finally { dom.window.close(); }
  }
  const unknown = markup(createElement("button", null, createElement(Saddlecloth), " guest"));
  try { assert.ok(getByRole(unknown.window.document.body, "button", { name: "Agent number unavailable guest" })); }
  finally { unknown.window.close(); }
  const dom = markup(createElement(TooltipProvider, null, createElement(RaceView, {
    packet: "race-01", view: model(stateView(raceFixtureState())), actions,
  })));
  try {
    assert.ok(getByRole(dom.window.document.body, "table", { name: "Race progress for race-01" }));
    assert.equal(dom.window.document.querySelector('.race-flag [aria-hidden="true"]')!.textContent, "⚑");
    assert.match(dom.window.document.querySelector(".race-flag")!.textContent!, /Racing/);
  } finally { dom.window.close(); }
});

test("race status is initially silent, batches new milestones and failure, suppresses repeats, and resets on switches", async () => {
  const dom = new JSDOM('<div id="fixture"></div>', { url: "https://fixture.idiot.tax" });
  installDom(dom.window);
  const container = dom.window.document.getElementById("fixture")!;
  const root = createRoot(container);
  let state = stateView(raceFixtureState());
  // The open fixture's last entrant has not requested review yet. Establish an
  // in-flight receipt before mounting, so the next snapshot tests its failure.
  const initialAmber = state.races![0].entrants.find((entrant) => entrant.agent === "amber")!;
  initialAmber.firstPushAt = "2026-10-13T14:09:00Z";
  initialAmber.reviewRequestedAt = "2026-10-13T14:10:00Z";
  state.reviews.push({ ...structuredClone(state.reviews[0]),
    id: "fixture-amber-review", agent: "amber", repoName: initialAmber.repoName,
    requestedAt: initialAmber.reviewRequestedAt, receipt: fixtureReceipt("running"),
  });
  const render = async (packet = "race-01", project = "fixture-race") => {
    await act(async () => root.render(createElement(TooltipProvider, null,
      createElement(RaceView, { packet, view: { ...model(state), project }, actions }),
    )));
  };
  const status = () => getByRole(container, "status", { name: "" });
  try {
    await render();
    assert.equal(status().getAttribute("aria-live"), "polite");
    assert.equal(status().textContent, "");
    state = structuredClone(state);
    const race = state.races![0];
    const birch = race.entrants.find((entrant) => entrant.agent === "birch")!;
    birch.approvedAt = "2026-10-13T14:13:00Z";
    const amber = race.entrants.find((entrant) => entrant.agent === "amber")!;
    const failedReview = state.reviews.find((review) => review.repoName === amber.repoName)!;
    failedReview.receipt = { ...failedReview.receipt!, status: "failed", finishedAt: "2026-10-13T14:13:05Z" };
    await render();
    const message = status().textContent!;
    assert.equal(message, `birch: Approved, +${raceSplit(birch.approvedAt, raceStart(race))}. amber: Checks failed, +${raceSplit(failedReview.receipt.finishedAt, raceStart(race))}`);
    const failedCell = container.querySelector('[data-race-agent="amber"] [data-milestone="receiptPassedAt"] .sr-only')!;
    assert.match(failedCell.textContent!, /^Checks failed, plus/);
    state = structuredClone(state);
    await render();
    assert.equal(status().textContent, message);
    await render("race-01", "other-project");
    assert.equal(status().textContent, "");
    state = structuredClone(state);
    state.races![0].packet = "race-02";
    await render("race-02", "other-project");
    assert.equal(status().textContent, "");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("race finish announces an observed winner or a winnerless finish, never a historical finish", async () => {
  for (const winner of ["cedar", null]) {
    const dom = new JSDOM('<div id="fixture"></div>', { url: "https://fixture.idiot.tax" });
    installDom(dom.window);
    const container = dom.window.document.getElementById("fixture")!;
    const root = createRoot(container);
    let state = stateView(raceFixtureState());
    const render = async () => { await act(async () => root.render(createElement(TooltipProvider, null,
      createElement(RaceView, { packet: "race-01", view: model(state), actions }),
    ))); };
    try {
      await render();
      state = structuredClone(state);
      const race = state.races![0];
      race.status = "finished";
      race.winner = winner;
      race.finishedAt = "2026-10-13T14:14:00Z";
      await render();
      const expected = winner ? `Race finished. cedar won in ${raceSplit(race.finishedAt, raceStart(race))}.` : "Race finished.";
      assert.equal(getByRole(container, "status", { name: "" }).textContent, expected);
      await act(async () => root.unmount());
      const freshRoot = createRoot(container);
      await act(async () => freshRoot.render(createElement(TooltipProvider, null,
        createElement(RaceView, { packet: "race-01", view: model(state), actions }),
      )));
      assert.equal(getByRole(container, "status", { name: "" }).textContent, "");
      await act(async () => freshRoot.unmount());
    } finally { dom.window.close(); }
  }
});
