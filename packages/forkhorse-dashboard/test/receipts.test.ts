import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { receiptGateCaption, reviewGate, stateView } from "../src/model.ts";
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
      "Waiting for checks.",
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
  advisory.reviews[3].approval!.receiptDigest = null;
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
    c.root.querySelector<HTMLButtonElement>('[data-action="promote"]')!.click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    assert.match(c.dom.window.document.body.textContent!, /Checks run again/);
    c.dom.window.document.querySelector('[data-action="confirm-promote"]').click();
    await until(() => c.dom.window.document.body.textContent!.includes("Nothing was promoted."));
    assert.ok(c.dom.window.document.querySelector(".promotion-dialog"));
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
