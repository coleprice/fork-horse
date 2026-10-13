import { installDom } from "./dom.ts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { ownerNeeds } from "../src/needs-you-model.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import { reviewGate, stateView } from "../src/model.ts";
import {
  agentUsageToday,
  laneUsage,
  tokenNumber,
  totalTokens,
  usageTooltip,
} from "../src/usage.ts";
import { BudgetUsage, UsageFigures } from "../src/usage.tsx";
import { usageFixtureState, usageFixtureDetail } from "./usage-fixtures.ts";
const brand = { name: "Fixture product", tagline: "Fixture" };
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const now = Date.parse("2026-10-13T16:00:00Z");
const fixture = (id = "usage-race") => stateView(usageFixtureState(id, now));
async function until(fn: () => unknown) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Usage DOM did not settle");
}
function setup(scenario = "usage-race", route = "#race/FH-040", owner = true, noDetail = false) {
  const dom = new JSDOM('<div id="dashboard"></div>', {
    url: `https://fixture.idiot.tax/${route}`,
  });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard")! as HTMLElement;
  const wire = usageFixtureState(scenario);
  const calls: { url: URL; method: string }[] = [];
  const transport = createHttpTransport({
    origin: "https://fixture.idiot.tax",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.pathname.endsWith("/state")) return Response.json(wire);
      if (url.pathname.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
      return Response.json(
        usageFixtureDetail(wire, decodeURIComponent(url.pathname.split("/").at(-1)!)),
      );
    },
  });
  if (noDetail) delete transport.getReview;
  const app = mountDashboard(root, {
    brand,
    fixture: true,
    owner,
    agent: "fixture-agent",
    initialProject: scenario,
    projects: [{ id: scenario, label: "Usage fixture" }],
    transport,
  });
  return {
    dom,
    root,
    wire,
    calls,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}
