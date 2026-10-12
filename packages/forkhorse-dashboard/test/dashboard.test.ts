import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport, ApiError } from "../src/transport.ts";
import { renderDashboard } from "../src/render.ts";
import { assertState, reviewGate, stateView } from "../src/model.ts";
import { DIGEST, fixtureActivity, fixtureState, NEXT_HEAD } from "./fixtures.ts";

const require = createRequire(import.meta.url);
// jsdom is used only for local DOM acceptance; production has no runtime dependency.
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => {
    window: {
      document: Document;
      MouseEvent: typeof MouseEvent;
      Event: typeof Event;
      close(): void;
    };
  };
};
const brand = { name: "Fixture product", tagline: "Fixture collaboration" };
const origin = "https://workspace.idiot.tax";

function apiFixture() {
  const state = fixtureState();
  const calls: { url: URL; options: RequestInit }[] = [];
  let failedAction = false;
  let unauthorized = false;
  const fetcher: typeof fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (unauthorized) return Response.json({ error: "Unauthorized" }, { status: 403 });
    if (url.pathname === "/projects/quiet/state") return Response.json(fixtureState("quiet"));
    if (url.pathname === "/projects/quiet/activity")
      return Response.json({ activity: [], nextAfter: 0 });
    if (url.pathname === "/projects/demo/state") return Response.json(state);
    if (url.pathname === "/projects/demo/activity")
      return Response.json({ activity: fixtureActivity(), nextAfter: 3 });
    if (options.method === "POST") {
      if (failedAction) {
        state.reviews[0].stale = true;
        return Response.json({ error: "stale base, rebase" }, { status: 409 });
      }
      const review = state.reviews[0];
      if (url.pathname === "/projects/demo/reviews/review-1/approve") {
        review.approval = { sha: review.sha, receiptDigest: review.receiptDigest };
        return Response.json({ review });
      }
      if (url.pathname === "/projects/demo/reviews/review-1/promote") {
        assert.ok(review.approval);
        review.promoted = true;
        state.ledger.push({
          id: "merge-1",
          review: review.id,
          repoName: state.project.repoName,
          ref: "refs/heads/main",
          before: review.base,
          after: review.sha,
          receiptDigest: review.receiptDigest,
          recordedAt: "2026-10-12T00:20:00.000Z",
        });
        return Response.json({ sha: review.sha });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  return {
    state,
    calls,
    fetcher,
    failAction() {
      failedAction = true;
    },
    expireSession() {
      unauthorized = true;
    },
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("DOM did not reach expected state");
}

function setup() {
  const dom = new JSDOM('<div id="dashboard"></div>');
  installDom(dom.window as unknown as Window & typeof globalThis);
  const root = dom.window.document.getElementById("dashboard")!;
  const fixture = apiFixture();
  const app = mountDashboard(root, {
    brand,
    fixture: true,
    projects: [
      { id: "demo", label: "Demo" },
      { id: "quiet", label: "Quiet" },
    ],
    transport: createHttpTransport({ origin, fetch: fixture.fetcher }),
  });
  return {
    dom,
    root,
    fixture,
    app,
    cleanup() {
      app.dispose();
      dom.window.close();
    },
  };
}

const button = (root: HTMLElement, action: string, review = "review-1") =>
  root.querySelector<HTMLButtonElement>(
    `button[data-action="${action}"][data-review="${review}"]`,
  )!;

test("fixture DOM renders every packet view with fork-bound claims and evidence", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    for (const section of ["lanes", "packets", "blockers", "receipts", "activity"])
      assert.ok(context.root.querySelector(`#${section}`));
    assert.match(context.root.textContent!, /FIXTURE · OFFLINE/);
    assert.match(context.root.textContent!, /demo--builder-1/);
    assert.match(context.root.textContent!, /Receipt bound/);
    assert.match(context.root.textContent!, /Fork moved/);
    assert.equal(button(context.root, "approve").disabled, false);
    assert.equal(button(context.root, "promote").disabled, true);
    assert.equal(button(context.root, "approve", "review-2").disabled, true);
    assert.equal(button(context.root, "approve", "review-3").disabled, true);
  } finally {
    context.cleanup();
  }
});

test("owner DOM Approve calls the review endpoint once; Promote refreshes head and ledger", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const approve = button(context.root, "approve");
    approve.click();
    approve.click();
    await until(() => context.root.textContent!.includes("Approved ui-01"));
    assert.equal(context.fixture.calls.filter((call) => call.options.method === "POST").length, 1);
    const call = context.fixture.calls.find((entry) => entry.options.method === "POST")!;
    assert.equal(call.url.pathname, "/projects/demo/reviews/review-1/approve");
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.body, "{}");
    assert.deepEqual(call.options.headers, { "Content-Type": "application/json" });
    assert.equal(button(context.root, "promote").disabled, false);
    button(context.root, "promote").click();
    await until(
      () => !!context.dom.window.document.querySelector('[data-action="confirm-promote"]'),
    );
    assert.equal(
      context.fixture.calls.filter((call) => call.options.method === "POST").length,
      1,
      "opening confirmation performs no write",
    );
    context.dom.window.document
      .querySelector<HTMLButtonElement>('[data-action="confirm-promote"]')!
      .click();
    await until(() => context.root.textContent!.includes("Promoted ui-01"));
    assert.equal(context.fixture.state.ledger[0].after, NEXT_HEAD);
    assert.equal(context.fixture.state.ledger.length, 1);
    assert.ok(context.fixture.calls.some((entry) => entry.url.pathname.endsWith("/promote")));
    assert.equal(button(context.root, "approve"), null);
  } finally {
    context.cleanup();
  }
});

