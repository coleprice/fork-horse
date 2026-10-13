import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import {
  promotionReceipt,
  recentReceipts,
  receiptGateCaption,
  reviewGate,
  stateView,
} from "../src/model.ts";
import { relativeTime } from "../src/time.ts";
import { duration, ReceiptDetails } from "../src/receipts.tsx";
import { fixtureOwnerReceipt, fixtureReceipt, fixtureState } from "./fixtures.ts";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://fixture.idiot.tax";
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Receipt DOM did not settle");
}
function setup(id = "receipts", owner = true, fetcher?: typeof fetch) {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: `${origin}/#review` });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const wire = fixtureState(id);
  const calls: { path: string; method: string; body?: BodyInit | null }[] = [];
  const transport = createHttpTransport({
    origin,
    fetch:
      fetcher ??
      (async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        if (path.endsWith("/state")) return Response.json(wire);
        if (path.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
        if (path.endsWith("/settings")) {
          wire.project.settings = JSON.parse(String(init!.body));
          return Response.json({ settings: wire.project.settings });
        }
        const review = wire.reviews.find((r) => path.includes(`/reviews/${r.id}/`))!;
        if (path.endsWith("/receipt")) {
          return review?.receipt?.digest
            ? Response.json(fixtureOwnerReceipt(review))
            : Response.json({ error: "Receipt not found." }, { status: 404 });
        }
        if (path.endsWith("/approve")) {
          review.approval = { sha: review.sha, receiptDigest: review.receiptDigest };
          return Response.json({ review });
        }
        if (path.endsWith("/promote")) {
          if (wire.project.settings!.requireReceipt) {
            review.receipt = fixtureReceipt("failed", "before-promote");
            review.receiptDigest = review.receipt.digest;
            return Response.json({ error: "Checks failed before promote." }, { status: 409 });
          }
          review.promoted = true;
          return Response.json({ sha: review.sha });
        }
        return Response.json({ error: "Fixture missing route" }, { status: 404 });
      }),
  });
  const app = mountDashboard(root, {
    brand: { name: "Fixture product", tagline: "Fixture" },
    fixture: true,
    owner,
    transport,
    initialProject: id,
  });
  return {
    dom,
    root,
    wire,
    calls,
    app,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}

