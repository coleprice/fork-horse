import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { reviewGate, stateView } from "../src/model.ts";
import { reviewFixtureState, reviewFixtureDetail, reviewFixtureDiff } from "./review-fixtures.ts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://fixture.idiot.tax";
async function until(fn: () => unknown) {
  for (let i = 0; i < 250; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Review DOM did not settle");
}
function setup(
  scenario = "review-current",
  owner = true,
  route = "#review/review-1",
  overrides: {
    detail?: () => Promise<Response>;
    diff?: () => Promise<Response>;
    returning?: () => Promise<Response>;
    noDetail?: boolean;
    noDiff?: boolean;
  } = {},
) {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: `${origin}/${route}` });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const wire = reviewFixtureState(scenario);
  const calls: { url: URL; init?: RequestInit }[] = [];
  const transport = createHttpTransport({
    origin,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname.endsWith("/state")) return Response.json(wire);
      if (url.pathname.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
      if (url.pathname.endsWith("/diff"))
        return overrides.diff
          ? overrides.diff()
          : url.searchParams.get("path") === "missing.txt"
            ? Response.json({ error: "missing" }, { status: 404 })
            : Response.json(reviewFixtureDiff(url.searchParams.get("path")!));
      if (url.pathname.endsWith("/return")) {
        if (overrides.returning) return overrides.returning();
        wire.reviews[0].returned = {
          reason: JSON.parse(String(init!.body)).reason,
          at: "2026-10-13T08:00:00Z",
        };
        return Response.json({ review: wire.reviews[0] });
      }
      if (url.pathname.endsWith("/approve")) {
        wire.reviews[0].approval = {
          sha: wire.reviews[0].sha,
          receiptDigest: wire.reviews[0].receiptDigest,
        };
        return Response.json({ review: wire.reviews[0] });
      }
      if (url.pathname.endsWith("/receipt"))
        return Response.json({ error: "fixture logs" }, { status: 404 });
      return overrides.detail
        ? overrides.detail()
        : scenario === "review-not-found"
          ? Response.json({ error: "missing" }, { status: 404 })
          : Response.json(reviewFixtureDetail(wire));
    },
  });
  if (overrides.noDetail) delete transport.getReview;
  if (overrides.noDiff) delete transport.getDiff;
  const app = mountDashboard(root, {
    brand: { name: "Fixture product", tagline: "Fixture" },
    fixture: true,
    owner,
    agent: "fixture-agent",
    initialProject: scenario,
    transport,
  });
  return {
    dom,
    root,
    wire,
    calls,
    app,
    transport,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}
function button(c: ReturnType<typeof setup>, text: string, dialog = false): HTMLButtonElement {
  return [...(dialog ? c.dom.window.document : c.root).querySelectorAll("button")].find(
    (b: HTMLButtonElement) => b.textContent === text,
  )!;
}
function fill(c: ReturnType<typeof setup>, value: string) {
  const element = c.dom.window.document.querySelector("textarea") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(c.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new c.dom.window.Event("input", { bubbles: true }));
}

test("hosts without detail capability keep non-linking queue rows and resolve bookmarked or typed detail hashes to the queue", async () => {
  for (const route of ["#review", "#review/review-1"]) {
    const c = setup("review-current", true, route, { noDetail: true });
    try {
      await until(() => c.root.querySelector(".review-card"));
      assert.equal(c.dom.window.location.hash, "#review");
      assert.equal(!!c.root.querySelector(".review-detail"), false);
      assert.equal(!!c.root.querySelector(".review-card .claim-link"), false);
      assert.equal(!!c.root.querySelector('.review-card a[href*="#review/"]'), false);
      const row = c.root.querySelector<HTMLElement>(".review-card")!;
      row.click();
      row.querySelector<HTMLElement>("td span")!.click();
      assert.equal(c.dom.window.location.hash, "#review");
      c.dom.window.location.hash = "#review/review-1";
      await until(() => c.dom.window.location.hash === "#review");
      assert.equal(!!c.root.querySelector("#reviews"), true);
      assert.equal(
        c.calls.some((call) => call.url.pathname.endsWith("/reviews/review-1")),
        false,
      );
    } finally {
      c.close();
    }
  }
});

