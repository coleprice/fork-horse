import "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { stateView } from "../src/model.ts";
import { renderDashboard } from "../src/render.ts";
import { emptyFixtureState } from "./empty-fixtures.ts";
import { fixtureState } from "./fixtures.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture product", tagline: "Fixture collaboration" };
function snapshot(scenario: string) {
  return {
    brand,
    projects: scenario === "empty-projects" ? [] : [{ id: scenario, label: scenario }],
    project: scenario === "empty-projects" ? "" : scenario,
    fixture: true,
    activity: [],
    busy: false,
    ...(scenario === "empty-projects" ? {} : { state: stateView(emptyFixtureState(scenario)) }),
  };
}

test("first-run views offer one documentation next step, without owner write controls", () => {
  for (const [scenario, kind, label] of [
    ["empty-projects", "projects", "Set up a project"],
    ["empty-agents", "agents", "Enroll an agent"],
    ["empty-packets", "packets", "Create a packet"],
    ["empty-reviews", "reviews", "Request a review"],
  ]) {
    const dom = new JSDOM(renderDashboard(snapshot(scenario)));
    try {
      const hint = dom.window.document.querySelector(`[data-first-run="${kind}"]`);
      assert.ok(hint, scenario);
      const links = hint.querySelectorAll("a");
      assert.equal(links.length, 1, scenario);
      assert.equal(links[0].textContent, label);
      assert.match(links[0].getAttribute("href"), /docs\/quickstart\.md(?:#.*)?$/);
      assert.equal(hint.querySelectorAll("button, input, form").length, 0);
      assert.match(dom.window.document.body.textContent, /FIXTURE · OFFLINE/);
    } finally {
      dom.window.close();
    }
  }
});

test("loading, failures and populated project views do not offer first-run actions", () => {
  const empty = snapshot("empty-projects");
  for (const view of [
    { ...empty, busy: true },
    { ...empty, error: "Snapshot unavailable" },
    { ...snapshot("demo"), state: stateView(fixtureState()) },
  ]) {
    const dom = new JSDOM(renderDashboard(view));
    try {
      assert.equal(dom.window.document.querySelector("[data-first-run]"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("archive-only projects retain their existing restore action", () => {
  const state = stateView(fixtureState());
  for (const packet of state.packets)
    packet.archived = { at: "2026-10-14T12:00:00Z", by: "owner" };
  const dom = new JSDOM(renderDashboard({ ...snapshot("demo"), state }));
  try {
    assert.equal(dom.window.document.querySelector('[data-first-run="packets"]'), null);
    assert.match(dom.window.document.querySelector("#packets").textContent, /Show archived/);
  } finally {
    dom.window.close();
  }
});