test("receipt wire maps every status without logs; durations and timeout use supplied check time", async () => {
  for (const [ms, text] of [[0, "0 ms"], [1, "1 ms"], [227, "227 ms"], [999, "999 ms"], [1000, "1 s"], [1499, "1 s"], [1500, "2 s"]] as const)
    assert.equal(duration(ms), text);
  assert.equal(duration(-1), "");
  assert.equal(duration(Number.NaN), "");
  assert.equal(duration(41000), "41 s");
  assert.equal(duration(110000), "1 min 50 s");
  assert.equal(duration(60000), "1 min");
  assert.equal(duration(59999), "1 min");
  assert.equal(duration(null), "");
  const c = setup();
  try {
    await until(() => !!c.root.querySelector("#reviews"));
    const rows = [...c.root.querySelectorAll(".review-card")];
    assert.equal(rows.length, 7);
    for (const word of [
      "Checks running",
      "Re-checking",
      "Passed",
      "Failed",
      "Timed out",
      "Couldn't run",
      "Not started",
    ])
      assert.ok(
        rows.some((row) => row.textContent!.includes(word)),
        word,
      );
    assert.match(rows[4].textContent!, /Stopped after 1 min 50 s · brand/);
    assert.match(rows[5].textContent!, /The checks didn't start/);
    assert.equal(
      c.root.querySelectorAll('[data-action="approve"]').length,
      0,
      "only passing row is already approved",
    );
    assert.equal(JSON.stringify(c.wire).includes("stdout"), false);
    assert.deepEqual(stateView(c.wire).reviews[4].receipt, c.wire.reviews[4].receipt);
  } finally {
    c.close();
  }
});

test("queue and recent receipts use singular and plural check counts, including failed totals", async () => {
  for (const count of [1, 2]) {
    const c = setup("history-required");
    try {
      await until(() => !!c.root.querySelector(".receipt-history-row"));
      for (const review of c.wire.reviews) {
        if (review.receipt) {
          review.receipt.checks = review.receipt.checks.slice(0, count);
          review.receipt.durationMs = 4000;
        }
      }
      await c.app.refresh();
      const expected = `${count} ${count === 1 ? "check" : "checks"} · 4 s`;
      await until(() =>
        c.root.querySelector(".receipt-history-row")!.textContent!.includes(expected),
      );
      const passedReview = c.wire.reviews.find((review) => review.id === "receipt-3")!;
      const passed = [...c.root.querySelectorAll(".review-card")].find((row) => row.textContent!.includes(passedReview.repoName))!;
      assert.ok(passed.querySelector(".receipt-cell")!.textContent!.includes(expected));
      const history = [...c.root.querySelectorAll(".receipt-history-row")];
      assert.equal(history.length, 5);
      assert.ok(history.every((row) => row.textContent!.includes(expected)));
      const failed = c.root.querySelectorAll(".review-card")[3];
      assert.ok(failed.textContent!.includes(`1 of ${count} failed`));
      assert.doesNotMatch(c.root.textContent!, /1 checks/);
    } finally {
      c.close();
    }
  }
});

test("Promote stays hidden during an in-flight re-check and returns after an interrupted run", async () => {
  const wire = fixtureState("receipts");
  const review = wire.reviews[2];
  let finish: (() => void) | undefined;
  let promoteCalls = 0;
  const c = setup("receipts", true, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/state")) return Response.json(wire);
    if (path.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
    if (path.endsWith("/promote")) {
      promoteCalls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      review.receipt = fixtureReceipt("timed-out", "before-promote");
      return Response.json({ error: "Checks failed before promote." }, { status: 409 });
    }
    return Response.json({ error: "Fixture missing route" }, { status: 404 });
  });
  const selector = '[data-action="promote"][data-review="receipt-3"]';
  try {
    await until(() => !!c.root.querySelector(selector));
    c.root.querySelector<HTMLButtonElement>(selector)!.click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    c.dom.window.document.querySelector('[data-action="confirm-promote"]')!.click();
    await until(() => !!finish);
    assert.equal(c.root.querySelector(selector), null);
    const confirm = c.dom.window.document.querySelector(
      '[data-action="confirm-promote"]',
    ) as HTMLButtonElement;
    assert.equal(confirm.textContent, "Re-checking…");
    assert.equal(confirm.disabled, true);
    assert.equal(promoteCalls, 1);
    finish!();
    await until(() => !!c.root.querySelector(selector));
    assert.match(
      c.root.querySelector(selector)!.closest("tr")!.textContent!,
      /Promote runs the checks again/,
    );
    assert.equal(promoteCalls, 1, "interrupted runs are never automatically retried");
  } finally {
    finish?.();
    c.close();
  }
});

test("advisory receipt outcomes never gate; approved reviews re-satisfy the gate after setting flip", () => {
  const state = stateView(fixtureState("advisory"));
  for (const review of state.reviews) {
    review.status = "pending";
    assert.equal(reviewGate(review, state).approve, true);
    review.status = "approved";
    assert.equal(reviewGate(review, state).promote, true);
  }
  state.project.settings!.requireReceipt = true;
  const failed = state.reviews[3];
  failed.status = "pending";
  assert.equal(reviewGate(failed, state).approve, false);
  failed.status = "approved";
  assert.equal(reviewGate(failed, state).promote, true, "promote enters core's fresh re-run");
  failed.status = "stale";
  assert.equal(reviewGate(failed, state).promote, false);
  assert.equal(
    receiptGateCaption(state.reviews[4], true),
    "Checks timed out. A new push runs them again.",
  );
  const advisory = fixtureState("advisory");
  advisory.reviews[3].approval = { sha: advisory.reviews[3].sha, receiptDigest: null };
  assert.equal(
    stateView(advisory).reviews[3].status,
    "approved",
    "advisory digest movement is not a moved fork",
  );
});

test("owner logs use encoded owner route, last 200 lines, Show all; agent has no logs or switch", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector("#reviews"));
    c.root.querySelectorAll<HTMLButtonElement>(".column-receipts .receipt-cell")[2].click();
    await until(() => !!c.root.querySelector(".receipt-details"));
    const logs = [...c.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "View logs",
    )!;
    logs.click();
    await until(() => !!c.root.querySelector(".receipt-logs"));
    assert.equal(c.root.querySelector(".receipt-logs")!.textContent!.split("\n").length, 200);
    [...c.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Show all")!
      .click();
    await until(() => c.root.querySelector(".receipt-logs")!.textContent!.split("\n").length > 200);
    const hide = [...c.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Hide logs",
    )!;
    hide.click();
    await until(() => !c.root.querySelector(".receipt-logs"));
    assert.ok(
      [...c.root.querySelectorAll<HTMLButtonElement>("button")].some(
        (b) => b.textContent === "View logs",
      ),
    );
    assert.equal(c.calls.filter((call) => call.path.endsWith("/receipt")).length, 1);
    assert.match(c.calls.at(-1)!.path, /\/projects\/receipts\/reviews\/receipt-3\/receipt$/);
  } finally {
    c.close();
  }
  const agent = setup("advisory", false);
  try {
    await until(() => !!agent.root.querySelector("#reviews"));
    agent.root.querySelectorAll<HTMLButtonElement>(".column-receipts .receipt-cell")[2].click();
    await until(() => !!agent.root.querySelector(".receipt-details"));
    assert.doesNotMatch(agent.root.textContent!, /View logs/);
    assert.equal(agent.root.querySelector('[role="switch"]'), null);
    assert.match(agent.root.textContent!, /Require passing receipts: Off/);
    assert.equal(
      agent.calls.some((call) => call.path.endsWith("/receipt")),
      false,
    );
  } finally {
    agent.close();
  }
});

