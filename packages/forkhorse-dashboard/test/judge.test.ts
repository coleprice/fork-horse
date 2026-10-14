import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@cloudflare/kumo";
import { judgeFixtureState, judgeFixtureDetail } from "./judge-fixtures.ts";
import { JudgeAdvice, ReviewAdvice } from "../src/judge.tsx";
import { judgePromotion, pushedAfterAdvice } from "../src/judge.ts";
import { stateView, promotionAvailable } from "../src/model.ts";
import { ownerNeeds, copyText } from "../src/needs-you-model.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import type { ViewActions } from "../src/view.tsx";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture product", tagline: "Fixture" };
const actions: ViewActions = { owner: true, section: "work", async action() {}, openReview() {}, setSection() {}, async selectProject() {} };
function render(scenario: string, owner = true) {
  const state = stateView(judgeFixtureState(scenario));
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(JudgeAdvice, {
    race: state.races![0], view: { state, activity: state.recentActivity!, project: scenario, brand, projects: [], fixture: true, busy: false },
    actions: { ...actions, owner },
  })));
}
function renderedText(html: string) {
  const dom = new JSDOM(html);
  try { return dom.window.document.body.textContent ?? ""; }
  finally { dom.window.close(); }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Judge fixture DOM did not settle");
}
function setup(scenario = "judge-open", owner = true, failRecheck = false) {
  const dom = new JSDOM('<div id="app"></div>', { url: "https://fixture.idiot.tax/#race/race-01" });
  installDom(dom.window);
  const root = dom.window.document.getElementById("app") as HTMLElement;
  const wire = judgeFixtureState(scenario);
  const calls: string[] = [];
  const transport = createHttpTransport({ origin: dom.window.location.origin, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/state")) return Response.json(wire);
    if (path.endsWith("/activity")) return Response.json({ activity: [], nextAfter: 0 });
    if (init?.method === "POST" && path.endsWith("/promote")) {
      if (failRecheck) {
        const review = wire.reviews.find((r) => r.agent === "cedar")!;
        review.receipt!.status = "failed"; review.receipt!.trigger = "before-promote";
        return Response.json({ error: "Checks failed before promote." }, { status: 409 });
      }
      return Response.json({ sha: wire.reviews[0].sha });
    }
    const id = path.split("/").at(-1)!;
    return wire.reviews.some((r) => r.id === id) ? Response.json(judgeFixtureDetail(wire, id)) : Response.json({}, { status: 404 });
  }});
  const app = mountDashboard(root, { brand, transport, fixture: true, initialProject: scenario, owner });
  return { root, wire, calls, app, dom, close() { app.dispose(); dom.window.close(); } };
}

