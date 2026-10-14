import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { stateView } from "../src/model.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { Races, openRaceCount, orderedRaces } from "../src/races.tsx";
import { racesFixtureState } from "./races-fixtures.ts";
import { getByRole, queryByRole } from "./roles.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture product", tagline: "Fixture races" };
const fixture = () => stateView(racesFixtureState());
const markup = (owner = true, state = fixture()) => new JSDOM(renderToStaticMarkup(
  createElement(TooltipProvider, null, createElement(Races, { state, owner, openRace() {} })),
));

test("FH-081 orders recorded races by open/start then finished/finish, with empty opens last", () => {
  const races = fixture().races!;
  const original = races.map((race) => race.packet);
  assert.deepEqual(orderedRaces(races).map((race) => race.packet), [
    "race-advice", "race-judged", "race-one", "race-three", "race-zero", "race-photo", "race-winner",
  ]);
  assert.deepEqual(races.map((race) => race.packet), original, "sorting never mutates state");
  assert.equal(openRaceCount(races), 4);
  assert.equal(openRaceCount(races.filter((race) => race.status === "finished" || !race.entrants.length)), 0);
});

test("FH-081 table names, lane identities, archived and photo-finish history use existing contracts", () => {
  const dom = markup();
  try {
    const root = dom.window.document.body as HTMLElement;
    const table = getByRole(root, "table", { name: "Races" });
    assert.deepEqual([...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
      ["Race", "Status", "Entrants", "Winner", "Judge's pick", "Started"]);
    const three = table.querySelector('[data-race-packet="race-three"]')!;
    assert.deepEqual([...three.querySelectorAll("td:nth-child(3) .race-list-name")].map((name) => name.textContent),
      ["birch", "cedar", "amber"]);
    assert.deepEqual([...three.querySelectorAll("td:nth-child(3) .race-saddlecloth .sr-only")].map((name) => name.textContent),
      ["Agent number 2", "Agent number 3", "Agent number 1"]);
    const photo = table.querySelector('[data-race-packet="race-photo"]')!;
    assert.match(photo.textContent!, /Archived.*Finished.*photo finish/);
    assert.match(photo.querySelector("td:nth-child(4)")!.textContent!, /cedarwon in 12:00\.0/);
    assert.match(photo.querySelector("td:nth-child(6)")!.textContent!, /Finished 12 min later/);
    assert.ok(photo.querySelector("time[datetime]"));
    const zero = table.querySelector('[data-race-packet="race-zero"]')!;
    assert.match(zero.querySelector("td:nth-child(2)")!.textContent!, /No entrants yet/);
    assert.equal(zero.querySelector("td:nth-child(6)")!.textContent, "—");
    assert.equal(root.querySelectorAll('[aria-live], [role="status"]').length, 0);
  } finally { dom.window.close(); }
});

test("FH-081 advice never becomes a winner and missing winner history stays explicit", () => {
  const state = fixture();
  state.races!.find((race) => race.packet === "race-winner")!.winner = null;
  const dom = markup(true, state);
  try {
    const root = dom.window.document.body as HTMLElement;
    const judged = root.querySelector('[data-race-packet="race-judged"]')!;
    assert.equal(judged.querySelector("td:nth-child(4)")!.textContent, "—");
    assert.match(judged.querySelector("td:nth-child(5)")!.textContent!, /birchJudge fixture-judge/);
    assert.equal(judged.querySelectorAll("td:nth-child(5) .race-saddlecloth").length, 1);
    assert.match(root.querySelector('[data-race-packet="race-advice"] td:nth-child(5)')!.textContent!, /fixture-judge · no advice yet/);
    assert.match(root.querySelector('[data-race-packet="race-winner"] td:nth-child(4)')!.textContent!, /No winner recorded/);
    assert.doesNotMatch(root.textContent!, /verdict/i);
  } finally { dom.window.close(); }
});

test("FH-081 empty owner guidance is copy-only and agent guidance has no command", () => {
  for (const owner of [true, false]) {
    const dom = markup(owner, stateView(racesFixtureState("races-empty")));
    try {
      const root = dom.window.document.body as HTMLElement;
      assert.match(root.textContent!, /Races are started by the owner \(CLI or owner API\)\./);
      assert.match(root.textContent!, /No races yet/);
      assert.match(root.textContent!, /The first approved promote wins\./);
      assert.equal(root.querySelector("table"), null);
      assert.equal(!!root.querySelector(".first-run-copy"), owner);
      if (owner) {
        assert.match(root.textContent!, /Add mode: race to the packet file\./);
        assert.match(root.textContent!, /packet create packet.yaml --config "\$CLI_CONFIG"/);
      } else {
        assert.match(root.textContent!, /The owner starts races\./);
        assert.doesNotMatch(root.textContent!, /CLI_CONFIG/);
      }
      assert.equal(queryByRole(root, "button", { name: /Start a race/i }), null);
    } finally { dom.window.close(); }
  }
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Races fixture DOM did not settle");
}

test("FH-081 last tab is named and read-only for both roles; race navigation returns to its source", async () => {
  for (const owner of [true, false]) {
    const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#races" });
    installDom(dom.window);
    const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
    let wire = racesFixtureState();
    const calls: { path: string; method: string }[] = [];
    const transport = createHttpTransport({ origin: "https://fixture.idiot.tax", fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? "GET" });
      return Response.json(path.endsWith("/state") ? wire : { activity: [], nextAfter: 0 });
    } });
    const app = mountDashboard(root, { brand, transport, initialProject: wire.project.id, owner });
    try {
      await until(() => !!root.querySelector(".table-races"));
      assert.ok(getByRole(root, "tabpanel", { name: "Races" }));
      const tabs = [...root.querySelectorAll('[role="tab"]')];
      assert.equal(tabs.length, 5);
      assert.equal(tabs[3].textContent, "Agents");
      assert.equal(tabs[4], getByRole(root, "tab", { name: /^Races\s*,\s+4$/ }));
      const link = getByRole(root, "link", { name: "Open race Make delivery failures readable" });
      assert.equal(link.getAttribute("href"), "#race/race-one");
      if (!owner) dom.window.history.pushState = () => { throw new Error("Opaque fixture history"); };
      link.click();
      await until(() => !!root.querySelector(".race-page"));
      // Let hashchange run too, including the opaque-frame History API fallback.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(dom.window.location.hash, "#race/race-one");
      getByRole(root, "button", { name: "← Races" }).click();
      await until(() => !root.querySelector(".race-page"));
      assert.equal(dom.window.location.hash, "#races");
      getByRole(root, "tab", { name: /^Work/ }).click();
      root.querySelector<HTMLButtonElement>('[data-packet-id="race-one"] .packet-link')!.click();
      await until(() => !!root.querySelector(".race-page"));
      getByRole(root, "button", { name: "← Work" }).click();
      assert.equal(dom.window.location.hash, "#work");
      getByRole(root, "tab", { name: /^Races/ }).click();
      wire = { ...wire, races: [] };
      await app.refresh();
      assert.ok(getByRole(root, "tab", { name: "Races" }));
      assert.match(root.querySelector("#view-races")!.textContent!, /No races yet/);
      assert.ok(calls.every((call) => call.method === "GET" && /\/(state|activity)$/.test(call.path)));
    } finally {
      app.dispose();
      dom.window.close();
    }
  }
});