test("a stale-base conflict is surfaced and refreshed without retrying the owner write", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    context.fixture.failAction();
    button(context.root, "approve").click();
    await until(
      () => context.root.querySelector('[role="alert"]')?.textContent === "stale base, rebase",
    );
    assert.equal(button(context.root, "approve").disabled, true);
    assert.equal(context.fixture.calls.filter((call) => call.options.method === "POST").length, 1);
  } finally {
    context.cleanup();
  }
});

test("expired session clears old actionable state; project switching shows empty state", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const select = context.root.querySelector<HTMLSelectElement>("#project")!;
    select.value = "quiet";
    select.dispatchEvent(new context.dom.window.Event("change", { bubbles: true }));
    await until(() => context.root.textContent!.includes("No enrolled agents."));
    assert.equal(context.root.querySelectorAll(".review-card").length, 0);
    context.fixture.expireSession();
    await context.app.refresh();
    assert.match(context.root.textContent!, /Owner session unavailable/);
    assert.equal(context.root.querySelector("#reviews"), null);
  } finally {
    context.cleanup();
  }
});

test("all API/config text is escaped, including review IDs, paths and error messages", () => {
  const state = stateView(fixtureState());
  state.packets[0].title = '<img src=x onerror="alert(1)">';
  state.reviews[0].id = '" onclick="alert(2)';
  const html = renderDashboard({
    brand,
    projects: [],
    project: "demo",
    fixture: true,
    state,
    activity: [],
    busy: false,
    error: "<script>bad()</script>",
  });
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector("img,script"), null);
  assert.equal(dom.window.document.querySelector("[onclick]"), null);
  assert.match(dom.window.document.body.textContent!, /<img src=x/);
  dom.window.close();
});

test("head, receipt and blocker gates never authorize stale or incomplete reviews", () => {
  const state = stateView(fixtureState());
  const review = state.reviews[0];
  assert.equal(reviewGate(review, state).approve, true);
  state.forks[0].head = "0".repeat(40);
  assert.equal(reviewGate(review, state).approve, false);
  state.forks[0].head = review.sha;
  review.receiptDigest = null;
  assert.equal(reviewGate(review, state).approve, false);
  review.receiptDigest = DIGEST;
  state.blockers[0].packet = review.packet;
  assert.equal(reviewGate(review, state).approve, false);
  assert.throws(() => assertState({ ...state, reviews: undefined } as never), /contract/);
});

