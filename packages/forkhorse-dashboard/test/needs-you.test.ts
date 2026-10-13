import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { stateView } from "../src/model.ts";
import { ownerNeeds, copyText } from "../src/needs-you-model.ts";
import { createHttpTransport } from "../src/transport.ts";
import { needsFixtureState } from "./needs-you-fixtures.ts";
import { fixtureReceipt } from "./fixtures.ts";

const brand = { name: "Fixture product", tagline: "Offline" };
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const now = Date.parse("2026-10-13T12:10:00Z");
const kinds = ["promotionPending", "reconciler", "blocker", "failed", "promote", "approve"];
const needs = (id = "needs-all") => ownerNeeds(stateView(needsFixtureState(id)), brand, now);

test("six public state kinds retain evidence and exact priority without duplicating pending promotion", () => {
  const wire = needsFixtureState("needs-all");
  const state = stateView(wire);
  assert.deepEqual(state.promotionPending, wire.promotionPending);
  assert.equal(state.reconcilerAlerts.length, 1);
  assert.equal(state.reconcilerAlerts[0].ref, "refs/heads/main");
  const items = ownerNeeds(state, brand, now);
  assert.deepEqual(
    items.map((item) => item.kind),
    kinds,
  );
  assert.match(copyText(items[0].why), /Fixture product started moving main aaaaaaa → bbbbbbb/);
  assert.match(
    copyText(items[2].why),
    /fixture-reviewer pushed bbbbbbb to src\/claims.ts \+1, which fixture-builder has claimed/,
  );
  assert.equal(copyText(items[3].why), "1 of 3 checks failed · brand (13 s)");
  assert.equal(copyText(items[4].outcome), "main moves aaaaaaa → ddddddd. Checks run again first.");
  assert.equal(copyText(items[5].why), "Requested 10 min ago · Checks passed");
  assert.equal(needs("needs-empty").length, 0);
});

test("oldest first uses durable receive sequence and review request time, independent of lexical wire order", () => {
  const state = stateView(needsFixtureState("needs-all"));
  const alert = state.reconcilerAlerts[0];
  state.reconcilerAlerts = [
    { ...alert, id: "10" },
    { ...alert, id: "2" },
  ];
  const blocker = state.blockers[0];
  state.blockers = [
    { ...blocker, id: "10-p" },
    { ...blocker, id: "2-p" },
  ];
  const review = state.reviews.at(-1)!;
  state.reviews.push({ ...review, id: "earlier", requestedAt: "2026-10-12T12:00:00Z" });
  const items = ownerNeeds(state, brand, now);
  assert.deepEqual(
    items.filter((i) => i.kind === "reconciler").map((i) => i.id),
    ["alert:2", "alert:10"],
  );
  assert.deepEqual(
    items.filter((i) => i.kind === "blocker").map((i) => i.id),
    ["blocker:2-p", "blocker:10-p"],
  );
  assert.deepEqual(
    items.filter((i) => i.kind === "approve").map((i) => i.id),
    ["approve:earlier", `approve:${review.id}`],
  );
});

test("stale, moved, returned, promoted and blocked reviews never claim readiness", () => {
  for (const mode of [
    "stale",
    "moved",
    "returned",
    "promoted",
    "blocked",
    "missing-settings",
  ] as const) {
    const state = stateView(needsFixtureState("needs-approve"));
    const review = state.reviews[0];
    if (mode === "stale") review.status = "stale";
    if (mode === "moved") state.forks[0].head = "9".repeat(40);
    if (mode === "returned") review.returned = { reason: "Fix it", at: "2026-10-13T12:00:00Z" };
    if (mode === "promoted") review.status = "promoted";
    if (mode === "blocked")
      state.blockers.push({
        id: "1-p",
        packet: review.packet,
        agent: "other",
        paths: [],
        reason: "Collision",
        resolved: false,
      });
    if (mode === "missing-settings") delete state.project.settings;
    assert.ok(
      !ownerNeeds(state, brand).some((i) => i.kind === "approve" || i.kind === "promote"),
      mode,
    );
    review.receipt = fixtureReceipt("failed");
    if (["stale", "moved", "returned", "promoted"].includes(mode))
      assert.equal(ownerNeeds(state, brand).length, 0, mode);
  }
});

