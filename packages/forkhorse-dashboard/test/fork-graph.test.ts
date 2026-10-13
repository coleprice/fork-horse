import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";
import { TooltipProvider } from "@cloudflare/kumo";
import {
  forkGraph,
  foldMarks,
  collisionLink,
  mainShaLabels,
  clockTime,
  tableEvents,
} from "../src/fork-graph-model.ts";
import { agentIdentities, saddlecloth } from "../src/lane.tsx";
import { ForkGraph } from "../src/fork-graph.tsx";
import { stateView } from "../src/model.ts";
import { forkFixtureState } from "./fork-graph-fixtures.ts";
const now = Date.parse("2026-10-13T16:00:00Z");
const fixture = (id = "fork-hero") => stateView(forkFixtureState(id, now));
test("agent numbers follow enrollment, survive response reordering and repeat silks", () => {
  const agents = [
    { name: "legacy-z", createdAt: null },
    { name: "new-b", createdAt: "2026-10-13T11:00:00Z" },
    { name: "legacy-a" },
    { name: "new-a", createdAt: "2026-10-13T11:00:00Z" },
  ];
  const identities = agentIdentities(agents);
  assert.deepEqual([...identities.keys()], ["legacy-a", "legacy-z", "new-a", "new-b"]);
  assert.deepEqual([...agentIdentities(agents.toReversed())], [...identities]);
  assert.equal(identities.get("new-b")!.silk, identities.get("legacy-a")!.silk);
  assert.equal(saddlecloth({ ...fixture(), agents }, "missing"), undefined);
});
test("ledger times prove merge ends; missing claims use open start without invented claim or approval", () => {
  const state = fixture();
  delete state.reviews.find((r) => r.id === "fixture-review-0")!.approvedAt;
  const graph = forkGraph(state, now);
  const merged = graph.lanes.find((l) => l.promoted)!;
  assert.equal(merged.claimedAt, undefined);
  assert.equal(merged.start, Date.parse(state.recentActivity![0].recordedAt));
  assert.equal(merged.end, Date.parse(state.ledger[0].promotedAt));
  assert.equal(
    merged.events.some((e) => e.kind === "claim"),
    false,
  );
  assert.equal(
    merged.events.some((e) => e.kind === "approved"),
    false,
  );
  assert.deepEqual(
    merged.events.filter((e) => e.kind === "push").map((e) => e.at),
    state
      .recentActivity!.filter((a) => a.repoName === merged.repoName)
      .map((a) => Date.parse(a.recordedAt)),
  );
});
test("race branches only exist with races, remain in claim order and share project identity", () => {
  const state = fixture();
  const graph = forkGraph(state, now);
  const entrants = graph.lanes.filter((l) => l.race);
  assert.equal(entrants.length, 2);
  assert.ok(entrants[0].claimedAt! < entrants[1].claimedAt!);
  assert.equal(
    entrants[0].identity!.number,
    graph.lanes.find((l) => !l.race && l.agent === entrants[0].agent)!.identity!.number,
  );
  delete state.races;
  assert.equal(forkGraph(state, now).races, 0);
});
test("window is bounded, old lanes retain true claim time and ended lanes expire", () => {
  const state = fixture("fork-old");
  const graph = forkGraph(state, now, "four");
  assert.ok(graph.lanes.some((l) => l.claimedAt! < graph.start));
  state.claims[0].createdAt = "2020-01-01T00:00:00Z";
  assert.ok(now - forkGraph(state, now).start <= 24 * 3600000);
  state.ledger[0].promotedAt = new Date(now - 25 * 3600000).toISOString();
  assert.equal(
    forkGraph(state, now, "day").lanes.some((l) => l.promoted),
    false,
  );
});
test("folding at measured width preserves every event and prioritizes checks over approval/review/push", () => {
  const lane = forkGraph(fixture("fork-dense"), now, "four").lanes.find(
    (l) => l.packet === "fixture-02",
  )!;
  const folded = foldMarks(lane.events, now - 4 * 3600000, now, 450);
  const cluster = folded.find((g) => g.events.length >= 3)!;
  assert.ok(cluster);
  assert.equal(cluster.event.kind, "passed");
  assert.ok(cluster.events.some((e) => e.kind === "push"));
  assert.ok(cluster.events.some((e) => e.kind === "approved"));
  assert.equal(folded.flatMap((g) => g.events).length, lane.events.length);
});
test("main SHA labels favor the newest mark and pack older labels only in remaining space", () => {
  const marks = [
    { id: "older", at: 1, x: 110 },
    { id: "middle", at: 2, x: 185 },
    { id: "newest", at: 3, x: 195 },
  ];
  assert.deepEqual([...mainShaLabels(marks, 300).keys()], ["newest", "older"]);
  assert.equal(mainShaLabels([{ id: "edge", at: 4, x: 290 }], 300).get("edge"), 210);
  assert.deepEqual([...mainShaLabels(marks.toReversed(), 300)], [...mainShaLabels(marks, 300)]);
  assert.equal(mainShaLabels(marks, 90).size, 0);
});
test("table cells cap all event kinds to their latest three and retain earlier facts", () => {
  const events = forkGraph(fixture("fork-history"), now).lanes.find(
    (l) => l.packet === "fixture-02",
  )!.events;
  for (const kinds of [["push"], ["review"], ["passed", "failed"], ["approved"]]) {
    const matching = events.filter((event) => kinds.includes(event.kind));
    const { shown, earlier } = tableEvents(events.toReversed(), kinds);
    assert.equal(shown.length, 3);
    assert.ok(earlier.length > 0);
    assert.deepEqual([...earlier, ...shown], matching);
  }
});
test("collision rings sit beside the pushing lane and links break around unrelated lanes", () => {
  assert.deepEqual(collisionLink(80, 208, [80, 144, 208]), {
    ringY: 112,
    segments: [
      { top: 80, height: 56 },
      { top: 152, height: 56 },
    ],
  });
  assert.deepEqual(collisionLink(208, 80, [80, 144, 208]), {
    ringY: 176,
    segments: [
      { top: 80, height: 56 },
      { top: 152, height: 56 },
    ],
  });
  assert.deepEqual(collisionLink(80, 144, [80, 144]), {
    ringY: 112,
    segments: [{ top: 80, height: 64 }],
  });
  const grouped = collisionLink(80, 238, [80, 174, 238]);
  assert.equal(grouped.ringY, 112);
  assert.ok(grouped.segments.every((s) => s.top + s.height <= 166 || s.top >= 182));
});
test("near-start hour grid stays while its clipped centered label is omitted", async () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.idiot.tax" });
  installDom(dom.window);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  // Fixture geometry only; the browser capture verifies actual text bounds.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const bounds = originalBounds.call(this);
    return this.classList.contains("fork-plot") ? { ...bounds, width: 640 } : bounds;
  };
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state: fixture("fork-hour-edge"),
          owner: false,
          openReview: () => {},
          openPacket: () => {},
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  const grid = [...document.querySelectorAll(".fork-grid")];
  const labels = [...document.querySelectorAll<HTMLElement>(".fork-tick")];
  assert.equal(grid.length, 4);
  assert.ok(parseFloat(grid[0].getAttribute("x1")!) < 4, "Near-start grid line is retained");
  assert.equal(labels.length, 3);
  assert.ok(!labels.some((label) => label.textContent === clockTime(now - 4 * 3600000)));
  assert.ok(
    labels.every((label) => {
      const center = (parseFloat(label.style.left) * 640) / 100;
      return center >= 24 && center <= 640 - 24;
    }),
  );
  await act(async () => root.unmount());
});
test("lane state labels and dots distinguish failed checks, warnings and review", async () => {
  const state = fixture("fork-states");
  const expected = [
    ["Promoted to main", "success"],
    ["Approved", "success"],
    ["Checks running", "info"],
    ["Checks failed", "danger"],
    ["Timed out", "warning"],
    ["Couldn't run", "warning"],
    ["In review", "info"],
    ["Racing", "brand"],
  ];
  const states = forkGraph(state, now).lanes.map((lane) => lane.state);
  for (const [word] of expected) assert.ok(states.includes(word), word);
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.idiot.tax" });
  installDom(dom.window);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state,
          owner: false,
          openReview: () => {},
          openPacket: () => {},
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  for (const [word, tone] of expected) {
    const labels = [...document.querySelectorAll(".fork-state")].filter(
      (label) => label.textContent!.trim() === `● ${word}`,
    );
    assert.ok(labels.length, word);
    assert.ok(
      labels.every((label) => label.classList.contains(`fork-state-${tone}`)),
      `${word}: ${tone}`,
    );
  }
  await act(async () => root.unmount());
});
test("a claimed lane without a review shows an In progress brand dot", async () => {
  const state = fixture("fork-in-progress");
  const lane = forkGraph(state, now).lanes.find((entry) => entry.packet === "fixture-02")!;
  assert.equal(lane.state, "In progress");
  assert.equal(lane.review, undefined);
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.idiot.tax" });
  installDom(dom.window);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state,
          owner: false,
          openReview: () => {},
          openPacket: () => {},
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  const label = [...document.querySelectorAll(".fork-state")].find(
    (entry) => entry.textContent!.trim() === "● In progress",
  )!;
  assert.ok(label);
  assert.ok(label.classList.contains("fork-state-brand"));
  const racing = [...document.querySelectorAll(".fork-state")].filter(
    (entry) => entry.textContent!.trim() === "● Racing",
  );
  assert.ok(racing.length);
  assert.ok(racing.every((entry) => entry.classList.contains("fork-state-brand")));
  await act(async () => root.unmount());
});
test("fixture DOM leaves closed table in accessibility tree, supports navigation and storage denial", async () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.idiot.tax" });
  installDom(dom.window);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw Error("Denied");
    },
    configurable: true,
  });
  const opened: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state: fixture(),
          owner: false,
          openReview: () => {},
          openPacket: (id) => opened.push(id),
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  const unknownStart = document.querySelector<HTMLButtonElement>("button.fork-start")!;
  assert.equal(unknownStart.textContent, "Fork start");
  assert.equal(document.querySelectorAll(".fork-lead-in").length, 1);
  assert.equal(unknownStart.getAttribute("aria-label"), "Started before the loaded history");
  for (const [word, tone] of [
    ["Approved", "success"],
    ["Checks running", "info"],
    ["Racing", "brand"],
  ]) {
    const labels = [...document.querySelectorAll(".fork-state")].filter((el) =>
      el.textContent!.includes(word),
    );
    assert.ok(labels.length);
    assert.ok(labels.every((el) => el.classList.contains(`fork-state-${tone}`)));
  }
  const chips = [...document.querySelectorAll<HTMLButtonElement>(".fork-window-chip")];
  assert.deepEqual(
    chips.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent),
    ["Recent"],
  );
  await act(async () => chips.find((b) => b.textContent === "Last 4 h")!.click());
  assert.deepEqual(
    chips.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent),
    ["Last 4 h"],
  );
  const image = document.querySelector('[role="img"]')!;
  const table = document.getElementById(image.getAttribute("aria-describedby")!)!;
  assert.match(
    image.getAttribute("aria-label")!,
    /Fork graph: 4 live claims · 1 race · 1 promotion today/,
  );
  assert.ok(table.querySelector("table"));
  assert.equal(table.getAttribute("hidden"), null);
  assert.equal(table.getAttribute("aria-hidden"), null);
  const disclosure = document.querySelector<HTMLButtonElement>(".fork-disclosure")!;
  assert.equal(getComputedStyle(table).position, "absolute");
  assert.equal(getComputedStyle(table).width, "1px");
  assert.equal(getComputedStyle(table).clipPath, "inset(50%)");
  assert.ok([...table.querySelectorAll("button")].every((button) => button.tabIndex === -1));
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.equal(table.style.clipPath, "");
  assert.ok([...table.querySelectorAll("button")].every((button) => button.tabIndex === 0));
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>(".fork-lane-label")]
      .find((b) => b.textContent!.includes("fixture-01"))!
      .click(),
  );
  assert.equal(opened[0], "fixture-01");
  assert.match(table.textContent!, /checks failed/);
  assert.match(table.textContent!, /checks passed/);
  const runningRow = [...table.querySelectorAll("tbody tr")].find((row) =>
    row.textContent!.includes("fixture-03"),
  )!;
  assert.equal(
    runningRow.querySelectorAll("td")[4].querySelector(".fork-cell-visible")!.textContent!.trim(),
    "Running",
  );
  const checkedRow = [...table.querySelectorAll("tbody tr")].find((row) =>
    row.textContent!.includes("fixture-02"),
  )!;
  assert.match(
    checkedRow.querySelectorAll("td")[4].querySelector(".fork-cell-visible")!.textContent!,
    /failed.*passed/,
  );
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state: fixture("fork-old"),
          owner: false,
          openReview: () => {},
          openPacket: () => {},
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  const oldHistory = [...document.querySelectorAll(".fork-history")].filter((el) =>
    el.textContent!.includes("since"),
  );
  assert.ok(oldHistory.length);
  for (const history of oldHistory) {
    assert.match(history.querySelector(".fork-stub")!.textContent!, /^since \d{2}:\d{2}$/);
    assert.equal(
      history.querySelector(".fork-stub")!.nextElementSibling!.textContent,
      "Earlier pushes not shown",
    );
  }
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ForkGraph, {
          state: fixture("fork-history"),
          owner: false,
          openReview: () => {},
          openPacket: () => {},
          openReceipt: () => {},
          now,
        }),
      ),
    ),
  );
  const capped = [...document.querySelectorAll(".fork-earlier-events")];
  assert.ok(capped.length >= 4);
  for (const hint of capped) {
    assert.match(hint.textContent!, /\+\d+ earlier/);
    const visible = hint.parentElement!.querySelector(".fork-cell-visible")!.textContent!;
    assert.equal((visible.match(/\d{2}:\d{2}/g) ?? []).length, 3);
    assert.doesNotMatch(visible, /push|review requested|approved|checks/);
    assert.match(hint.getAttribute("aria-label")!, /earlier events:/);
    assert.ok(hint.parentElement!.querySelector(".sr-only")!.textContent);
    assert.equal((hint as HTMLElement).tabIndex, 0);
  }
  // The no-layout DOM shim cannot measure SHA-label space; real-bundle captures check geometry.
  await act(async () => root.unmount());
  dom.window.close();
});