test("tab round trips keep exactly one copy of each Overview card (unique sibling keys)", async () => {
  for (const owner of [true, false]) {
    const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#overview" });
    installDom(dom.window);
    const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
    const wire = racesFixtureState();
    const transport = createHttpTransport({ origin: "https://fixture.idiot.tax", fetch: async (input) =>
      Response.json(String(input).endsWith("/state") ? wire : { activity: [], nextAfter: 0 }) });
    const app = mountDashboard(root, { brand, transport, initialProject: wire.project.id, owner, agent: owner ? undefined : "fixture-agent" });
    const cards = () => [".fork-picture", '[aria-labelledby="needs-you-title"]', ".resume-card", ".project-card"]
      .map((selector) => root.querySelectorAll(`#view-overview ${selector}`).length);
    try {
      await until(() => cards()[0] > 0);
      const first = cards();
      for (const tab of [/^Races/, /^Work/, /^Review/, /^Agents/]) {
        getByRole(root, "tab", { name: tab }).click();
        getByRole(root, "tab", { name: "Overview" }).click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(cards(), first, `${owner ? "owner" : "agent"} Overview after ${tab}`);
      }
      assert.equal(first[0], 1);
      assert.equal(first[3], 1);
      assert.ok(first.every((count) => count <= 1), `no Overview card repeats: ${first}`);
    } finally {
      app.dispose();
      dom.window.close();
    }
  }
});