test("missing diff capability uses product copy and missing receipt/ledger evidence stays plain", async () => {
  const c = setup("review-promoted", true, "#review/review-1", {
    noDiff: true,
    detail: async () => {
      const detail = reviewFixtureDetail(c.wire);
      detail.review.receipt = null;
      detail.promotion = null;
      return Response.json(detail);
    },
  });
  try {
    await until(() => c.root.querySelector(".review-file-toggle"));
    assert.match(c.root.textContent!, /No receipt/);
    assert.equal(
      c.root.querySelectorAll(".review-milestone")[0].textContent!.match(/No receipt/g)?.length,
      1,
    );
    assert.match(c.root.textContent!, /No ledger entry recorded\./);
    c.root.querySelector<HTMLButtonElement>(".review-file-toggle")!.click();
    await until(() => c.root.textContent!.includes("Couldn't load this diff."));
    assert.doesNotMatch(
      c.root.querySelector(".review-detail")!.textContent!,
      /host adapter|unavailable/,
    );
    assert.equal(
      c.calls.some((call) => call.url.pathname.endsWith("/diff")),
      false,
    );
  } finally {
    c.close();
  }
});

test("detail route replaces queue, retains activity, three independent evidence cells and request list", async () => {
  const c = setup();
  try {
    await until(() => c.root.querySelector(".review-milestones"));
    assert.equal(c.root.querySelector("#reviews"), null);
    assert.equal(c.root.querySelectorAll(".review-milestone").length, 3);
    assert.match(c.root.textContent!, /Checks passed.*Not approved yet.*Not promoted yet/s);
    assert.match(
      c.root.querySelectorAll(".review-milestone")[2].textContent!,
      /No promotion recorded\./,
    );
    assert.ok(c.root.querySelector(".review-acceptance li"));
    assert.match(
      c.root.querySelector(".plain-text")!.textContent!,
      /request and inspect each claim\.\nKeep/,
    );
    assert.ok(c.root.querySelector("#activity-panel"));
    assert.ok(button(c, "Approve"));
    assert.ok(button(c, "Return to agent"));
    assert.equal(c.root.querySelector('[data-variant="primary"]'), null);
    button(c, "← Review queue").click();
    await until(() => c.root.querySelector("#reviews"));
    assert.equal(c.dom.window.location.hash, "#review");
    c.root.querySelector<HTMLButtonElement>(".review-card .claim-link")!.click();
    await until(() => c.root.querySelector(".review-milestones"));
    assert.equal(c.dom.window.location.hash, "#review/review-1");
    c.dom.window.history.back();
    await until(() => c.root.querySelector("#reviews"));
  } finally {
    c.close();
  }
});

