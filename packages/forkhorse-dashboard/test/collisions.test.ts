import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { blockerView, collisionHistory, reviewGate, stateView } from "../src/model.ts";
import { ownerNeeds, copyText } from "../src/needs-you-model.ts";
import { packetStatus } from "../src/view.tsx";
import { createHttpTransport } from "../src/transport.ts";
import { collisionFixtureState } from "./collision-fixtures.ts";
import { reviewFixtureDetail } from "./review-fixtures.ts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture product", tagline: "Offline fixture" };
const origin = "https://fixture.idiot.tax";

test("wire resolution, legacy fallback and pushing-fork gate share one contract", () => {
  const wire = collisionFixtureState();
  const open = wire.blockers[0];
  for (const resolution of [
    undefined,
    null,
    { at: "2026-10-13T14:02:00Z", by: "owner" as const, reason: "Settled" },
  ]) {
    open.resolved = resolution;
    const state = stateView(wire);
    const [pusher, claimant] = state.reviews;
    assert.equal(state.blockers[0].resolved, resolution != null);
    assert.equal(reviewGate(pusher, state).approve, resolution != null);
    assert.equal(reviewGate(claimant, state).approve, true);
    assert.equal(packetStatus(claimant.packet, state).label, "In review");
    assert.equal(packetStatus(pusher.packet, state).label, resolution ? "In review" : "Blocked");
    assert.equal(
      ownerNeeds(state, brand).filter((i) => i.kind === "blocker").length,
      resolution ? 0 : 1,
    );
  }
  open.resolved = null;
  const state = stateView(wire);
  const review = state.reviews[0];
  assert.equal(reviewGate({ ...review, packet: "another-packet" }, state).approve, true);
  state.blockers[0].pushingPacket = null;
  assert.equal(reviewGate({ ...review, packet: "another-packet" }, state).approve, false);
  assert.match(reviewGate(review, state, false).reason, /Waiting for the owner/);
  assert.doesNotMatch(reviewGate(review, state, false).reason, /Mark the collision/);
  const need = ownerNeeds(state, brand).find((n) => n.kind === "blocker")!;
  assert.match(copyText(need.outcome), /reviews from/);
  assert.deepEqual(need.target, { packet: "claimant-packet", collision: "collision-1" });
});

test("history sorts open by real push times, legacy stably, then resolved by resolution time", () => {
  const state = stateView(collisionFixtureState("collision-history"));
  const open = state.blockers[0];
  const blockers = [
    ...state.blockers,
    { ...open, id: "legacy-1", at: null },
    { ...open, id: "newer", at: "2026-10-13T14:02:00Z" },
    { ...open, id: "legacy-2", at: null },
  ];
  assert.deepEqual(
    collisionHistory(blockers).map((b) => b.id),
    [
      "newer",
      "collision-1",
      "legacy-1",
      "legacy-2",
      "resolved-owner",
      "resolved-release",
      "resolved-promote",
    ],
  );
  assert.equal(blockerView({ ...collisionFixtureState().blockers[0], at: undefined }).at, null);
});

