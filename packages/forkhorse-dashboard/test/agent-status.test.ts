import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { createRequire } from "node:module";
import { installDom } from "./dom.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { agentStatusRows } from "../src/agent-status-model.ts";
import { AgentStatusTable, ResumeCard } from "../src/agent-status.tsx";
import { stateView } from "../src/model.ts";
import { AGENT_STATUS_NOW as now, agentStatusFixtureState } from "./agent-status-fixtures.ts";

const fixture = (id = "agents-status") => stateView(agentStatusFixtureState(id, now));
const rows = (id = "agents-status") => agentStatusRows(fixture(id), undefined, now);
const brand = { name: "Fixture product", tagline: "Fixture collaboration" };
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};
const markup = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, element));

test("FH-078 first-match statuses use existing words and urgency", () => {
  assert.deepEqual(rows().map((row) => row.status?.label ?? "Idle"), [
    "Idle", "Blocked", "Returned", "Checks failed", "Timed out", "Couldn't run", "Checks running", "In review", "Approved", "In progress", "Racing", "Claimed, no recent push", "Claimed, no recent push", "Idle",
  ]);
  const state = fixture();
  const blocked = state.claims[0];
  state.claims.push({ ...blocked, packet: "fixture-second", agent: "fixture-agent", repoName: "fixture--fixture-agent" });
  state.blockers[0].pushingPacket = "fixture-second";
  state.blockers[0].repoName = "fixture--fixture-agent";
  const row = agentStatusRows(state, undefined, now).find((entry) => entry.agent.name === "fixture-agent")!;
  assert.equal(row.status?.label, "Blocked");
  assert.equal(row.claims.length, 2);
  assert.deepEqual(agentStatusRows(state, undefined, now).map((entry) => entry.identity?.number), rows().map((entry) => entry.identity?.number));
});

test("FH-078 held claims need 30 minutes of loaded activity before a quiet label", () => {
  const held = rows().find((row) => row.agent.name === "held")!;
  assert.equal(held.status?.label, "Claimed, no recent push");
  assert.equal(held.status?.quietSince, now - 45 * 60_000);
  const short = rows("agents-short-activity").find((row) => row.agent.name === "held")!;
  assert.equal(short.status?.label, "In progress");
  assert.equal(short.lastPush, undefined);
  assert.equal(short.missingPush, "Not in loaded activity");
  assert.equal(rows().find((row) => row.agent.name === "new")?.missingPush, "No push yet");
});

test("FH-078 a collision blocks the pushing fork, not the claimant's packet", () => {
  const state = fixture();
  state.blockers[0].packet = "fixture-agent";
  const derived = agentStatusRows(state, undefined, now);
  assert.equal(derived.find((row) => row.agent.name === "blocked")?.status?.label, "Blocked");
  assert.equal(derived.find((row) => row.agent.name === "fixture-agent")?.status?.label, "In progress");
  state.blockers[0].pushingPacket = null;
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "blocked")?.status?.label, "Blocked");
});

test("FH-078 old reviews and unrelated pushes do not impersonate current work", () => {
  const state = fixture();
  const review = state.reviews.find((entry) => entry.agent === "returned")!;
  const push = state.recentActivity!.find((entry) => entry.agent === "returned")!;
  push.recordedAt = new Date(now - 60_000).toISOString();
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "returned")?.status?.label, "In progress");
  push.repoName = "unrelated-fork";
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "returned")?.status?.label, "Returned");
  review.requestedAt = new Date(now - 100 * 60_000).toISOString();
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "returned")?.status?.label, "Claimed, no recent push");
});

test("FH-078 missing receipt settings do not imply checks are optional; approvals must be current", () => {
  const state = fixture();
  state.reviews.find((entry) => entry.agent === "review")!.receipt = null;
  delete state.project.settings;
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "review")?.status?.label, "In progress");
  state.project.settings = { requireReceipt: false };
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "review")?.status?.label, "In review");
  state.forks.find((entry) => entry.agent === "approved")!.head = "9".repeat(40);
  assert.equal(agentStatusRows(state, undefined, now).find((row) => row.agent.name === "approved")?.status?.label, "In progress");
});