test("token formatting stays exact under 100k; sources, model and missing reports stay explicit", () => {
  assert.deepEqual([0, 18400, 99999, 100000, 340000, 1200000].map(tokenNumber), [
    "0",
    "18,400",
    "99,999",
    "100k",
    "340k",
    "1.2M",
  ]);
  const state = fixture("usage-both");
  const usage = state.reviews[0].usageAtReview!;
  assert.equal(
    usageTooltip(usage.reported!, "fixture-agent", brand),
    "Reported by fixture-agent through Fixture product. Fixture product can't verify it.",
  );
  assert.equal(
    usageTooltip(usage.metered!, "fixture-agent", brand),
    "Metered by AI Gateway for fixture-agent.",
  );
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(UsageFigures, { usage, agent: "fixture-agent", brand, split: true }),
    ),
  );
  assert.match(markup, /reported/);
  assert.match(markup, /metered/);
  assert.match(markup, /fixture-model \(reported\)/);
  assert.match(markup, /as of/);
  assert.doesNotMatch(markup, /670k/);
  assert.match(
    renderToStaticMarkup(createElement(UsageFigures, { agent: "fixture-agent", brand })),
    /Not reported/,
  );
});
test("promotion follows current entrant state rather than the older review snapshot, for owner and queue", () => {
  const state = fixture();
  const r = state.reviews[2];
  r.usageAtReview = state.reviews[0].usageAtReview;
  assert.equal(reviewGate(r, state).promote, false);
  assert.equal(
    reviewGate(r, state).reason,
    "Over its token budget (reported). It can't win this race.",
  );
  state.races![0].entrants[2].budget = "within";
  assert.equal(reviewGate(r, state).promote, true);
  state.races![0].entrants[2].budget = "unchecked";
  assert.equal(reviewGate(r, state).reason, "Report usage first: this race has a token budget.");
  state.races![0].tokenBudget = null;
  assert.equal(reviewGate(r, state).promote, true);
  assert.equal(
    reviewGate(fixture("usage-legacy").reviews[0], fixture("usage-legacy")).promote,
    true,
  );
});
test("today totals deduplicate claims, race entrants and superseded review snapshots by binding and source", () => {
  const state = fixture("usage-both");
  const r = state.reviews[0];
  state.reviews.push({
    ...r,
    id: "older",
    usageAtReview: {
      reported: { ...r.usageAtReview!.reported!, inputTokens: 1000, at: "2026-10-13T08:00:00Z" },
      metered: null,
    },
  });
  let totals = agentUsageToday(state, r.agent, now);
  assert.equal(totalTokens(totals.reported!), 420000);
  assert.equal(totalTokens(totals.metered!), 250000);
  const yesterday = {
    reported: { ...r.usageAtReview!.reported!, at: "2026-10-11T16:00:00Z" },
    metered: null,
  };
  state.reviews.push({
    ...r,
    id: "yesterday",
    packet: "other",
    repoName: "other",
    usageAtReview: yesterday,
  });
  totals = agentUsageToday(state, r.agent, now);
  assert.equal(totalTokens(totals.reported!), 420000);
  assert.deepEqual(agentUsageToday(state, "unreported", now), { reported: null, metered: null });
  state.reviews.push({
    ...r,
    id: "second-packet",
    packet: "second",
    usageAtReview: r.usageAtReview,
  });
  assert.equal(totalTokens(agentUsageToday(state, r.agent, now).reported!), 840000);
});
test("graph historical promotion uses its snapshot while the active lane uses current usage", () => {
  const state = fixture();
  const r = state.reviews[0];
  const live = state.races![0].entrants[0].usage!;
  live.reported!.inputTokens += 100;
  assert.equal(laneUsage(state, { packet: r.packet, repoName: r.repoName, review: r }), live);
  assert.equal(
    laneUsage(state, { packet: r.packet, repoName: r.repoName, review: r, promoted: {} }),
    r.usageAtReview,
  );
});
test("race Compare is factual and read-only for both roles, with true ratio meters and detail-backed file counts", async () => {
  for (const owner of [true, false]) {
    const c = setup("usage-race", "#race/FH-040", owner);
    try {
      await until(
        () =>
          c.root.querySelector(".race-compare")?.textContent?.includes("fewest") &&
          c.calls.filter((call) => call.url.pathname.includes("/reviews/")).length === 3,
      );
      const meters = [...c.root.querySelectorAll<HTMLMeterElement>(".race-track meter")];
      assert.deepEqual(
        meters.map((m) => [m.value, m.max]),
        [
          [420000, 1000000],
          [820000, 1000000],
          [1000000, 1000000],
        ],
      );
      assert.match(c.root.textContent!, /1.1M \/ 1M · reported/);
      assert.match(c.root.textContent!, /Near budget/);
      assert.match(c.root.textContent!, /Over budget/);
      assert.match(
        c.root.querySelector(".race-compare")!.textContent!,
        /Time to Approved.*Time to Promoted.*Checks passed.*Files changed.*Recorded pushes.*Tokens/s,
      );
      assert.match(c.root.querySelector(".race-compare")!.textContent!, /in loaded history/);
      assert.doesNotMatch(
        c.root.querySelector(".race-compare")!.textContent!,
        /score|cost|rank|winner/i,
      );
      assert.equal(
        c.calls.some((call) => call.method !== "GET"),
        false,
      );
    } finally {
      c.close();
    }
  }
});
test("queue Tokens column is conditional; over and unchecked hide Promote in queue and detail", async () => {
  for (const [scenario, id, caption] of [
    ["usage-over", "usage-review-2", "Over its token budget (reported). It can't win this race."],
    ["usage-unchecked", "usage-review-0", "Report usage first: this race has a token budget."],
  ]) {
    for (const route of ["#review", `#review/${id}`]) {
      const c = setup(scenario, route);
      try {
        await until(() => c.root.querySelector(".usage-promotion-caption"));
        const scope =
          route === "#review"
            ? [...c.root.querySelectorAll(".review-card")].find(
                (r) => r.querySelector(`[data-review="${id}"]`) || r.textContent!.includes(caption),
              )!
            : c.root.querySelector(".review-detail")!;
        assert.ok(scope.textContent!.includes(caption));
        assert.equal(scope.querySelector('[data-action="promote"]'), null);
        if (route !== "#review") {
          assert.match(scope.textContent!, /Usage.*Tokens to this review/s);
          assert.equal(scope.querySelectorAll(".review-milestone").length, 3);
        }
        assert.equal(
          c.calls.some((call) => call.method !== "GET"),
          false,
        );
      } finally {
        c.close();
      }
    }
  }
  const c = setup("usage-legacy", "#review");
  try {
    await until(() => c.root.querySelector(".review-card"));
    assert.equal(!!c.root.querySelector(".table-review .column-tokens"), false);
  } finally {
    c.close();
  }
});
test("both sources stay separate in race budget and agent totals; unchecked and missing detail are explicit", async () => {
  const c = setup("usage-both", "#agents");
  try {
    await until(() => c.root.querySelector(".table-agents"));
    const row = c.root.querySelector(".table-agents tbody tr")!;
    assert.match(row.textContent!, /420k tokens · reported/);
    assert.match(row.textContent!, /250k tokens · metered/);
    assert.doesNotMatch(row.textContent!, /670k/);
    assert.match(c.root.textContent!, /do not measure tokens consumed today/);
  } finally {
    c.close();
  }
  const u = setup("usage-unchecked", "#race/FH-040", false, true);
  try {
    await until(() => u.root.querySelector(".race-compare"));
    assert.match(u.root.textContent!, /Budget unchecked/);
    assert.match(u.root.textContent!, /Not reported/);
    assert.match(u.root.textContent!, /Unavailable/);
  } finally {
    u.close();
  }
});
test("fork graph keeps tokens in tooltip and table, without figures on lane labels", async () => {
  const c = setup("usage-race", "#overview");
  try {
    await until(() => c.root.querySelector(".fork-lane-label"));
    const label = c.root.querySelector(".fork-lane-label")!;
    assert.doesNotMatch(label.textContent!, /tokens|reported/);
    assert.match(label.getAttribute("title")!, /tokens · reported/);
    assert.match(label.getAttribute("title")!, /can't verify it/);
    assert.match(
      c.root.querySelector(".fork-table-wrap")?.textContent ??
        c.root.querySelector(".fork-card")!.textContent!,
      /Tokens/,
    );
    assert.match(c.root.querySelector(".fork-card")!.textContent!, /420k tokens · reported/);
  } finally {
    c.close();
  }
});

test("budget boundary labels come from core and the gauge selects metered before reported", () => {
  const usage = fixture().races![0].entrants[0].usage!;
  for (const [total, status, label] of [
    [0, "within", "Within budget"],
    [799999, "within", "Within budget"],
    [800000, "near", "Near budget"],
    [1000000, "near", "Near budget"],
    [1000001, "over", "Over budget"],
  ] as const) {
    usage.reported!.inputTokens = total;
    usage.reported!.outputTokens = 0;
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(BudgetUsage, {
          usage,
          budget: 1000000,
          status,
          agent: "fixture-agent",
          brand,
        }),
      ),
    );
    assert.ok(html.includes(label));
    assert.ok(html.includes(`value="${total}"`));
    assert.ok(html.includes(`${total.toLocaleString("en-US")} of 1,000,000 tokens (reported)`));
  }
  usage.metered = {
    inputTokens: 25000,
    outputTokens: 0,
    at: usage.reported!.at,
    source: "metered",
  };
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(BudgetUsage, {
        usage,
        budget: 1000000,
        status: "within",
        agent: "fixture-agent",
        brand,
      }),
    ),
  );
  assert.match(html, /value="25000"/);
  assert.match(html, /25,000 \/ 1M · metered/);
  assert.match(html, /1M tokens.*reported/s);
});
test("automatic budget rejection creates no new Needs you item and removes the existing Promote need", () => {
  const state = fixture("usage-unchecked");
  const items = ownerNeeds(state, brand, now);
  assert.deepEqual(
    items.filter((item) => item.kind === "promote").map((item) => item.id),
    ["promote:usage-review-1"],
  );
  assert.equal(
    items.some((item) => /budget|usage/.test(item.kind)),
    false,
  );
});

