import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";
import { TooltipProvider } from "@cloudflare/kumo";
import { forkGraph, foldMarks } from "../src/fork-graph-model.ts";
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
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>(".fork-lane-label")]
      .find((b) => b.textContent!.includes("fixture-01"))!
      .click(),
  );
  assert.equal(opened[0], "fixture-01");
  assert.match(table.textContent!, /checks failed/);
  assert.match(table.textContent!, /checks passed/);
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