test("required promote 409 keeps dialog with failure and opens new receipt; advisory has no re-check copy", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector('[data-action="promote"]'));
    c.root
      .querySelector<HTMLButtonElement>('[data-action="promote"][data-review="receipt-3"]')!
      .click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    assert.match(c.dom.window.document.body.textContent!, /Checks run again/);
    c.dom.window.document.querySelector('[data-action="confirm-promote"]').click();
    await until(() => c.dom.window.document.body.textContent!.includes("Nothing was promoted."));
    assert.ok(c.dom.window.document.querySelector(".promotion-dialog"));
    assert.equal(
      c.root.querySelector('[role="alert"]'),
      null,
      "handled conflict has no page error banner",
    );
    assert.equal(c.dom.window.document.querySelectorAll('[role="alert"]').length, 1);
    assert.doesNotMatch(c.dom.window.document.body.textContent!, /Checks failed before promote\./);
    assert.ok(
      c.dom.window.document.querySelector(".receipt-error-line svg"),
      "Warning icon accompanies error copy",
    );
    assert.equal(c.root.querySelector('[data-action="promote"][data-review="receipt-3"]'), null);
    assert.equal(c.calls.filter((call) => call.path.endsWith("/promote")).length, 1);
    [...c.dom.window.document.querySelectorAll(".promotion-dialog button")]
      .find((b: HTMLButtonElement) => b.textContent === "View receipt")!
      .click();
    await until(
      () => c.root.querySelector(".receipt-details")?.textContent?.includes("Failed") === true,
    );
    assert.equal(
      c.root.textContent!.includes("Fork moved"),
      false,
      "fresh re-run digest doesn't imply fork movement",
    );
  } finally {
    c.close();
  }
  const a = setup("advisory");
  try {
    await until(() => !!a.root.querySelector('[data-action="approve"][data-review="receipt-4"]'));
    a.root
      .querySelector<HTMLButtonElement>('[data-action="approve"][data-review="receipt-4"]')!
      .click();
    await until(() => !!a.root.querySelector('[data-action="promote"][data-review="receipt-4"]'));
    a.root
      .querySelector<HTMLButtonElement>('[data-action="promote"][data-review="receipt-4"]')!
      .click();
    await until(() => !!a.dom.window.document.querySelector(".promotion-dialog"));
    assert.match(
      a.dom.window.document.body.textContent!,
      /latest checks failed; receipts are advisory/,
    );
    assert.doesNotMatch(a.dom.window.document.body.textContent!, /Checks run again|Re-checking/);
  } finally {
    a.close();
  }
});