test("required interrupted checks get one evidence row, advisory failures stay ready to review", () => {
  for (const status of ["failed", "timed-out", "infrastructure-error"] as const) {
    const state = stateView(needsFixtureState("needs-promote"));
    state.reviews[0].receipt = fixtureReceipt(status, "before-promote");
    const items = ownerNeeds(state, brand);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["failed"],
    );
    assert.match(
      copyText(items[0].outcome),
      status === "failed" ? /pushes a fix/ : /Promote or a new push/,
    );
  }
  assert.deepEqual(
    needs("needs-advisory").map((i) => i.kind),
    ["approve"],
  );
  assert.match(copyText(needs("needs-advisory")[0].why), /Checks advisory/);
  const state = stateView(needsFixtureState("needs-failed"));
  state.reviews[0].receipt!.checks = [state.reviews[0].receipt!.checks[0]];
  assert.match(copyText(ownerNeeds(state, brand)[0].why), /^1 of 1 check failed/);
});

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Needs you DOM did not settle");
}
function setup(id = "needs-all", owner = true, detail = true) {
  const dom = new JSDOM('<div id="dashboard"></div>', {
    url: "https://fixture.idiot.tax/#overview",
  });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const wire = needsFixtureState(id);
  const calls: { method: string; path: string }[] = [];
  const transport = createHttpTransport({
    origin: "https://fixture.idiot.tax",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ method: init?.method ?? "GET", path });
      if (path.endsWith("/state")) return Response.json(wire);
      if (path.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
      return Response.json(
        { error: "Synthetic detail intentionally unavailable" },
        { status: 404 },
      );
    },
  });
  if (!detail) delete transport.getReview;
  let invalidate: (() => void) | undefined;
  transport.subscribe = (_project, listener) => {
    invalidate = listener;
    return () => {};
  };
  const app = mountDashboard(root, { brand, fixture: true, owner, initialProject: id, transport });
  return {
    dom,
    root,
    wire,
    calls,
    app,
    invalidate: () => invalidate?.(),
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}

test("owner section is above project, semantic, limited to five, expandable and contains only evidence controls", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector(".needs-you-card"));
    const card = c.root.querySelector(".needs-you-card")!;
    assert.equal(card.parentElement!.getAttribute("aria-labelledby"), "needs-you-title");
    assert.equal(card.parentElement!.nextElementSibling!.classList.contains("project-card"), true);
    assert.equal(card.querySelectorAll("ul > li").length, 5);
    assert.equal(
      card.querySelectorAll('[data-action="approve"], [data-action="promote"]').length,
      0,
    );
    const expand = [...card.querySelectorAll("button")].find(
      (b) => b.textContent === "Show all 6",
    )!;
    expand.click();
    await until(() => card.querySelectorAll("ul > li").length === 6);
    for (const row of card.querySelectorAll(".needs-you-row")) {
      assert.match(row.getAttribute("aria-label")!, /\./);
      assert.equal(row.querySelectorAll('svg[aria-hidden="true"]').length, 2);
    }
    (card.querySelector('[data-need="approve"] button') as HTMLButtonElement).click();
    await until(() => c.dom.window.location.hash.includes("#review/"));
    assert.ok(c.calls.every((call) => call.method === "GET"));
  } finally {
    c.close();
  }
});

test("queue-only host routes card to review queue without a dead detail hash", async () => {
  const c = setup("needs-approve", true, false);
  try {
    await until(() => !!c.root.querySelector(".needs-you-row"));
    (c.root.querySelector(".needs-you-row") as HTMLButtonElement).click();
    assert.equal(c.dom.window.location.hash, "#review");
    assert.equal(c.root.querySelector("#view-review")!.hasAttribute("hidden"), false);
    assert.ok(c.calls.every((call) => call.method === "GET"));
  } finally {
    c.close();
  }
});

test("collision opens Work details and reconciler routes to the matching agent row with focus", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector(".needs-you-row"));
    (c.root.querySelector('[data-need="blocker"] button') as HTMLButtonElement).click();
    assert.equal(c.dom.window.location.hash, "#work");
    await until(
      () => !!c.root.querySelector("#activity-panel")?.textContent?.includes("Collision evidence"),
    );
    (c.root.querySelector('[data-need="reconciler"] button') as HTMLButtonElement).click();
    await until(
      () =>
        c.dom.window.document.activeElement?.getAttribute("data-agent-repo") ===
        "fixture-project--external",
    );
    assert.equal(c.dom.window.location.hash, "#agents");
  } finally {
    c.close();
  }
});

test("live invalidation removes resolved work to persistent empty card; agents have no card or shell", async () => {
  const c = setup("needs-approve");
  try {
    await until(() => !!c.root.querySelector(".needs-you-row"));
    c.wire.reviews[0].returned = { reason: "Fixture fix", at: "2026-10-13T12:00:00Z" };
    c.invalidate();
    await until(() => !!c.root.querySelector(".needs-you-empty"));
    assert.equal(
      c.root.querySelector(".needs-you-empty")!.textContent,
      "Nothing needs you right now.",
    );
    assert.equal(c.root.querySelectorAll(".needs-you-row").length, 0);
  } finally {
    c.close();
  }
  const agent = setup("needs-all", false);
  try {
    await until(() => !!agent.root.querySelector(".project-card"));
    assert.equal(agent.root.querySelector('[aria-labelledby="needs-you-title"]'), null);
  } finally {
    agent.close();
  }
});
