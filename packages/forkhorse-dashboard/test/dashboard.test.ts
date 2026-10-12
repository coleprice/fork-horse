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
  JSDOM: new (
    html: string,
    options?: { url: string },
  ) => {
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
    assert.match(context.root.textContent!, /Receipt ddddddd/);
    assert.match(context.root.textContent!, /Fork moved/);
    assert.equal(button(context.root, "approve").disabled, false);
    assert.equal(button(context.root, "promote"), null);
    assert.equal(button(context.root, "approve", "review-2"), null);
    assert.equal(button(context.root, "approve", "review-3"), null);
    const blocked = Array.from(context.root.querySelectorAll(".review-card")).find((row) =>
      row.textContent!.includes("api-02"),
    )!;
    assert.match(blocked.textContent!, /Waiting for a passing receipt/);
  } finally {
    context.cleanup();
  }
});

test("review rows explain blocker gates and activity is empty only after a successful snapshot", () => {
  const state = stateView(fixtureState());
  state.reviews.find((review) => review.packet === "api-02")!.receiptDigest = DIGEST;
  const base = { brand, projects: [], project: "demo", fixture: true, activity: [], busy: false };
  for (const snapshot of [
    { ...base, state },
    { ...base, busy: true },
    { ...base, error: "Snapshot unavailable" },
  ]) {
    const dom = new JSDOM(renderDashboard(snapshot));
    try {
      const activity = dom.window.document.querySelector("#activity")!;
      assert.equal(activity.textContent!.includes("No pushes yet."), "state" in snapshot);
      if ("state" in snapshot) {
        const blocked = Array.from(dom.window.document.querySelectorAll(".review-card")).find(
          (row) => row.textContent!.includes("api-02"),
        )!;
        assert.match(blocked.textContent!, /Resolve the packet's blockers first/);
        assert.equal(activity.querySelectorAll("p").length, 1);
      } else {
        assert.equal(activity.textContent, "");
      }
    } finally {
      dom.window.close();
    }
  }
});

test("owner DOM Approve calls the review endpoint once; Promote refreshes head and ledger", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const approve = button(context.root, "approve");
    approve.click();
    approve.click();
    await until(() => context.dom.window.document.body.textContent!.includes("Approved bbbbbbb"));
    assert.equal(context.fixture.calls.filter((call) => call.options.method === "POST").length, 1);
    const approvalCall = context.fixture.calls.find((entry) => entry.options.method === "POST")!;
    assert.equal(approvalCall.url.pathname, "/projects/demo/reviews/review-1/approve");
    assert.equal(approvalCall.options.credentials, "same-origin");
    assert.equal(approvalCall.options.body, "{}");
    assert.deepEqual(approvalCall.options.headers, { "Content-Type": "application/json" });
    await until(() => !!button(context.root, "promote"));
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
    await until(() => context.dom.window.document.body.textContent!.includes("Promoted bbbbbbb"));
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
      () =>
        context.root
          .querySelector('[role="alert"]')
          ?.textContent?.includes("stale base, rebase") === true,
    );
    assert.equal(button(context.root, "approve"), null);
    assert.equal(context.fixture.calls.filter((call) => call.options.method === "POST").length, 1);
  } finally {
    context.cleanup();
  }
});

test("expired session clears old actionable state; project switching shows empty state", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const combo = context.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    combo.focus();
    combo.dispatchEvent(
      new context.root.ownerDocument.defaultView!.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    );
    await until(() => !!context.dom.window.document.querySelector('[role="option"]'));
    const option = [
      ...context.dom.window.document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((entry) => entry.textContent === "Quiet")!;
    option.focus();
    option.dispatchEvent(
      new context.root.ownerDocument.defaultView!.MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
      }),
    );
    option.dispatchEvent(
      new context.root.ownerDocument.defaultView!.MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
      }),
    );
    option.click();
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