async function until(check: () => unknown) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Collision DOM did not settle");
}
function setup({
  owner = true,
  scenario = "collision-open",
  route = "work",
  outcome = "owner",
  detailMode = "complete",
}: {
  detailMode?: "complete" | "omitted" | "stale";
  owner?: boolean;
  scenario?: string;
  route?: string;
  outcome?: "owner" | "release" | "promote" | "missing" | "error";
} = {}) {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: `${origin}/#${route}` });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const wire = collisionFixtureState(scenario);
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport = createHttpTransport({
    origin,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, init });
      if (path.endsWith("/state")) return Response.json(wire);
      if (path.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
      if (path.endsWith("/resolve")) {
        if (outcome === "missing") {
          wire.blockers = [];
          return Response.json({ error: "private raw error" }, { status: 404 });
        }
        if (outcome === "error")
          return Response.json({ error: "private raw error" }, { status: 503 });
        const blocker = wire.blockers[0];
        blocker.resolved = {
          at: "2026-10-13T14:05:00Z",
          by: outcome,
          ...(outcome === "owner" ? { reason: JSON.parse(String(init!.body)).reason } : {}),
        };
        return Response.json({ blocker });
      }
      const review = wire.reviews.find((r) => path.endsWith(`/${r.id}`))!;
      return Response.json({
        ...reviewFixtureDetail({ ...wire, reviews: [review] }),
        blockers:
          detailMode === "omitted"
            ? []
            : detailMode === "stale"
              ? wire.blockers.map((b) => ({ ...b, resolved: null }))
              : wire.blockers.filter((b) => b.packet === review.packet),
        packet: wire.packets.find((p) => p.id === review.packet)!,
      });
    },
  });
  const app = mountDashboard(root, {
    brand,
    fixture: true,
    owner,
    initialProject: scenario,
    transport,
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
function fill(c: ReturnType<typeof setup>, value: string) {
  const textarea = c.dom.window.document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(c.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value,
  );
  textarea.dispatchEvent(new c.dom.window.Event("input", { bubbles: true }));
}
async function openDialog(c: ReturnType<typeof setup>) {
  await until(() => c.root.querySelector('[aria-label^="Mark resolved:"]'));
  const control = c.root.querySelector('[aria-label^="Mark resolved:"]') as HTMLButtonElement;
  control.focus();
  control.click();
  await until(() => c.dom.window.document.querySelector("textarea"));
}

test("owner dialog enforces reason, focuses input, posts once and refreshes counts, gate and history", async () => {
  const c = setup();
  try {
    await openDialog(c);
    const doc = c.dom.window.document;
    const primary = () => doc.querySelector('[data-action="confirm-resolve"]') as HTMLButtonElement;
    assert.equal(primary().disabled, true);
    await until(() => doc.activeElement?.textContent === "Coordinated: both changes can land.");
    const quickReasons = [...doc.querySelectorAll('[aria-label="Quick reasons"] button')];
    assert.equal(quickReasons.length, 3);
    for (const button of quickReasons) {
      assert.match(button.className, /ring-kumo-line/);
      assert.match(button.className, /bg-kumo-base/);
    }
    fill(c, " \n ");
    await until(() => primary().disabled);
    fill(c, "x".repeat(200));
    await until(() => !primary().disabled);
    fill(c, "x".repeat(201));
    await until(() => primary().disabled);
    fill(c, "Agreed.\n<script>plain text</script>");
    await until(() => !primary().disabled);
    assert.match(doc.querySelector('[role="dialog"]')!.textContent!, /35 \/ 200/);
    primary().click();
    await until(() => !doc.querySelector(".collision-dialog"));
    assert.equal(c.root.querySelector("#blockers"), null);
    assert.match(doc.body.textContent!, /Marked resolved: pushing-packet is unblocked/);
    assert.doesNotMatch(c.root.querySelector("#packets")!.textContent!, /Blocked/);
    const writes = c.calls.filter((call) => call.init?.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/projects/collision-open/blockers/collision-1/resolve");
    assert.equal(writes[0].init?.credentials, "same-origin");
    assert.equal(writes[0].init?.redirect, "error");
    assert.equal(
      JSON.parse(String(writes[0].init?.body)).reason,
      "Agreed.\n<script>plain text</script>",
    );
    await c.app.refresh();
    assert.equal(reviewGate(stateView(c.wire).reviews[0], stateView(c.wire)).approve, true);
    assert.equal(
      ownerNeeds(stateView(c.wire), brand).some((n) => n.kind === "blocker"),
      false,
    );
  } finally {
    c.close();
  }
});

test("safe error dialog survives refresh; 404 hides primary and focuses Close", async () => {
  for (const outcome of ["missing", "error"] as const) {
    const c = setup({ outcome });
    try {
      await openDialog(c);
      fill(c, "Settled");
      await until(
        () =>
          !(
            c.dom.window.document.querySelector(
              '[data-action="confirm-resolve"]',
            ) as HTMLButtonElement
          ).disabled,
      );
      (
        c.dom.window.document.querySelector('[data-action="confirm-resolve"]') as HTMLButtonElement
      ).click();
      await until(() => c.dom.window.document.querySelector('[role="dialog"] [role="alert"]'));
      const dialog = c.dom.window.document.querySelector('[role="dialog"]')!;
      assert.match(
        dialog.textContent!,
        outcome === "missing"
          ? /This collision doesn't exist anymore/
          : /Couldn't mark it resolved. Try again/,
      );
      assert.doesNotMatch(dialog.textContent!, /private raw error/);
      assert.equal(
        !!dialog.querySelector('[data-action="confirm-resolve"]'),
        outcome !== "missing",
      );
      assert.equal(c.calls.filter((call) => call.init?.method === "POST").length, 1);
      assert.ok(c.calls.filter((call) => call.path.endsWith("/state")).length >= 2);
      if (outcome === "missing")
        await until(() => c.dom.window.document.activeElement?.textContent === "Close");
    } finally {
      c.close();
    }
  }
});

test("idempotent race toast uses core's release/promote cause", async () => {
  for (const outcome of ["release", "promote"] as const) {
    const c = setup({ outcome });
    try {
      await openDialog(c);
      fill(c, "Settled");
      await until(
        () =>
          !(
            c.dom.window.document.querySelector(
              '[data-action="confirm-resolve"]',
            ) as HTMLButtonElement
          ).disabled,
      );
      (
        c.dom.window.document.querySelector('[data-action="confirm-resolve"]') as HTMLButtonElement
      ).click();
      await until(() => c.dom.window.document.body.textContent.includes("was already unblocked"));
      assert.match(
        c.dom.window.document.body.textContent,
        outcome === "release" ? /claim was released/ : /claim was promoted/,
      );
    } finally {
      c.close();
    }
  }
});

test("agent has no resolve controls; claimant review has Approve and no banner; review and packet retain quiet history", async () => {
  for (const owner of [true, false]) {
    const c = setup({ owner, scenario: "collision-history", route: "review/review-1" });
    try {
      await until(() => c.root.querySelector(".review-detail .collision-row"));
      assert.equal(c.root.querySelectorAll(".review-detail .collision-row").length, 3);
      assert.equal(!!c.root.querySelector('[aria-label^="Mark resolved:"]'), owner);
      assert.equal(c.root.querySelector("script"), null);
      assert.match(c.root.textContent!, /<script>plain text<\/script>/);
      assert.match(c.root.textContent!, owner ? /by you/ : /by the owner/);
      const packetButton = [...c.root.querySelectorAll("button")].find(
        (b) => b.textContent === "View packet",
      )!;
      packetButton.click();
      await until(() => c.root.querySelector('[aria-label="Collisions"] .collision-row'));
      assert.equal(c.root.querySelectorAll('[aria-label="Collisions"] .collision-row').length, 4);
    } finally {
      c.close();
    }
  }
  const c = setup({ route: "review/claimant-review" });
  try {
    await until(() => c.root.querySelector('.review-detail [data-action="approve"]'));
    assert.equal(c.root.querySelector(".review-detail .blockers"), null);
  } finally {
    c.close();
  }
});

test("snapshot blockers survive omitted detail and newer resolved snapshot wins over stale open detail", async () => {
  for (const detailMode of ["omitted", "stale"] as const) {
    const c = setup({ route: "review/review-1", detailMode });
    try {
      if (detailMode === "stale") {
        c.wire.blockers[0].resolved = { at: "2026-10-13T14:05:00Z", by: "release" };
        await until(() => c.root.querySelector(".review-milestones"));
        await c.app.refresh();
        await until(() => c.root.querySelector('.review-detail [data-action="approve"]'));
        assert.equal(
          c.root.querySelector(".review-detail .blockers [aria-label^='Mark resolved:']"),
          null,
        );
        assert.match(c.root.querySelector(".review-detail")!.textContent!, /Resolved/);
      } else {
        await until(() => c.root.querySelector('.review-detail [aria-label^="Mark resolved:"]'));
        assert.equal(c.root.querySelector('.review-detail [data-action="approve"]'), null);
      }
    } finally {
      c.close();
    }
  }
});

test("Needs you focuses the collision, quick reasons only fill, keyboard submits once and success offers review", async () => {
  const c = setup({ route: "overview" });
  try {
    await until(() => c.root.querySelector('.needs-you-row[aria-label^="Sort out"]'));
    (c.root.querySelector('.needs-you-row[aria-label^="Sort out"]') as HTMLButtonElement).click();
    await until(() => c.dom.window.document.activeElement?.closest(".collision-highlight"));
    const control = c.dom.window.document.activeElement as HTMLButtonElement;
    assert.match(control.getAttribute("aria-label")!, /^Mark resolved/);
    assert.equal(c.dom.window.location.hash, "#work");
    control.click();
    await until(() => c.dom.window.document.querySelector(".collision-dialog"));
    const doc = c.dom.window.document;
    await until(() => doc.activeElement?.textContent === "Coordinated: both changes can land.");
    (doc.activeElement as HTMLButtonElement).click();
    await until(() => doc.activeElement === doc.querySelector("textarea"));
    assert.equal(
      (doc.querySelector("textarea") as HTMLTextAreaElement).value,
      "Coordinated: both changes can land.",
    );
    assert.equal(
      c.calls.some((call) => call.init?.method === "POST"),
      false,
    );
    fill(c, "Coordinated and checked.");
    await until(() => doc.querySelector(".collision-dialog")?.textContent?.includes("24 / 200"));
    doc
      .querySelector("textarea")!
      .dispatchEvent(
        new c.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter", ctrlKey: true }),
      );
    await until(() => !doc.querySelector(".collision-dialog"));
    await until(() => doc.activeElement?.classList.contains("collision-heading"));
    assert.equal(c.calls.filter((call) => call.init?.method === "POST").length, 1);
    assert.ok(c.root.querySelector('[aria-label="Collisions"] .claim-link'));
    assert.ok([...doc.querySelectorAll("button")].some((b) => b.textContent === "Open review"));
  } finally {
    c.close();
  }
});

test("Escape cancels with no write and dialog evidence shows five paths plus full-list tooltip", async () => {
  const c = setup();
  try {
    await until(() => c.root.querySelector("#packets"));
    c.wire.blockers[0].paths = Array.from({ length: 7 }, (_, i) => `src/overlap-${i}.ts`);
    await c.app.refresh();
    await openDialog(c);
    const doc = c.dom.window.document;
    assert.equal(doc.querySelectorAll(".collision-evidence code").length, 5);
    assert.match(doc.querySelector(".collision-evidence")!.textContent!, /\+2 more/);
    doc.activeElement!.dispatchEvent(
      new c.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    await until(() => !doc.querySelector(".collision-dialog"));
    assert.equal(
      c.calls.some((call) => call.init?.method === "POST"),
      false,
    );
    await until(() => doc.activeElement?.getAttribute("aria-label")?.startsWith("Mark resolved"));
  } finally {
    c.close();
  }
});

test("packet history offers Open review only once on the newest resolved row and removes it when the review ceases to be current", async () => {
  const c = setup({ scenario: "collision-history", route: "work" });
  try {
    await until(() => c.root.querySelector("#blockers"));
    (
      [...c.root.querySelectorAll("button")].find(
        (button) => button.textContent === "View packet",
      ) as HTMLButtonElement
    ).click();
    await until(() => c.root.querySelector('[aria-label="Collisions"] .claim-link'));
    const panel = () => c.root.querySelector('[aria-label="Collisions"]')!;
    const links = () =>
      [...panel().querySelectorAll("button")].filter(
        (button) => button.textContent === "Open review",
      );
    assert.equal(panel().querySelectorAll(".collision-row").length, 4);
    assert.equal(links().length, 1);
    assert.equal(
      links()[0].closest("[data-collision]")?.getAttribute("data-collision"),
      "resolved-owner",
    );
    // Date order, not input order or the currently highlighted open row, selects the link.
    c.wire.blockers.find((blocker) => blocker.id === "resolved-release")!.resolved!.at =
      "2026-10-13T15:00:00Z";
    await c.app.refresh();
    assert.equal(links().length, 1);
    assert.equal(
      links()[0].closest("[data-collision]")?.getAttribute("data-collision"),
      "resolved-release",
    );
    const review = c.wire.reviews[0];
    review.returned = { at: "2026-10-13T15:01:00Z", reason: "Fix before returning" };
    await c.app.refresh();
    assert.equal(links().length, 0);
    review.returned = null;
    c.wire.forks.find((fork) => fork.repoName === review.repoName)!.head = "9".repeat(40);
    await c.app.refresh();
    assert.equal(links().length, 0);
    c.wire.forks = c.wire.forks.filter((fork) => fork.repoName !== review.repoName);
    await c.app.refresh();
    assert.equal(links().length, 0);
    c.wire.reviews = c.wire.reviews.filter((entry) => entry.id !== review.id);
    await c.app.refresh();
    assert.equal(links().length, 0);
  } finally {
    c.close();
  }
});