test("return required labelled reason, counter, escaped multiline owner and agent view, never approve returned", async () => {
  const c = setup();
  try {
    await until(() => button(c, "Return to agent"));
    button(c, "Return to agent").click();
    await until(() => c.dom.window.document.querySelector("textarea"));
    const confirm = c.dom.window.document.querySelector('[data-action="confirm-return"]')!;
    assert.equal(confirm.disabled, true);
    assert.equal(
      c.dom.window.document.querySelector("label[for=return-reason]")!.textContent,
      "What needs to change?",
    );
    assert.equal(
      c.dom.window.document.querySelector("textarea")!.hasAttribute("placeholder"),
      false,
    );
    await until(() => c.dom.window.document.activeElement?.tagName === "TEXTAREA");
    fill(c, "Fix <script>plain</script>\nSecond line");
    await until(() => !confirm.disabled);
    assert.equal(
      c.dom.window.document.getElementById("return-counter")!.textContent,
      `${"Fix <script>plain</script>\nSecond line".length} / 2000`,
    );
    confirm.click();
    confirm.click();
    await until(() => c.root.querySelector(".returned-reason"));
    assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/return")).length, 1);
    assert.equal(c.root.querySelector(".returned-reason script"), null);
    assert.equal(
      c.root.querySelector(".returned-reason .plain-text")!.textContent,
      "Fix <script>plain</script>\nSecond line",
    );
    assert.equal(c.root.querySelector('[data-action="approve"]'), null);
    assert.equal(c.root.querySelector('[data-action="promote"]'), null);
    assert.equal(c.root.querySelector('[data-action="return"]'), null);
    button(c, "← Review queue").click();
    await until(() => c.root.querySelector(".returned-preview"));
    assert.match(c.root.querySelector(".review-card")!.textContent!, /Returned/);
    assert.equal(
      c.root.querySelector(".returned-preview")!.textContent,
      "Fix <script>plain</script>",
    );
    const state = stateView(c.wire);
    assert.equal(reviewGate(state.reviews[0], state).approve, false);
  } finally {
    c.close();
  }
  const agent = setup("review-returned", false);
  try {
    await until(() => agent.root.querySelector(".returned-reason"));
    assert.equal(agent.root.querySelector('[data-action="return"]'), null);
    assert.equal(agent.root.querySelector('[data-action="approve"]'), null);
    assert.match(
      agent.root.querySelector(".returned-reason")!.textContent!,
      /<script>plain text<\/script>/,
    );
    button(agent, "Open receipt").click();
    await until(() => agent.root.querySelector(".receipt-details"));
    assert.doesNotMatch(agent.root.querySelector(".receipt-details")!.textContent!, /View logs/);
    assert.equal(
      agent.calls.some((r) => r.url.pathname.endsWith("/receipt")),
      false,
    );
  } finally {
    agent.close();
  }
});

test("return 409 focuses Close with a read-only reason and refetches authoritative promotion or return; uncertain writes are never retried", async () => {
  for (const race of ["promoted", "returned", "network"] as const) {
    const c = setup("review-current", true, "#review/review-1", {
      returning: async () => {
        if (race === "network") throw new Error("connection closed");
        if (race === "promoted") c.wire.reviews[0].promoted = true;
        else
          c.wire.reviews[0].returned = {
            reason: "Other tab returned this review",
            at: "2026-10-13T08:00:00Z",
          };
        return Response.json({ error: "Review promoted." }, { status: 409 });
      },
    });
    try {
      await until(() => button(c, "Return to agent"));
      button(c, "Return to agent").click();
      await until(() => c.dom.window.document.querySelector("textarea"));
      fill(c, "Fix");
      await until(
        () => !c.dom.window.document.querySelector('[data-action="confirm-return"]')!.disabled,
      );
      c.dom.window.document.querySelector('[data-action="confirm-return"]')!.click();
      await until(() => c.dom.window.document.querySelector(".return-dialog [role=alert]"));
      assert.equal(c.dom.window.document.querySelectorAll('[role="alert"]').length, 1);
      assert.ok(c.dom.window.document.querySelector(".return-dialog [role=alert] svg"));
      assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/return")).length, 1);
      assert.match(
        c.dom.window.document.querySelector(".return-dialog [role=alert]")!.textContent!,
        /This review was promoted, so it can.t be returned\.|Couldn.t return this review/,
      );
      assert.doesNotMatch(c.root.textContent!, /Review promoted\./);
      if (race !== "network") {
        await until(() => c.dom.window.document.activeElement?.textContent === "Close");
        assert.equal(
          !!c.dom.window.document.querySelector('[data-action="confirm-return"]'),
          false,
        );
        const reason = c.dom.window.document.querySelector("textarea");
        assert.equal(reason.value, "Fix");
        assert.equal(reason.readOnly, true);
        await until(() =>
          c.root.textContent!.includes(
            race === "promoted" ? "Promoted to main" : "Other tab returned this review",
          ),
        );
        assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/state")).length >= 2, true);
        assert.equal(
          c.calls.filter((r) => r.url.pathname.endsWith("/reviews/review-1")).length >= 2,
          true,
        );
      }
    } finally {
      c.close();
    }
  }
});