test("HTTP transport encodes IDs, uses activity cursor, refuses login HTML and redirects", async () => {
  const urls: string[] = [];
  const transport = createHttpTransport({
    origin,
    fetch: async (url, options) => {
      assert.equal(options?.redirect, "error");
      assert.equal(options?.cache, "no-store");
      urls.push(String(url));
      return Response.json({ activity: [], nextAfter: 7 });
    },
  });
  await transport.getActivity("a/b", 7);
  assert.equal(urls[0], `${origin}/projects/a%2Fb/activity?after=7&limit=100`);
  const htmlTransport = createHttpTransport({
    origin,
    fetch: async () =>
      new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
  });
  await assert.rejects(
    htmlTransport.getState("demo"),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

test("optional WebSocket invalidation is same-origin, receives messages and closes on dispose", () => {
  const events = new Map<string, () => void>();
  let closed = false;
  let updates = 0;
  const socket = {
    addEventListener(type: string, handler: () => void) {
      events.set(type, handler);
    },
    removeEventListener(type: string) {
      events.delete(type);
    },
    close() {
      closed = true;
    },
  } as unknown as WebSocket;
  const transport = createHttpTransport({
    origin,
    socketUrl: (id) => `/events/${id}`,
    openSocket(url) {
      assert.equal(url, "wss://workspace.idiot.tax/events/demo");
      return socket;
    },
  });
  const dispose = transport.subscribe!("demo", () => updates++);
  events.get("message")!();
  assert.equal(updates, 1);
  dispose();
  assert.equal(closed, true);
  assert.equal(events.size, 0);
  const foreign = createHttpTransport({
    origin,
    socketUrl: () => "wss://foreign.idiot.tax/events",
    openSocket() {
      assert.fail("must reject before opening socket");
    },
  });
  assert.throws(() => foreign.subscribe!("demo", () => {}), /origin/);
});

test("wire normalization preserves live fork bindings and refuses a changed approval digest", () => {
  const wire = fixtureState();
  wire.reviews[0].approval = { sha: wire.reviews[0].sha, receiptDigest: "e".repeat(64) };
  wire.promotionPending = {
    id: "pending-1",
    review: "review-1",
    repoName: "demo",
    ref: "refs/heads/main",
    before: wire.reviews[0].base,
    after: wire.reviews[0].sha,
    receiptDigest: DIGEST,
    recordedAt: "2026-10-12T00:20:00.000Z",
  };
  const view = stateView(wire);
  assert.equal(view.claims[0].repoName, "demo--builder-1");
  assert.equal(view.claims[0].active, true);
  assert.equal(reviewGate(view.reviews[0], view).promote, false);
  assert.equal(view.reviews[0].status, "stale");
  assert.equal(view.canonicalHead, undefined);
  assert.match(view.reconcilerAlerts[0].message, /pending owner inspection/);
});

test("activity request follows the recent snapshot cursor instead of showing the first page", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const activity = context.fixture.calls.find((call) => call.url.pathname.endsWith("/activity"))!;
    assert.equal(activity.url.searchParams.get("after"), "3");
    assert.equal(context.root.querySelectorAll(".activity").length, 3);
  } finally {
    context.cleanup();
  }
});

test("top tabs select one visible view and preserve focus across refreshes", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const tabs = [...context.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.deepEqual(
      tabs.map((tab) => tab.textContent!.replace(/\s*\d+$/, "").trim()),
      ["Overview", "Work", "Review", "Agents"],
    );
    tabs[1].focus();
    tabs[1].click();
    assert.equal(context.root.querySelector<HTMLElement>("#view-work")!.hidden, false);
    assert.equal(context.root.querySelector<HTMLElement>("#view-overview")!.hidden, true);
    await context.app.refresh();
    assert.equal(
      context.dom.window.document.activeElement,
      tabs[1],
      "refresh preserves the same focused Kumo tab",
    );
  } finally {
    context.cleanup();
  }
});