test("a reclaimed fork does not inherit its earlier promotion or reviews", () => {
  const state = fixture();
  state.claims.push({
    agent: "fixture-alpha",
    packet: "fixture-01",
    repoName: "fixture-fork-1",
    active: true,
    paths: [],
    createdAt: new Date(now - 10 * 60000).toISOString(),
  });
  const graph = forkGraph(state, now);
  const same = graph.lanes.filter((l) => l.packet === "fixture-01");
  assert.equal(same.length, 2);
  assert.equal(same.filter((l) => !l.end).length, 1);
  const current = same.find((l) => !l.end)!;
  assert.equal(current.review, undefined);
  assert.equal(current.events.filter((e) => e.kind !== "claim").length, 0);
});
test("race promotion remains recorded without a loaded ledger and never invents a merge SHA", () => {
  const state = fixture();
  const entrant = state.races![0].entrants[0];
  entrant.promotedAt = new Date(now - 5 * 60000).toISOString();
  const lane = forkGraph(state, now).lanes.find((l) => l.race && l.agent === entrant.agent)!;
  assert.equal(lane.end, Date.parse(entrant.promotedAt));
  assert.equal(lane.promoted, undefined);
  assert.ok(lane.events.some((e) => e.kind === "promoted"));
  assert.equal(lane.state, "Promoted to main");
});