test("diffs are lazy, several expand, text escaped, binary and truncated and 404 explicit", async () => {
  const c = setup("review-changes");
  try {
    await until(() => c.root.querySelector(".review-file-toggle"));
    assert.equal(
      c.calls.some((r) => r.url.pathname.endsWith("/diff")),
      false,
    );
    assert.equal(c.root.querySelectorAll(".review-file-toggle").length, 20);
    assert.ok(button(c, "Show 180 more files"));
    assert.doesNotMatch(c.root.textContent!, /Showing 200 of 400 files\./);
    const paths = reviewFixtureDetail(c.wire).changes.files.map((f) => f.path);
    assert.deepEqual(
      paths,
      paths.toSorted((a, b) => a.localeCompare(b)),
    );
    const rows = c.root.querySelectorAll<HTMLButtonElement>(".review-file-toggle");
    for (const i of [0, 1, 2, 3]) rows[i].click();
    await until(
      () =>
        c.root.querySelectorAll(".review-diff").length === 4 &&
        c.root.textContent!.includes("Binary file, not shown.") &&
        c.root.textContent!.includes("This file isn't part"),
    );
    assert.equal(rows[0].getAttribute("aria-expanded"), "true");
    assert.match(
      c.root.querySelector(".diff-added")!.textContent!,
      /<script>plain text only<\/script>/,
    );
    assert.equal(c.root.querySelector(".review-diff script"), null);
    assert.match(c.root.textContent!, /Patch truncated at 64 KB\./);
    assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/diff")).length, 4);
    button(c, "Show 180 more files").click();
    await until(() => c.root.querySelectorAll(".review-file-toggle").length === 200);
    assert.equal(
      c.dom.window.document.activeElement === c.root.querySelectorAll(".review-file-toggle")[20],
      true,
    );
    assert.equal(c.root.querySelectorAll('.review-file-toggle[aria-expanded="true"]').length, 4);
    assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/diff")).length, 4);
    assert.match(c.root.textContent!, /Showing 200 of 400 files\./);
    rows[0].click();
    rows[0].click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.calls.filter((r) => r.url.pathname.endsWith("/diff")).length, 4);
    assert.match(c.root.textContent!, /Packet FH-040.*Agent codex.*No Fixture product trailers/s);
  } finally {
    c.close();
  }
});

test("approved/promoted/stale/advisory milestones and owner gates reflect independent evidence", async () => {
  for (const id of ["review-approved", "review-promoted", "review-stale", "review-advisory"]) {
    const c = setup(id);
    try {
      await until(() => c.root.querySelector(".review-milestones"));
      if (id === "review-approved") assert.ok(button(c, "Promote"));
      if (id === "review-promoted") {
        assert.match(c.root.textContent!, /Promoted to main/);
        assert.equal(c.root.querySelector('[data-action="return"]'), null);
        button(c, "Promoted to main. Inspect the ledger entry.");
        c.root
          .querySelector<HTMLButtonElement>(
            '[aria-label="Promoted to main. Inspect the ledger entry."]',
          )!
          .click();
        await until(() => c.dom.window.document.body.textContent.includes("Promotion ledger"));
        assert.equal(
          c.dom.window.document.querySelectorAll('[aria-label="Copy to clipboard"]').length >= 3,
          true,
        );
      }
      if (id === "review-stale") {
        assert.match(c.root.textContent!, /The fork moved after this review/);
        assert.equal(c.root.querySelector('[data-action="return"]'), null);
        assert.equal(c.root.querySelector('[data-action="approve"]'), null);
      }
      if (id === "review-advisory") {
        assert.ok(button(c, "Approve"));
        assert.match(c.root.textContent!, /Checks failed.*Advisory: this didn't block approval/s);
      }
    } finally {
      c.close();
    }
  }
});

test("compact commit copies the full SHA, approval focuses its row, and file names separate status/path", async () => {
  const c = setup("review-approved");
  const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied = value;
      },
    },
  });
  try {
    await until(() => c.root.querySelector(".review-commit-caption"));
    assert.equal(!!c.root.querySelector("#approved-commit"), false);
    assert.equal(!!c.root.querySelector('.review-commit [aria-label="Copy to clipboard"]'), false);
    const sha = c.wire.reviews[0].sha;
    c.root
      .querySelector<HTMLButtonElement>(`[aria-label="Copy commit ${sha.slice(0, 7)}"]`)!
      .click();
    await until(() => copied === sha);
    c.root
      .querySelector<HTMLButtonElement>('[aria-label="Approved. Inspect the approved commit."]')!
      .click();
    assert.equal(c.dom.window.document.activeElement.id, `review-commit-${sha}`);
    const row = [...c.root.querySelectorAll(".review-file-toggle")].find((candidate) =>
      candidate.textContent!.includes("src/review.tsx"),
    )!;
    assert.equal(row.textContent!.trim(), "Modified, src/review.tsx");
    assert.equal(row.getAttribute("aria-label"), "Modified, src/review.tsx");
  } finally {
    if (prior) Object.defineProperty(navigator, "clipboard", prior);
    else Reflect.deleteProperty(navigator, "clipboard");
    c.close();
  }
});