test("promotion confirmation stays bound to the displayed head when a fresh snapshot moves the fork", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    button(context.root, "approve").click();
    await until(() => !!button(context.root, "promote"));
    button(context.root, "promote").click();
    await until(
      () => !!context.dom.window.document.querySelector('[data-action="confirm-promote"]'),
    );
    context.fixture.state.forks[0].head = "f".repeat(40);
    await context.app.refresh();
    const confirm = context.dom.window.document.querySelector<HTMLButtonElement>(
      '[data-action="confirm-promote"]',
    )!;
    assert.equal(confirm.disabled, true);
    confirm.click();
    assert.equal(
      context.fixture.calls.filter((entry) => entry.url.pathname.endsWith("/promote")).length,
      0,
    );
  } finally {
    context.cleanup();
  }
});

test("tabs preserve fragment selection when the sandbox rejects History API URLs", async () => {
  const context = setup();
  try {
    await until(() => Boolean(context.root.querySelector("#reviews")));
    const window = context.root.ownerDocument.defaultView!;
    window.history.replaceState = () => {
      throw new window.DOMException("Opaque origin", "SecurityError");
    };
    context.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
    assert.equal(window.location.hash, "#work");
    await context.app.refresh();
    assert.equal(context.root.querySelector<HTMLElement>("#view-work")!.hidden, false);
  } finally {
    context.cleanup();
  }
});

test("packet states follow blocker, promotion, approval, stale review and claim precedence", async () => {
  const { packetStatus } = await import("../src/view.tsx");
  const state = stateView(fixtureState());
  const id = state.packets[0].id;
  const review = state.reviews[0];
  assert.equal(packetStatus(id, state).label, "In review");
  review.status = "stale";
  assert.equal(packetStatus(id, state).label, "Fork moved");
  review.status = "approved";
  assert.equal(packetStatus(id, state).label, "Approved");
  review.status = "promoted";
  assert.equal(packetStatus(id, state).label, "Promoted");
  state.blockers[0].packet = id;
  assert.equal(packetStatus(id, state).label, "Blocked");
  state.blockers = [];
  state.reviews = [];
  assert.equal(packetStatus(id, state).label, "In progress");
  state.claims = [];
  assert.equal(packetStatus(id, state).label, "Ready");
});

test("optional events and real claim times are preserved; absent metadata is omitted", () => {
  const wire = fixtureState();
  wire.project.events = "active";
  wire.forks[0].events = "pending";
  const state = stateView(wire);
  assert.equal(state.project.events, "active");
  assert.equal(state.forks[0].events, "pending");
  assert.equal(state.claims[0].createdAt, wire.claims[0].createdAt);
  assert.equal(state.blockers[0].claimingAgent, wire.blockers[0].claimingAgent);
  delete state.project.events;
  for (const fork of state.forks) delete fork.events;
  const html = renderDashboard({
    brand,
    project: "demo",
    projects: [],
    fixture: false,
    state,
    activity: [],
    busy: false,
  });
  assert.doesNotMatch(
    html,
    /Events pending|Unavailable|Details pending|Return to agent|Load older|Exact identifiers/,
  );
});

test("path summaries use true totals, first-push and deletion copy; details limit and expand only supplied paths", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { Paths, PathDetails } = await import("../src/view.tsx");
  for (const [scenario, text] of [
    ["large", "+449 more"],
    ["first", "First push · 450 files"],
    ["partial", "+449 more"],
    ["deleted", "Deleted"],
  ]) {
    const event = fixtureState(scenario).activity[0];
    const html = renderToStaticMarkup(createElement(Paths, { paths: event.changedPaths, event }));
    assert.match(html, new RegExp(text.replace(/[+·]/g, "\\$&")));
  }
  const dom = new JSDOM('<div id="dashboard"></div>');
  installDom(dom.window as unknown as Window & typeof globalThis);
  const root = dom.window.document.getElementById("dashboard")!;
  const react = createRoot(root);
  try {
    const event = fixtureState("partial").activity[0];
    flushSync(() =>
      react.render(
        createElement(PathDetails, {
          paths: event.changedPaths,
          total: event.changedPathCount,
          partial: true,
        }),
      ),
    );
    assert.equal(root.querySelectorAll("code").length, 20);
    assert.match(root.textContent!, /Show all 30 paths/);
    assert.match(root.textContent!, /Showing 30 of 450 paths/);
    root.querySelector<HTMLButtonElement>("button")!.click();
    await until(() => root.querySelectorAll("code").length === 30);
    assert.equal(root.querySelector("button"), null);
  } finally {
    flushSync(() => react.unmount());
    dom.window.close();
  }
});