test("settings PATCH sends only requireReceipt and reloads authoritative state", async () => {
  const c = setup("advisory");
  try {
    await until(() => !!c.root.querySelector('[role="switch"]'));
    c.root.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await until(
      () =>
        c.wire.project.settings!.requireReceipt &&
        c.root.querySelector('[role="switch"]')!.getAttribute("aria-checked") === "true",
    );
    const patches = c.calls.filter((call) => call.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body, '{"requireReceipt":true}');
    assert.ok(c.calls.at(-1)!.path.endsWith("/activity"));
    assert.equal(c.root.querySelector('[data-action="approve"][data-review="receipt-5"]'), null);
  } finally {
    c.close();
  }
});

test("late owner log response is discarded when receipt changes", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: origin });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard");
  const react = createRoot(root);
  const review = stateView(fixtureState("receipts")).reviews[2];
  let finish!: (value: ReturnType<typeof fixtureOwnerReceipt>) => void;
  const load = () =>
    new Promise<ReturnType<typeof fixtureOwnerReceipt>>((resolve) => {
      finish = resolve;
    });
  const draw = () =>
    flushSync(() =>
      react.render(
        createElement(ReceiptDetails, { review, project: "receipts", owner: true, load }),
      ),
    );
  try {
    draw();
    root.querySelector('button[aria-label="Copy to clipboard"]')?.blur();
    [...root.querySelectorAll("button")]
      .find((b: HTMLButtonElement) => b.textContent === "View logs")!
      .click();
    await until(() => !!finish);
    const stored = fixtureOwnerReceipt(fixtureState("receipts").reviews[2]);
    review.receipt = fixtureReceipt("running");
    draw();
    finish(stored);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(root.querySelector(".receipt-logs"), null);
  } finally {
    flushSync(() => react.unmount());
    dom.window.close();
  }
});