test("FH-078 table collapses idle identities, keeps legacy live claims and changes owner copy", () => {
  const state = fixture();
  const props = { state, activity: state.recentActivity!, brand, openPacket() {} };
  const owner = markup(createElement(AgentStatusTable, { ...props, owner: true }));
  assert.match(owner, /Idle agents \(2\)/);
  assert.doesNotMatch(owner, /data-agent="legacy"/);
  assert.match(owner, /Resolve the collision/);
  const agent = markup(createElement(AgentStatusTable, { ...props, owner: false }));
  assert.match(agent, /the owner/);
  assert.doesNotMatch(agent, /Resolve the collision|>Promote</);
  state.agents.find((entry) => entry.name === "held")!.createdAt = null;
  assert.match(markup(createElement(AgentStatusTable, { ...props, owner: true })), /Legacy/);
});

test("FH-078 reduced Resume card is read-only, absent for unknown callers and has no Next row", () => {
  const state = fixture();
  const props = { state, activity: state.recentActivity! };
  assert.equal(markup(createElement(ResumeCard, props)), "");
  assert.equal(markup(createElement(ResumeCard, { ...props, agent: "unknown" })), "");
  const card = markup(createElement(ResumeCard, { ...props, agent: "fixture-agent" }));
  assert.match(card, /Resume where you left off/);
  assert.match(card, /fixture--fixture-agent/);
  assert.match(card, /<dt>Packet<\/dt>|<dt>Last push<\/dt>|<dt>Status<\/dt>/);
  assert.doesNotMatch(card, /<button|<dt>Next<\/dt>|unavailable/);
  const idle = fixture("agent-idle");
  assert.match(markup(createElement(ResumeCard, { state: idle, activity: idle.recentActivity!, agent: "fixture-agent" })), /No live claim\./);
  const incomplete = fixture("agents-short-activity");
  assert.match(markup(createElement(ResumeCard, { state: incomplete, activity: incomplete.recentActivity!, agent: "held" })), /Not in loaded activity/);
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Agent status DOM did not settle");
}

test("FH-078 idle disclosure expands by keyboard-capable button and closes", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#agents" });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")!;
  const wire = agentStatusFixtureState();
  const calls: string[] = [];
  const transport = createHttpTransport({ origin: "https://fixture.idiot.tax", fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    return Response.json(path.endsWith("/state") ? wire : { activity: [], nextAfter: 0 });
  } });
  const app = mountDashboard(root, { brand, transport, initialProject: wire.project.id });
  try {
    await until(() => !!root.querySelector('[aria-controls="idle-agents"]'));
    const disclosure = root.querySelector<HTMLButtonElement>('[aria-controls="idle-agents"]')!;
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    assert.equal(root.querySelector('[data-agent="legacy"]'), null);
    disclosure.click();
    await until(() => !!root.querySelector('[data-agent="legacy"]'));
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.match(root.querySelector('[data-agent="legacy"]')!.textContent!, /Idle.*Legacy|Legacy.*Idle/);
    disclosure.click();
    await until(() => !root.querySelector('[data-agent="legacy"]'));
    assert.ok(calls.every((path) => /\/(state|activity)$/.test(path)));
  } finally {
    app.dispose();
    dom.window.close();
  }
});

test("FH-078 Resume is first in the agent Overview and absent for owner or unknown caller", async () => {
  for (const [owner, agent, expected] of [[false, "fixture-agent", true], [false, undefined, false], [true, "fixture-agent", false]] as const) {
    const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#overview" });
    installDom(dom.window);
    const root = dom.window.document.getElementById("dashboard")!;
    const wire = agentStatusFixtureState();
    const transport = createHttpTransport({ origin: "https://fixture.idiot.tax", fetch: async (input) =>
      Response.json(String(input).endsWith("/state") ? wire : { activity: [], nextAfter: 0 }) });
    const app = mountDashboard(root, { brand, transport, initialProject: wire.project.id, owner, agent });
    try {
      await until(() => !!root.querySelector("#view-overview"));
      assert.equal(!!root.querySelector(".resume-card"), expected);
      if (expected) assert.ok(root.querySelector("#view-overview")!.firstElementChild?.classList.contains("resume-card"));
      assert.equal(root.querySelector(".resume-card button"), null);
    } finally {
      app.dispose();
      dom.window.close();
    }
  }
});