test("agent review detail explains automatic rejection without owner controls", async () => {
  const c = setup("usage-over", "#review/usage-review-2", false);
  try {
    await until(() => c.root.querySelector(".review-detail .usage-promotion-caption"));
    assert.match(
      c.root.querySelector(".review-detail")!.textContent!,
      /Over its token budget \(reported\). It can't win this race\./,
    );
    assert.equal(!!c.root.querySelector(".review-detail [data-action]"), false);
    assert.equal(
      c.calls.some((call) => call.method !== "GET"),
      false,
    );
  } finally {
    c.close();
  }
});

test("core unchecked state on an unbudgeted race shows Not reported and keeps Promote", async () => {
  const race = setup("usage-unbudgeted", "#race/FH-040");
  try {
    await until(() => !!race.root.querySelector(".race-track"));
    assert.equal(!!race.root.querySelector(".race-track meter"), false);
    assert.equal(
      race.root.querySelector(".race-track")!.textContent!.includes("Budget unchecked"),
      false,
    );
    assert.match(race.root.querySelector(".race-track")!.textContent!, /Not reported/);
  } finally {
    race.close();
  }
  const review = setup("usage-unbudgeted", "#review/usage-review-0");
  try {
    await until(() => !!review.root.querySelector('.review-detail [data-action="promote"]'));
    assert.equal(!!review.root.querySelector(".review-detail .usage-promotion-caption"), false);
    assert.equal(
      review.calls.some((call) => call.method !== "GET"),
      false,
    );
  } finally {
    review.close();
  }
});
test("track, Compare, and results share accepted claim order with Tokens before Result", async () => {
  const c = setup("usage-reordered", "#race/FH-040");
  try {
    await until(() => !!c.root.querySelector(".race-compare"));
    const track = c.root.querySelector(".race-track")!;
    const ordered = ["fixture-agent", "fixture-peer", "fixture-third"];
    assert.deepEqual(
      [...track.querySelectorAll("tbody tr")].map((row) => row.getAttribute("data-race-agent")),
      ordered,
    );
    assert.deepEqual(
      [...c.root.querySelectorAll(".race-compare thead th")].slice(1).map((th) => th.textContent),
      ordered,
    );
    assert.deepEqual(
      [...track.querySelectorAll("thead th")].map((th) => th.textContent).slice(-2),
      ["Tokens", "Result"],
    );
    assert.deepEqual(
      [...c.root.querySelectorAll(".race-results thead th")].map((th) => th.textContent).slice(-2),
      ["Tokens", "Result"],
    );
    assert.equal(track.querySelectorAll(".lane-marker-approved").length, 3);
    assert.equal(track.querySelectorAll(".lane-marker-review").length, 3);
    assert.equal(track.querySelectorAll(".race-mark-box").length, 18);
    assert.equal(c.root.querySelector(".race-compare")!.textContent!.includes("25:00.0"), true);
  } finally {
    c.close();
  }
});
