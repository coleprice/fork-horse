import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { reviewFixtureState, reviewFixtureDetail } from "./review-fixtures.ts";
import { collisionFixtureState } from "./collision-fixtures.ts";
import { judgeFixtureState, judgeFixtureDetail } from "./judge-fixtures.ts";
import type { StateResponse } from "../src/contracts.ts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://fixture.idiot.tax";
const diagnosticId = "11111111-2222-4333-8444-555555555555";

async function until(check: () => unknown) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Freshness fixture did not settle");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(wire: StateResponse, route = "review", owner = true) {
  const dom = new JSDOM('<div id="app"></div>', { url: `${origin}/#${route}` });
  installDom(dom.window);
  const root = dom.window.document.getElementById("app")! as HTMLElement;
  const calls: { path: string; method: string }[] = [];
  let stateRead: (() => Promise<Response>) | undefined;
  let activityRead: (() => Promise<Response>) | undefined;
  let detailRead: (() => Promise<Response>) | undefined;
  const transport = createHttpTransport({ origin, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.endsWith("/state")) return stateRead ? stateRead() : Response.json(wire);
    if (path.endsWith("/activity")) return activityRead ? activityRead() : Response.json({ activity: wire.activity, nextAfter: 0 });
    if (init?.method === "POST" || init?.method === "PATCH") return Response.json({});
    const id = path.split("/").at(-1)!;
    return detailRead ? detailRead() : Response.json(judgeFixtureDetail(wire, id));
  }});
  const app = mountDashboard(root, { transport, brand: { name: "Fixture product", tagline: "Fixture" },
    fixture: true, owner, agent: "fixture-agent", initialProject: wire.project.id });
  return { dom, root, wire, calls, app,
    state(fn?: () => Promise<Response>) { stateRead = fn; },
    activity(fn?: () => Promise<Response>) { activityRead = fn; },
    detail(fn?: () => Promise<Response>) { detailRead = fn; },
    close() { app.dispose(); dom.window.close(); },
  };
}
const stamp = (c: ReturnType<typeof setup>) => c.root.querySelector<HTMLElement>('[data-freshness="stamp"]')!;
const control = (c: ReturnType<typeof setup>, selector: string) => c.dom.window.document.querySelector<HTMLButtonElement>(selector)!;
const writes = (c: ReturnType<typeof setup>) => c.calls.filter((call) => ["POST", "PATCH"].includes(call.method));
async function failRefresh(c: ReturnType<typeof setup>) {
  c.state(async () => Response.json({ error: "PRIVATE RAW STATE FAILURE" }, { status: 502 }));
  await c.app.refresh();
  assert.match(stamp(c).textContent!, /Couldn't refresh\. Last updated/);
  assert.ok(stamp(c).querySelector("time")?.dateTime);
  assert.doesNotMatch(c.root.textContent!, /PRIVATE RAW/);
}
function tryAgain(c: ReturnType<typeof setup>) {
  return [...stamp(c).querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
}

test("in-flight refresh retains DOM, focus and enabled owner actions; failed activity fences cached data until retry", async () => {
  const c = setup(reviewFixtureState("review-current"));
  try {
    await until(() => control(c, '[data-action="approve"]'));
    const approve = control(c, '[data-action="approve"]');
    approve.focus();
    const table = c.root.querySelector("#reviews");
    const updatedAt = stamp(c).querySelector("time")!.dateTime;
    assert.match(stamp(c).textContent!, /Updated just now/);
    const pending = deferred<Response>();
    c.state(() => pending.promise);
    const refreshing = c.app.refresh();
    assert.equal(c.root.querySelector("#reviews"), table);
    assert.equal(c.dom.window.document.activeElement, approve);
    assert.equal(approve.disabled, false);
    assert.equal(control(c, '[role="switch"]').disabled, false);
    assert.equal(stamp(c).textContent, "Refreshing…");
    assert.equal(stamp(c).querySelector('[role="status"], [aria-live]'), null);
    assert.doesNotMatch(c.root.textContent!, /Loading the latest project snapshot/);
    c.activity(async () => Response.json({ error: "PRIVATE RAW ACTIVITY FAILURE" }, { status: 502 }));
    pending.resolve(Response.json(c.wire));
    await refreshing;
    assert.equal(c.root.querySelector("#reviews"), table);
    assert.equal(stamp(c).querySelector("time")!.dateTime, updatedAt);
    assert.equal(control(c, '[data-action="approve"]').disabled, true);
    assert.equal(control(c, '[role="switch"]').disabled, true);
    // Even scripted re-enabling cannot make stale handlers issue a write.
    const staleApprove = control(c, '[data-action="approve"]');
    staleApprove.disabled = false;
    staleApprove.click();
    const receiptSwitch = control(c, '[role="switch"]');
    receiptSwitch.disabled = false;
    receiptSwitch.click();
    assert.equal(writes(c).length, 0);
    c.state(undefined);
    c.activity(undefined);
    tryAgain(c).click();
    await until(() => !control(c, '[data-action="approve"]').disabled && stamp(c).textContent!.includes("Updated"));
    assert.equal(control(c, '[role="switch"]').disabled, false);
  } finally { c.close(); }
});

test("owner can act during a read; a late failed read cannot stale or unlock the newer write", async () => {
  const c = setup(reviewFixtureState("review-current"));
  try {
    await until(() => control(c, '[data-action="approve"]'));
    const pending = deferred<Response>();
    c.state(() => pending.promise);
    const refreshing = c.app.refresh();
    c.state(undefined);
    control(c, '[data-action="approve"]').click();
    await until(() => writes(c).length === 1 && stamp(c).textContent!.includes("Updated"));
    pending.resolve(Response.json({ error: "late failure" }, { status: 502 }));
    await refreshing;
    assert.doesNotMatch(stamp(c).textContent!, /Couldn't refresh/);
    assert.equal(control(c, '[data-action="approve"]').disabled, false);
  } finally { c.close(); }
});

test("failed refresh disables ordinary and judge promotion without hiding them, including an open confirmation", async () => {
  for (const judge of [false, true]) {
    const c = setup(judge ? judgeFixtureState() : reviewFixtureState("review-approved"), judge ? "race/race-01" : "review");
    const selector = judge ? '[data-action="promote-judge-pick"]' : '[data-action="promote"]';
    try {
      await until(() => control(c, selector));
      const pending = deferred<Response>();
      c.state(() => pending.promise);
      const refreshing = c.app.refresh();
      assert.equal(control(c, selector).disabled, false);
      pending.resolve(Response.json(c.wire));
      await refreshing;
      control(c, selector).click();
      await until(() => control(c, '[data-action="confirm-promote"]'));
      await failRefresh(c);
      assert.equal(control(c, selector).disabled, true);
      const confirm = control(c, '[data-action="confirm-promote"]');
      assert.equal(confirm.disabled, true);
      confirm.disabled = false;
      confirm.click();
      assert.equal(writes(c).length, 0);
      c.state(undefined);
      await c.app.refresh();
      await until(() => !control(c, selector).disabled);
    } finally { c.close(); }
  }
});

test("failed refresh disables Return and its open dialog; successful refresh enables both", async () => {
  const c = setup(reviewFixtureState("review-current"), "review/review-1");
  try {
    await until(() => control(c, '[data-action="return"]'));
    control(c, '[data-action="return"]').click();
    await until(() => control(c, '[data-action="confirm-return"]'));
    const textarea = c.dom.window.document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(c.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Explain the changed behavior.");
    textarea.dispatchEvent(new c.dom.window.Event("input", { bubbles: true }));
    await until(() => !control(c, '[data-action="confirm-return"]').disabled);
    await failRefresh(c);
    assert.equal(control(c, '[data-action="return"]').disabled, true);
    control(c, '[data-action="confirm-return"]').closest<HTMLElement>(".write-hint")!.focus();
    await until(() => c.dom.window.document.body.textContent!.includes("Refresh first. This data is from"));
    const confirm = control(c, '[data-action="confirm-return"]');
    assert.equal(confirm.disabled, true);
    confirm.disabled = false;
    confirm.click();
    assert.equal(writes(c).length, 0);
    c.state(undefined);
    await c.app.refresh();
    await until(() => !control(c, '[data-action="return"]').disabled);
    assert.equal(control(c, '[data-action="confirm-return"]').disabled, false);
  } finally { c.close(); }
});

test("failed refresh fences Mark resolved, including keyboard submit on an already open dialog", async () => {
  const c = setup(collisionFixtureState(), "work");
  try {
    await until(() => control(c, '[aria-label^="Mark resolved:"]'));
    control(c, '[aria-label^="Mark resolved:"]').click();
    await until(() => c.dom.window.document.querySelector(".collision-quick-reasons button"));
    control(c, '.collision-quick-reasons button').click();
    await failRefresh(c);
    assert.equal(control(c, '[aria-label^="Mark resolved:"]').disabled, true);
    const confirm = control(c, '[data-action="confirm-resolve"]');
    assert.equal(confirm.disabled, true);
    confirm.disabled = false;
    confirm.click();
    const textarea = c.dom.window.document.querySelector("textarea")!;
    textarea.dispatchEvent(new c.dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    assert.equal(writes(c).length, 0);
    c.state(undefined);
    await c.app.refresh();
    await until(() => !control(c, '[data-action="confirm-resolve"]').disabled);
  } finally { c.close(); }
});

test("stale agent connections keep owner controls hidden and retain the timestamp", async () => {
  const c = setup(reviewFixtureState("review-current"), "review/review-1", false);
  try {
    await until(() => c.root.querySelector(".review-milestones"));
    await failRefresh(c);
    assert.equal(c.root.querySelector('[data-action="approve"], [data-action="promote"], [data-action="return"], [role="switch"]'), null);
    c.state(undefined);
    tryAgain(c).click();
    await until(() => stamp(c).textContent!.includes("Updated"));
    assert.equal(c.root.querySelector('[data-action="return"]'), null);
  } finally { c.close(); }
});

test("slow review explanation appears after three seconds, then disappears on a successful read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<Response>();
  const c = setup(reviewFixtureState("review-current"), "review/review-1");
  c.detail(() => pending.promise);
  try {
    // Flush the initial state read/effect without advancing the review timer.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.match(c.root.textContent!, /Loading review…/);
    assert.doesNotMatch(c.root.textContent!, /The first open/);
    t.mock.timers.tick(2999);
    assert.doesNotMatch(c.root.textContent!, /The first open/);
    t.mock.timers.tick(1);
    // React batches effects; flush without using the mocked timer queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(c.root.textContent!, /The first open of a review reads its commit from the fork and can take up to 30 s\. Later opens are quick\./);
    pending.resolve(Response.json(reviewFixtureDetail(c.wire)));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(c.root.querySelector(".review-milestones"));
    assert.doesNotMatch(c.root.textContent!, /The first open/);
  } finally { c.close(); t.mock.timers.reset(); }
});

test("review error never exposes raw bodies, retries one read, and shows bounded diagnostic IDs only to owners", async () => {
  for (const owner of [true, false]) {
    const c = setup(reviewFixtureState("review-current"), "review/review-1", owner);
    let failed = true;
    c.detail(async () => failed
      ? Response.json({ error: "PRIVATE RAW 502 BODY", diagnosticId }, { status: 502 })
      : Response.json(reviewFixtureDetail(c.wire)));
    try {
      await until(() => c.root.textContent!.includes("Couldn't load this review."));
      assert.match(c.root.textContent!, /Reading the fork's repository failed\. Try again in a moment\./);
      assert.doesNotMatch(c.root.textContent!, /PRIVATE RAW/);
      assert.equal(c.root.textContent!.includes(`Diagnostic ID ${diagnosticId}`), owner);
      const before = c.calls.filter((call) => call.path.endsWith("/reviews/review-1")).length;
      failed = false;
      [...c.root.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
      await until(() => c.root.querySelector(".review-milestones"));
      assert.equal(c.calls.filter((call) => call.path.endsWith("/reviews/review-1")).length, before + 1);
      assert.doesNotMatch(c.root.textContent!, /Diagnostic ID/);
    } finally { c.close(); }
  }
});