test("judge seam is optional, advice stays plain text, forecast is decorative and judge gets no cloth", () => {
  assert.equal(render("judge-nojudge"), "");
  assert.match(renderedText(render("judge-waiting")), /cfos-1 hasn't sent advice yet\./);
  const html = render("judge-open");
  assert.match(html, /From cfos-1/);
  assert.match(html, /Pick/); assert.match(html, /2nd choice/); assert.match(html, /3rd choice/);
  assert.match(renderedText(html), /Judge's ranking: cedar, then birch, then amber\./);
  const c = new JSDOM(html).window.document;
  assert.equal(c.querySelector(".judge-forecast")!.getAttribute("aria-hidden"), "true");
  assert.equal(c.querySelector(".judge-from .race-saddlecloth"), null);
  assert.equal(c.querySelectorAll("ol li .race-saddlecloth").length, 3);
  assert.match(render("judge-long"), /&lt;strong&gt;/);
  assert.equal(new JSDOM(render("judge-long")).window.document.querySelector("blockquote strong"), null);
  assert.doesNotMatch(html, /decided|decision|verdict|ruling|ruled|chose the winner|judged|award|\bbet\b|odds|stake|prize|payout|bounty|wager/);
});

test("pick promotion shares queue eligibility and suppresses stale, closed, budget and pending cases", () => {
  for (const scenario of ["judge-open", "judge-unapproved", "judge-pick-push", "judge-pick-review", "judge-over", "judge-unchecked", "judge-main-moved", "judge-pending", "judge-recheck", "judge-closed"]) {
    const state = stateView(judgeFixtureState(scenario));
    const choice = judgePromotion(state, state.races![0]);
    assert.equal(choice.available, scenario === "judge-open", scenario);
    if (choice.available) assert.equal(promotionAvailable(choice.review!, state), true);
    else assert.ok(choice.reason, scenario);
  }
  const state = stateView(judgeFixtureState("judge-pick-push"));
  const choice = judgePromotion(state, state.races![0]);
  assert.equal(choice.reason, "cedar pushed after this advice.");
  assert.equal(promotionAvailable(choice.review!, state), true, "ordinary queue still promotes independently of advice age");
  assert.equal(promotionAvailable(choice.review!, state, false), false);
  const wire = judgeFixtureState();
  const before = JSON.stringify({ ledger: wire.ledger, activity: wire.activity });
  stateView(wire); render("judge-open");
  assert.equal(JSON.stringify({ ledger: wire.ledger, activity: wire.activity }), before);
});

test("ranking updates and newer push evidence are shared with review captions and Needs you", () => {
  const state = stateView(judgeFixtureState("judge-entrant-push"));
  const race = state.races![0];
  assert.equal(pushedAfterAdvice(state, race, race.entrants.find((e) => e.agent === "birch")!), true);
  assert.match(render("judge-entrant-push"), /birch pushed after this advice/);
  const pick = state.reviews.find((r) => r.agent === "cedar")!;
  const reviewLine = () => renderToStaticMarkup(createElement(ReviewAdvice, { state, review: pick }));
  assert.match(renderedText(reviewLine()), /Judge's advice: pick/);
  const suffix = () => ownerNeeds(state, brand).find((need) => need.id === `promote:${pick.id}`)!;
  assert.match(copyText(suffix().outcome), /First promote wins the race\. The judge picked this entrant\./);
  race.verdict!.ranking = ["birch", "cedar", "amber"];
  assert.match(reviewLine(), /2nd choice of 3/);
  assert.doesNotMatch(copyText(suffix().outcome), /The judge picked/);
});

test("finished advice persists with pick/other result, no action, and truthful empty history", () => {
  assert.match(renderedText(render("judge-finish-pick")), /Winner: cedar \(the judge's pick\)\./);
  assert.match(render("judge-finish-other"), /Winner: cedar\. The judge picked birch\./);
  assert.match(render("judge-finish-pick"), /before the finish/);
  assert.match(renderedText(render("judge-finish-none")), /didn't send advice before the finish/);
  assert.doesNotMatch(render("judge-finish-pick"), /promote-judge-pick/);
  assert.doesNotMatch(render("judge-open", false), /promote-judge-pick/);
  assert.match(render("judge-open", false), /This is advice\. The owner promotes\./);
});

test("pick opens the existing dialog and only its normal primary sends a promote request", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector('[data-action="promote-judge-pick"]'));
    const block = c.root.querySelector(".judge-advice")!;
    assert.ok(block.closest(".race-usage"));
    assert.equal(c.root.querySelectorAll(".judge-pick").length, 1);
    c.root.querySelector<HTMLButtonElement>('[data-action="promote-judge-pick"]')!.click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    const dialog = c.dom.window.document.querySelector(".promotion-dialog")!;
    assert.match(dialog.textContent!, /cfos-1 picked cedar\. This is advice; promoting is your call\./);
    assert.match(dialog.textContent!, /Promoting this finishes the race\. amber and birch will be closed and placed\./);
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 0);
    (c.dom.window.document.querySelector('[data-action="confirm-promote"]') as HTMLButtonElement).click();
    await until(() => c.calls.some((call) => call.endsWith("/reviews/race-review-cedar/promote")));
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 1);
    assert.equal(c.calls.some((call) => /verdict/.test(call)), false);
  } finally { c.close(); }
});

test("agents cannot invoke pick promotion; long rationale expands and replacement advice is shown", async () => {
  const c = setup("judge-long", false);
  try {
    await until(() => !!c.root.querySelector(".judge-clamped"));
    assert.equal(c.root.querySelector('[data-action="promote-judge-pick"]'), null);
    const show = [...c.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Show all")!;
    assert.equal(show.getAttribute("aria-expanded"), "false");
    show.click();
    await until(() => !c.root.querySelector(".judge-clamped"));
    assert.equal(show.textContent, "Show less");
    c.wire.races![0].verdict!.ranking = ["birch", "cedar", "amber"];
    c.wire.races![0].verdict!.at = "2026-10-13T14:16:00Z";
    await c.app.refresh();
    await until(() => c.root.querySelector(".judge-ranking li strong")!.textContent === "birch");
    assert.match(c.root.querySelector('.race-track [data-race-agent="birch"]')!.textContent!, /Judge's pick/);
    assert.equal(c.root.querySelector('[data-action="promote-judge-pick"]'), null);
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 0);
  } finally { c.close(); }
});

test("a newer review arriving with a pick dialog open cannot promote unseen work", async () => {
  const c = setup();
  try {
    await until(() => !!c.root.querySelector('[data-action="promote-judge-pick"]'));
    c.root.querySelector<HTMLButtonElement>('[data-action="promote-judge-pick"]')!.click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    c.wire.reviews.find((r) => r.agent === "cedar")!.createdAt = "2026-10-13T14:15:00Z";
    await c.app.refresh();
    await until(() => !c.root.querySelector('[data-action="promote-judge-pick"]'));
    const confirm = c.dom.window.document.querySelector('[data-action="confirm-promote"]') as HTMLButtonElement;
    assert.equal(confirm.disabled, true);
    assert.match(c.dom.window.document.querySelector('.promotion-dialog').textContent, /Review changed\. Close and review again\./);
    confirm.click();
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 0);
  } finally { c.close(); }
});

test("the pick shortcut preserves the normal required re-check failure dialog without retrying", async () => {
  const c = setup("judge-open", true, true);
  try {
    await until(() => !!c.root.querySelector('[data-action="promote-judge-pick"]'));
    c.root.querySelector<HTMLButtonElement>('[data-action="promote-judge-pick"]')!.click();
    await until(() => !!c.dom.window.document.querySelector('[data-action="confirm-promote"]'));
    (c.dom.window.document.querySelector('[data-action="confirm-promote"]') as HTMLButtonElement).click();
    await until(() => c.dom.window.document.querySelector('.promotion-dialog')?.textContent.includes("Checks failed on the re-run."));
    assert.equal(c.root.querySelector('[data-action="promote-judge-pick"]'), null);
    const dialog = c.dom.window.document.querySelector('.promotion-dialog') as HTMLElement;
    assert.match(dialog.textContent!, /Nothing was promoted\./);
    assert.match(dialog.textContent!, /View receipt/);
    assert.equal((dialog.querySelector('[data-action="confirm-promote"]') as HTMLButtonElement).disabled, true);
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 1);
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "View receipt")!.click();
    await until(() => c.root.querySelector(".receipt-details")?.textContent?.includes("Failed") === true);
    assert.equal(c.dom.window.location.hash, "#work");
    assert.equal(c.calls.some((call) => call.endsWith("/receipt")), false, "receipt summary does not request logs");
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 1);
  } finally { c.close(); }
});

// Regression for the rehearsal's doubled picked-entrant caption.
test("picked entrant's newer push caption appears once while promotion stays blocked", () => {
  for (const scenario of ["judge-pick-push", "judge-pick-review"]) {
    for (const owner of [true, false]) {
      const text = renderedText(render(scenario, owner));
      assert.equal(text.split("cedar pushed after this advice").length - 1, 1);
      assert.doesNotMatch(render(scenario, owner), /data-action="promote-judge-pick"/);
    }
  }
  assert.match(renderedText(render("judge-unapproved")), /cedar's review isn't approved yet/);
});