test("promotion confirmation refuses a changed base even when the fork head and digest stay equal", async () => {
  const context = setup();
  try {
    await until(() => !!context.root.querySelector("#reviews"));
    button(context.root, "approve").click();
    await until(() => !!button(context.root, "promote"));
    button(context.root, "promote").click();
    await until(
      () => !!context.dom.window.document.querySelector('[data-action="confirm-promote"]'),
    );
    context.fixture.state.reviews[0].base = "9".repeat(40);
    await context.app.refresh();
    assert.equal(
      context.dom.window.document.querySelector<HTMLButtonElement>(
        '[data-action="confirm-promote"]',
      )!.disabled,
      true,
    );
    assert.equal(
      context.fixture.calls.filter((call) => call.url.pathname.endsWith("/promote")).length,
      0,
    );
  } finally {
    context.cleanup();
  }
});

test("superseded stale reviews leave the queue; unsuperseded stale rows do not count", async () => {
  const { reviewQueue } = await import("../src/model.ts");
  const state = stateView(fixtureState("superseded"));
  assert.equal(reviewQueue(state).length, 0);
  state.reviews[0].status = "pending";
  assert.deepEqual(
    reviewQueue(state).map((r) => r.id),
    ["review-1"],
  );
  state.reviews[0].requestedAt = state.reviews[1].requestedAt;
  assert.equal(reviewQueue(state).length, 2);
  const html = renderDashboard({
    brand,
    project: "demo",
    projects: [],
    fixture: true,
    state,
    activity: [],
    busy: false,
  });
  assert.match(html, /Fork moved/);
  assert.match(html, /In review/);
});

test("panel defaults use first frame width and remember only a session toggle", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: origin });
  installDom(dom.window as unknown as Window & typeof globalThis);
  const window = dom.window as unknown as Window & typeof globalThis;
  const root = window.document.getElementById("dashboard")!;
  function mount(width: number) {
    window.innerWidth = width;
    return mountDashboard(root, {
      brand,
      transport: createHttpTransport({ origin, fetch: apiFixture().fetcher }),
      initialProject: "demo",
    });
  }
  try {
    for (const width of [1340, 1340, 1100, 1100]) {
      const app = mount(width);
      assert.equal(
        root.querySelector("[data-action=toggle-activity]")!.getAttribute("aria-expanded"),
        String(width >= 1280),
      );
      app.dispose();
    }
    const app = mount(1340);
    root.querySelector<HTMLButtonElement>("[data-action=toggle-activity]")!.click();
    await until(
      () =>
        root.querySelector("[data-action=toggle-activity]")!.getAttribute("aria-expanded") ===
        "false",
    );
    app.dispose();
    const reopened = mount(1340);
    assert.equal(
      root.querySelector("[data-action=toggle-activity]")!.getAttribute("aria-expanded"),
      "false",
    );
    reopened.dispose();
  } finally {
    window.close();
  }
});

test("live pause preserves the snapshot and tabs; Reconnect clears the warning", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>');
  installDom(dom.window as unknown as Window & typeof globalThis);
  const root = dom.window.document.getElementById("dashboard")!;
  const transport = createHttpTransport({ origin, fetch: apiFixture().fetcher });
  let notify!: (paused: boolean) => void;
  let stopped = false;
  transport.live = {
    subscribe(listener) {
      notify = listener;
      return () => {
        stopped = true;
      };
    },
    async reconnect() {
      notify(false);
    },
  };
  const app = mountDashboard(root, { brand, transport, initialProject: "demo" });
  try {
    await until(() => !!root.querySelector("#reviews"));
    notify(true);
    assert.match(
      root.querySelector(".live-paused")!.textContent!,
      /Live updates paused. Showing data from/,
    );
    root.querySelectorAll<HTMLButtonElement>("[role=tab]")[3].click();
    await until(() => !root.querySelector<HTMLElement>("#view-agents")!.hidden);
    assert.ok(root.querySelector("#lanes table"));
    root.querySelector<HTMLButtonElement>(".live-paused button")!.click();
    await until(() => !root.querySelector(".live-paused"));
  } finally {
    app.dispose();
    dom.window.close();
  }
  assert.equal(stopped, true);
});