test("owner receipt and settings calls encode IDs, preserve session safeguards, and never retry", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const transport = createHttpTransport({
    origin,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ error: "Receipt not found." }, { status: 404 });
    },
  });
  await assert.rejects(transport.getReceipt!("a/b", "r/id"), /Receipt not found/);
  await assert.rejects(
    transport.setSettings!("a/b", { requireReceipt: false }),
    /Receipt not found/,
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${origin}/projects/a%2Fb/reviews/r%2Fid/receipt`);
  for (const request of requests) {
    assert.equal(request.init!.credentials, "same-origin");
    assert.equal(request.init!.cache, "no-store");
    assert.equal(request.init!.redirect, "error");
  }
  assert.equal(requests[1].init!.method, "PATCH");
  assert.equal(requests[1].init!.body, '{"requireReceipt":false}');
  assert.deepEqual(requests[1].init!.headers, { "Content-Type": "application/json" });
});

test("receipt completion announces once after an observed running state", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector("#reviews"));
    const live = c.root.querySelector<HTMLElement>('.sr-only[aria-live="polite"]')!;
    assert.equal(live.textContent, "");
    c.wire.reviews[0].receipt = fixtureReceipt("passed");
    c.wire.reviews[0].receiptDigest = c.wire.reviews[0].receipt.digest;
    await c.app.refresh();
    await until(() => live.textContent!.includes("Checks passed for ui-01"));
    let mutations = 0;
    const observer = new c.dom.window.MutationObserver(() => mutations++);
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    await c.app.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mutations, 0, "identical snapshots don't repeat the announcement");
    observer.disconnect();
  } finally {
    c.close();
  }
});

test("approved before-promote outcomes distinguish failed code from an interrupted run", async () => {
  const wire = fixtureState("gating-recheck");
  const state = stateView(wire);
  const running = state.reviews[1];
  assert.equal(running.status, "approved");
  assert.equal(receiptGateCaption(running, true), "");
  const failed = state.reviews[2];
  assert.equal(reviewGate(failed, state).promote, false);
  assert.equal(receiptGateCaption(failed, true), "Checks failed. The agent must push a fix.");
  for (const index of [4, 5]) {
    assert.equal(reviewGate(state.reviews[index], state).promote, true);
    assert.equal(receiptGateCaption(state.reviews[index], true), "Promote runs the checks again.");
  }
  state.project.settings!.requireReceipt = false;
  assert.equal(
    reviewGate(failed, state).promote,
    true,
    "advisory mode never gates on a failed run",
  );
  const c = setup("gating-recheck");
  try {
    await until(() => !!c.root.querySelector("#reviews"));
    const rows = [...c.root.querySelectorAll(".review-card")];
    assert.match(rows[1].textContent!, /Approved/);
    assert.doesNotMatch(rows[1].textContent!, /Waiting for checks/);
    assert.match(rows[1].textContent!, /Re-checking/);
    assert.equal(rows[1].querySelector('[data-action="promote"]'), null);
    assert.equal(rows[2].querySelector('[data-action="promote"]'), null);
    assert.ok(rows[4].querySelector('[data-action="promote"]'));
    assert.match(rows[4].textContent!, /Promote runs the checks again/);
    assert.equal(rows[6].querySelectorAll(".state-reason").length, 1);
    assert.equal((rows[6].textContent!.match(/Waiting for checks\./g) ?? []).length, 1);
    assert.match(rows[6].querySelector(".column-receipts")!.textContent!, /Not started/);
  } finally {
    c.close();
  }
});

test("recent receipts retain promoted summaries, sort by receipt time and cap at five without changing the queue", () => {
  for (const id of ["history-required", "history-advisory"]) {
    const state = stateView(fixtureState(id));
    const order = state.reviews.map((r) => r.id);
    const history = recentReceipts(state);
    assert.deepEqual(
      history.map((r) => r.id),
      ["promoted-6", "promoted-5", "promoted-4", "promoted-3", "promoted-2"],
    );
    assert.ok(history.every((r) => r.status === "promoted"));
    assert.deepEqual(
      state.reviews.map((r) => r.id),
      order,
      "source order stays intact",
    );
    assert.equal(history[0].receipt.status, id === "history-required" ? "passed" : "failed");
    const running = state.reviews[0];
    running.receipt!.startedAt = "2026-10-12T02:00:00Z";
    assert.equal(
      recentReceipts(state)[0].id,
      running.id,
      "unfinished receipts order by their actual start",
    );
    for (const review of state.reviews) review.receipt = null;
    assert.deepEqual(recentReceipts(state), []);
  }
});

test("last promotion binds exact ledger review, SHA and digest, including advisory failures", () => {
  const state = stateView(fixtureState("history-advisory"));
  const entry = state.ledger.at(-1)!;
  assert.equal(entry.receiptDigest, fixtureState("history-advisory").ledger.at(-1)!.receiptDigest);
  const matching = promotionReceipt(state, entry)!;
  assert.equal(matching.id, "promoted-6");
  assert.equal(matching.receipt!.status, "failed");
  for (const change of [
    { receiptDigest: null },
    { receiptDigest: undefined },
    { receiptDigest: "9".repeat(64) },
    { review: "missing" },
    { sha: "9".repeat(40) },
  ]) {
    assert.equal(promotionReceipt(state, { ...entry, ...change }), undefined);
  }
  matching.receipt = { ...matching.receipt!, status: "running" };
  assert.equal(promotionReceipt(state, entry), undefined);
  matching.receipt = null;
  assert.equal(promotionReceipt(state, entry), undefined);
});

test("promoted history and Last promotion open the same receipt with owner-only escaped logs", async () => {
  for (const id of ["history-required", "history-advisory"]) {
    const c = setup(id);
    try {
      await until(() => c.root.querySelectorAll(".receipt-history-row").length === 5);
      assert.equal(c.root.querySelectorAll(".review-card").length, 7);
      const rows = [...c.root.querySelectorAll<HTMLButtonElement>(".receipt-history-link")];
      assert.match(rows[0].closest("tr")!.textContent!, /history-6.*7777777/);
      assert.match(rows[0].closest("tr")!.textContent!, /3 checks · 41 s/);
      assert.match(
        rows[0].closest("tr")!.textContent!,
        id === "history-required" ? /Before promote/ : /On review/,
      );
      assert.ok(rows[0].closest("tr")!.querySelector("time"));
      rows[0].focus();
      rows[0].click();
      await until(
        () => c.root.querySelector(".receipt-details")?.textContent?.includes("history-6") === true,
      );
      [...c.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "View logs")!
        .click();
      await until(() => !!c.root.querySelector(".receipt-logs"));
      assert.equal(c.calls.filter((call) => call.path.endsWith("/receipt")).length, 1);
      assert.match(c.calls.at(-1)!.path, /reviews\/promoted-6\/receipt$/);
      assert.equal(c.root.querySelector(".receipt-logs script"), null);
      assert.match(
        c.root.querySelector(".receipt-logs")!.textContent!,
        /<script>fixture<\/script>/,
      );
      c.root.querySelector<HTMLButtonElement>(".promotion-receipt")!.click();
      await until(
        () => c.root.querySelector(".receipt-details")?.textContent?.includes("history-6") === true,
      );
      assert.match(
        c.root.querySelector(".promotion-receipt")!.textContent!,
        id === "history-required" ? /Passed/ : /Failed/,
      );
      c.wire.ledger.at(-1)!.receiptDigest = "0".repeat(64);
      await c.app.refresh();
      await until(() => !c.root.querySelector(".promotion-receipt"));
    } finally {
      c.close();
    }
    const agent = setup(id, false);
    try {
      await until(() => !!agent.root.querySelector(".receipt-history-row"));
      agent.root.querySelector<HTMLButtonElement>(".receipt-history-link")!.click();
      await until(() => !!agent.root.querySelector(".receipt-details"));
      assert.doesNotMatch(agent.root.textContent!, /View logs|Hide logs/);
      assert.equal(
        agent.calls.some((call) => call.path.endsWith("/receipt")),
        false,
      );
    } finally {
      agent.close();
    }
  }
});

test("empty history is honest even while receipt-free reviews exist", async () => {
  const c = setup("quiet");
  try {
    await until(() => !!c.root.querySelector("#recent-receipts"));
    assert.equal(c.root.querySelector("#recent-receipts p")!.textContent, "No receipts yet.");
    assert.equal(c.root.querySelector(".receipt-history-row"), null);
  } finally {
    c.close();
  }
});

test("receipt duration hours and relative time boundaries use singular days and whole hours", () => {
  for (const [milliseconds, expected] of [
    [3_599_499, "59 min 59 s"],
    [3_599_500, "1 hr"],
    [3_600_000, "1 hr"],
    [3_660_000, "1 hr 1 min"],
    [5_040_000, "1 hr 24 min"],
    [86_400_000, "24 hr"],
  ] as const)
    assert.equal(duration(milliseconds), expected);
  const start = "2026-10-12T00:00:00Z";
  const epoch = Date.parse(start);
  assert.equal(relativeTime(start, epoch + 60_000), "1 min ago");
  assert.equal(relativeTime(start, epoch + 3_600_000), "1 hr ago");
  assert.equal(relativeTime(start, epoch + 86_400_000), "1 day ago");
  assert.equal(relativeTime(start, epoch + 172_800_000), "2 days ago");
  assert.equal(relativeTime(start, epoch + 86_400_000, "hour"), "24 hr ago");
});

test("history has the queue's table headers, a packet control per row, and long-running relative copy", async () => {
  const c = setup("history-required");
  try {
    await until(() => c.root.querySelectorAll(".receipt-history-row").length === 5);
    assert.deepEqual(
      [...c.root.querySelectorAll("#recent-receipts th")].map((h) => h.textContent),
      ["Packet", "Head", "Outcome", "Checks", "Trigger", "Finished"],
    );
    assert.equal(c.root.querySelectorAll(".receipt-history-link").length, 5);
    assert.equal(c.root.querySelector(".last-promotion-sha")!.tagName, "CODE");
    assert.equal(c.root.querySelector(".last-promotion-sha")!.textContent, "7777777");
    assert.match(
      c.root.querySelector(".review-card .receipt-cell")!.textContent!,
      /Started \d+ hr ago/,
    );
    assert.doesNotMatch(c.root.textContent!, /1 days ago|Started \d{3,} min/);
    c.root.querySelectorAll<HTMLElement>(".receipt-history-row")[1].click();
    await until(
      () => c.root.querySelector(".receipt-details")?.textContent?.includes("history-5") === true,
    );
  } finally {
    c.close();
  }
});