test("Request preserves full exact glob paths and folds only after twenty", async () => {
  const c = setup("review-current", true, "#review/review-1", {
    detail: async () => {
      const detail = reviewFixtureDetail(c.wire);
      detail.packet.paths = Array.from(
        { length: 25 },
        (_, i) => `packages/very/long/claimed/path-${i}/**`,
      );
      return Response.json(detail);
    },
  });
  try {
    await until(() => c.root.querySelector(".review-claimed-paths"));
    assert.equal(c.root.querySelectorAll(".review-claimed-paths li").length, 20);
    assert.equal(
      c.root.querySelector(".review-claimed-paths code")!.textContent,
      "packages/very/long/claimed/path-0/**",
    );
    button(c, "Show all 25 paths").click();
    await until(() => c.root.querySelectorAll(".review-claimed-paths li").length === 25);
  } finally {
    c.close();
  }
});

test("detail loading/error/retry/not-found and late response after queue navigation", async () => {
  let finish!: (response: Response) => void;
  const c = setup("review-current", true, "#review/review-1", {
    detail: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    await until(() => finish);
    assert.match(c.root.textContent!, /Loading review…/);
    button(c, "← Review queue").click();
    finish(Response.json(reviewFixtureDetail(c.wire)));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.root.querySelector(".review-milestones"), null);
  } finally {
    c.close();
  }
  let failed = true;
  const e = setup("review-current", true, "#review/review-1", {
    detail: async () =>
      failed
        ? Response.json({ error: "bad" }, { status: 503 })
        : Response.json(reviewFixtureDetail(e.wire)),
  });
  try {
    await until(() => button(e, "Try again"));
    assert.match(e.root.textContent!, /Couldn't load this review\./);
    failed = false;
    button(e, "Try again").click();
    await until(() => e.root.querySelector(".review-milestones"));
  } finally {
    e.close();
  }
  const n = setup("review-not-found");
  try {
    await until(() => n.root.textContent!.includes("This review doesn't exist anymore."));
    assert.ok(button(n, "← Review queue"));
    assert.equal(button(n, "Try again"), undefined, "a missing review has no retry button");
  } finally {
    n.close();
  }
});

test("FH-039 transport encodes paths, uses same-origin session and never retries owner writes", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = createHttpTransport({
    origin,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ error: "denied" }, { status: 403 });
    },
  });
  await assert.rejects(transport.getReview!("a/b", "r/id"));
  await assert.rejects(transport.getDiff!("a/b", "r/id", "a?b&c #.ts"));
  await assert.rejects(transport.returnReview!("a/b", "r/id", "Fix\nthis"));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${origin}/projects/a%2Fb/reviews/r%2Fid`);
  assert.equal(new URL(calls[1].url).searchParams.get("path"), "a?b&c #.ts");
  assert.equal(calls[2].init!.body, '{"reason":"Fix\\nthis"}');
  for (const { init } of calls) {
    assert.equal(init!.credentials, "same-origin");
    assert.equal(init!.redirect, "error");
    assert.equal(init!.cache, "no-store");
    assert.equal((init!.headers as Record<string, string>)?.Authorization, undefined);
  }
});

test("Return reason accepts exactly 2000 characters, rejects oversized input and Escape cancels without a write", async () => {
  const c = setup();
  try {
    await until(() => button(c, "Return to agent"));
    button(c, "Return to agent").click();
    await until(() => c.dom.window.document.querySelector("textarea"));
    fill(c, "x".repeat(2001));
    await until(() =>
      c.dom.window.document.getElementById("return-counter")!.textContent!.startsWith("2001"),
    );
    assert.equal(
      c.dom.window.document.querySelector('[data-action="confirm-return"]')!.disabled,
      true,
    );
    fill(c, "x".repeat(2000));
    await until(
      () => !c.dom.window.document.querySelector('[data-action="confirm-return"]')!.disabled,
    );
    const textarea = c.dom.window.document.querySelector("textarea")!;
    textarea.dispatchEvent(
      new c.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await until(() => !c.dom.window.document.querySelector(".return-dialog"));
    assert.equal(
      c.calls.some((r) => r.url.pathname.endsWith("/return")),
      false,
    );
  } finally {
    c.close();
  }
});

test("detail retains queue SHA/digest gates and rejects a contract for a different review or unbounded patch", async () => {
  const c = setup("review-approved");
  try {
    c.wire.reviews[0].approval!.sha = "9".repeat(40);
    await until(() => c.root.querySelector(".review-milestones"));
    assert.equal(c.root.querySelector('[data-action="promote"]'), null);
    assert.equal(c.root.querySelector('[data-action="return"]'), null);
  } finally {
    c.close();
  }
  const mismatch = setup("review-current", true, "#review/review-1", {
    detail: async () => {
      const value = reviewFixtureDetail(reviewFixtureState("review-current"));
      value.review.id = "other-review";
      return Response.json(value);
    },
  });
  try {
    await until(() => mismatch.root.textContent!.includes("Couldn't load this review."));
    assert.equal(mismatch.root.querySelector('[data-action="approve"]'), null);
  } finally {
    mismatch.close();
  }
  const huge = setup("review-current", true, "#review/review-1", {
    diff: async () =>
      Response.json({ ...reviewFixtureDiff("src/review.tsx"), patch: "x".repeat(65537) }),
  });
  try {
    await until(() => huge.root.querySelector(".review-file-toggle"));
    [...huge.root.querySelectorAll<HTMLButtonElement>(".review-file-toggle")]
      .find((b) => b.textContent!.includes("src/review.tsx"))!
      .click();
    await until(() => huge.root.textContent!.includes("Couldn't load this diff."));
    assert.equal(huge.root.querySelector(".review-diff pre"), null);
  } finally {
    huge.close();
  }
});

test("detail blockers hide owner decisions even when the earlier snapshot had no blocker", async () => {
  const c = setup("review-current", true, "#review/review-1", {
    detail: async () => {
      const value = reviewFixtureDetail(reviewFixtureState("review-current"));
      value.blockers = [
        {
          id: "detail-blocker",
          packet: "FH-040",
          claimingAgent: "fixture-agent",
          pushingAgent: "fixture-peer",
          repoName: value.review.repoName,
          pushingPacket: value.review.packet,
          sha: "7".repeat(40),
          paths: ["src/review.tsx"],
        },
      ];
      return Response.json(value);
    },
  });
  try {
    await until(() => c.root.querySelector(".review-milestones"));
    assert.match(c.root.textContent!, /fixture-peer pushed 7777777/);
    assert.equal(c.root.querySelector('[data-action="approve"]'), null);
    assert.ok(c.root.querySelector('[data-action="return"]'));
    const titles = [...c.root.querySelectorAll(".review-detail h2")].map((h) => h.textContent);
    assert.ok(titles.indexOf("Collisions") < titles.indexOf("Request"));
  } finally {
    c.close();
  }
});

// Synthetic FH-045 state and DOM coverage, including the stale:false shot-7 loser.
test("stale causes match in detail and queue before a click, with no owner actions", async () => {
  const cases = [
    ["review-stale", "Fork moved", "The fork moved after this review was requested."],
    ["review-main-moved", "Main moved", "main moved to 7777777 after this review was requested."],
    ["review-main-moved-stale", "Main moved", "main moved to 7777777 after this review was requested."],
    ["review-out-of-date", "Out of date", "This review no longer applies."],
    ["review-reconciler-stale", "Out of date", "This review no longer applies."],
    ["review-pending-promotion-stale", "Out of date", "This review no longer applies."],
  ];
  for (const [scenario, label, banner] of cases) {
    for (const route of ["#review", "#review/review-1"]) {
      const c = setup(scenario, true, route);
      try {
        await until(() => c.root.querySelector(route === "#review" ? ".review-card" : ".review-milestones"));
        const scope = c.root.querySelector(route === "#review" ? ".review-card" : ".review-detail")!;
        assert.ok(scope.textContent!.includes(route === "#review" ? label : banner));
        assert.equal(scope.querySelector('[data-action="approve"], [data-action="promote"], [data-action="return"]'), null);
        if (label === "Main moved") assert.match(scope.textContent!, /The agent must rebase and request review again\./);
        if (scenario === "review-main-moved") assert.equal(c.wire.reviews[0].stale, false);
        if (label === "Out of date") assert.doesNotMatch(scope.textContent!, /Fork moved|The fork moved/);
        assert.equal(c.calls.some((call) => call.init?.method === "POST"), false);
      } finally { c.close(); }
    }
  }
});

test("guarded main movement keeps approval, pending promotion hides Promote, and returned suppresses stale banner", async () => {
  for (const scenario of ["review-reconciler", "review-pending-promotion", "review-returned", "review-promoted"]) {
    const c = setup(scenario);
    if (["review-returned", "review-promoted"].includes(scenario)) {
      c.wire.reviews[0].stale = true;
      c.wire.forks.find((fork) => fork.repoName === c.wire.reviews[0].repoName)!.head = "9".repeat(40);
    }
    try {
      await until(() => c.root.querySelector(".review-milestones"));
      const detail = c.root.querySelector(".review-detail")!;
      assert.doesNotMatch(detail.textContent!, /The fork moved|main moved to|This review no longer applies/);
      if (scenario === "review-reconciler") assert.ok(button(c, "Promote"));
      if (scenario === "review-pending-promotion") assert.equal(button(c, "Promote"), undefined);
    } finally { c.close(); }
  }
});

test("main-moved needs ledger, known base, explicit null pending and no current-head alert", async () => {
  const { reviewState } = await import("../src/model.ts");
  const wire = reviewFixtureState("review-main-moved");
  const state = stateView(wire);
  const r = state.reviews[0];
  assert.equal(reviewState(r, state).kind, "main-moved");
  assert.equal(reviewGate(r, state).promote, false);
  state.reconcilerAlerts = [{ id: "historical-alert", sha: r.sha, message: "Historical fixture" }];
  assert.equal(reviewState(r, state).kind, "main-moved");
  // Latest entry by recorded time, even if an adapter gives an unordered ledger.
  state.ledger.unshift({ review: "later", sha: r.base!, promotedAt: "2026-10-14T08:00:00Z" });
  assert.equal(reviewState(r, state).kind, "current");
  state.ledger.shift();
  for (const mutation of [
    (s: typeof state) => { s.ledger = []; },
    (s: typeof state) => { s.reviews[0].base = undefined; },
    (s: typeof state) => { s.promotionPending = undefined; },
    (s: typeof state) => { s.reconcilerAlerts.push({ id: "current-head", sha: r.sha, message: "Fixture" }); },
  ]) {
    const guarded = structuredClone(state);
    mutation(guarded);
    assert.equal(reviewState(guarded.reviews[0], guarded).kind, "current");
    guarded.reviews[0].stale = true;
    assert.equal(reviewState(guarded.reviews[0], guarded).kind, "out-of-date");
  }
  state.forks.find((f) => f.repoName === r.repoName)!.head = "9".repeat(40);
  assert.equal(reviewState(r, state).kind, "fork-moved");
  r.returned = { reason: "Fixture return", at: "2026-10-13T08:00:00Z" };
  assert.equal(reviewState(r, state).kind, "returned");
  r.status = "promoted";
  assert.equal(reviewState(r, state).kind, "promoted");
});
