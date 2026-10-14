import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import brand from "../../../brand.json" with { type: "json" };
import { mountDashboard } from "../src/dashboard.ts";
import { overviewFirstRun } from "../src/empty.tsx";
import { stateView, type ViewModel } from "../src/model.ts";
import { DashboardView, type Section } from "../src/view.tsx";
import { emptyFixtureState } from "./empty-fixtures.ts";
import { fixtureState } from "./fixtures.ts";
import { forkFixtureState } from "./fork-graph-fixtures.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const fixtureBrand = { name: "Fixture product", tagline: "Fixture collaboration" };
function snapshot(scenario: string): ViewModel {
  return {
    brand: fixtureBrand,
    projects: scenario === "empty-projects" ? [] : [{ id: scenario, label: scenario }],
    project: scenario === "empty-projects" ? "" : scenario,
    fixture: true,
    activity: [],
    busy: false,
    ...(scenario === "empty-projects" ? {} : { state: stateView(emptyFixtureState(scenario)) }),
  };
}
function html(view: ViewModel, owner = true, section: Section = "overview") {
  return renderToStaticMarkup(createElement(DashboardView, {
    view,
    actions: {
      section, owner,
      async selectProject() {},
      setSection() {},
      openReview() {},
      async action() {},
    },
  }));
}
const cases = [
  { scenario: "empty-projects", scope: ".content", kind: "projects", title: "No projects yet",
    command: `${brand.slug} project create <project> --config "$CLI_CONFIG" --agents <agent> --output "$PRIVATE_TOKEN_FILE"` },
  { scenario: "empty-agents", scope: "#lanes", kind: "agents", title: "No agents yet",
    command: `${brand.slug} agent enroll <agent> --config "$CLI_CONFIG" --output "$NEW_PRIVATE_TOKEN_FILE"` },
  { scenario: "empty-packets", scope: "#packets", kind: "packets", title: "No packets yet",
    command: `${brand.slug} packet create packet.yaml --config "$CLI_CONFIG"` },
];

test("owner empty states show one placeholder command and the existing Copy control", () => {
  for (const { scenario, scope, kind, title, command } of cases) {
    const dom = new JSDOM(html(snapshot(scenario)));
    try {
      const hint = dom.window.document.querySelector(`${scope} [data-first-run="${kind}"]`);
      assert.ok(hint, scenario);
      assert.equal(hint.querySelector("h2").textContent, title);
      assert.equal(hint.querySelectorAll("code").length, 1);
      assert.equal(hint.querySelector("code").textContent, command);
      assert.equal(hint.querySelectorAll('button[aria-label="Copy to clipboard"]').length, 1);
      assert.equal(hint.querySelectorAll("button").length, 1);
      assert.equal(hint.querySelectorAll("a, input, form, svg[role=img]").length, 0);
      assert.match(dom.window.document.body.textContent, /FIXTURE · OFFLINE/);
    } finally {
      dom.window.close();
    }
  }
});

test("agent empty states hide commands and actions and identify owner responsibility", () => {
  for (const scenario of ["empty-projects", "empty-agents", "empty-packets", "empty-forks", "empty-reviews"]) {
    const dom = new JSDOM(html(snapshot(scenario), false));
    try {
      const hints = dom.window.document.querySelectorAll("[data-first-run]");
      assert.ok(hints.length);
      for (const hint of hints) {
        assert.equal(hint.querySelectorAll("code, button, a").length, 0);
        const kind = hint.getAttribute("data-first-run");
        if (kind === "reviews") {
          assert.match(hint.textContent, /When an agent requests review of a commit, it appears here for the owner to approve and promote\.$/);
          assert.doesNotMatch(hint.textContent, /for you|The owner creates packets/);
        } else if (kind === "forks") {
          assert.match(hint.textContent, /Forks appear here when an agent claims a packet\.$/);
          assert.doesNotMatch(hint.textContent, /The owner creates packets/);
        } else {
          assert.match(hint.textContent, /The owner (?:enrolls agents|creates packets)\.$/);
        }
      }
    } finally {
      dom.window.close();
    }
  }
});

test("Overview shows one empty state with agents, packets, then forks precedence", () => {
  for (const [scenario, kind] of [["empty-agents", "agents"], ["empty-packets", "packets"], ["empty-forks", "forks"]]) {
    const view = snapshot(scenario);
    const dom = new JSDOM(html(view));
    try {
      const overview = dom.window.document.querySelector("#view-overview");
      assert.equal(overview.querySelectorAll("[data-first-run]").length, 1);
      const hint = overview.querySelector(`[data-first-run="${kind}"]`);
      assert.ok(hint);
      assert.equal(overview.querySelector(".fork-card"), null);
      assert.equal(hint.querySelectorAll("button").length, kind === "forks" ? 0 : 1);
      if (kind === "packets") assert.match(hint.textContent, /To race up to three agents on one packet, add mode: race to the packet file\./);
    } finally {
      dom.window.close();
    }
  }
  const historical = stateView(forkFixtureState("fork-hero", Date.now()));
  historical.claims = [];
  assert.equal(overviewFirstRun(historical), undefined);
  const dom = new JSDOM(html({ ...snapshot("demo"), state: historical }));
  try {
    assert.ok(dom.window.document.querySelector("#view-overview .fork-card"));
    assert.equal(dom.window.document.querySelector("#view-overview [data-first-run]"), null);
  } finally {
    dom.window.close();
  }
});

test("loading, failures and populated project views do not offer first-run actions", () => {
  const empty = snapshot("empty-projects");
  for (const view of [
    { ...empty, busy: true },
    { ...empty, error: "Snapshot unavailable" },
    { ...snapshot("demo"), state: stateView(fixtureState()) },
  ]) {
    const dom = new JSDOM(html(view));
    try {
      assert.equal(dom.window.document.querySelector("[data-first-run]"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("archive-only projects and an empty review queue with history retain existing states", () => {
  const state = stateView(fixtureState());
  for (const packet of state.packets)
    packet.archived = { at: "2026-10-14T12:00:00Z", by: "owner" };
  for (const review of state.reviews) review.status = "promoted";
  const dom = new JSDOM(html({ ...snapshot("demo"), state }));
  try {
    assert.equal(dom.window.document.querySelector('#packets [data-first-run="packets"]'), null);
    assert.match(dom.window.document.querySelector("#packets").textContent, /Show archived/);
    assert.equal(dom.window.document.querySelector('#reviews [data-first-run="reviews"]'), null);
    assert.match(dom.window.document.querySelector("#reviews").textContent, /No reviews waiting for owner action/);
  } finally {
    dom.window.close();
  }
});

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected first-run fixture UI did not appear");
};

test("owner guidance copies literal placeholders and Go to Work switches tabs without writes", async () => {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: "https://fixture.idiot.tax/#review" });
  installDom(dom.window);
  const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { async writeText(text: string) { copied.push(text); } },
  });
  const root = dom.window.document.getElementById("dashboard") as HTMLElement;
  let writes = 0;
  const wire = emptyFixtureState("empty-reviews");
  const app = mountDashboard(root, {
    brand: fixtureBrand, fixture: true,
    projects: [{ id: "empty-reviews", label: "Empty reviews fixture" }],
    transport: {
      async getState() { return stateView(wire); },
      async getActivity() { return { activity: [], nextAfter: 0 }; },
      async approve() { writes++; },
      async promote() { writes++; return { sha: "a".repeat(40) }; },
    },
  });
  try {
    await until(() => !!root.querySelector('#reviews [data-first-run="reviews"]'));
    const hint = root.querySelector('#reviews [data-first-run="reviews"]')!;
    assert.equal(hint.querySelectorAll("button").length, 1);
    assert.equal(hint.querySelector("code, a"), null);
    const go = hint.querySelector<HTMLButtonElement>("button")!;
    assert.equal(go.textContent, "Go to Work");
    go.click();
    await until(() => !root.querySelector<HTMLElement>("#view-work")!.hidden);
    assert.equal(dom.window.location.hash, "#work");
    // Simulate a later empty-agent snapshot through the existing read transport.
    wire.agents = [];
    await app.refresh();
    const agentsTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent === "Agents")!;
    agentsTab.click();
    await until(() => !root.querySelector<HTMLElement>("#view-agents")!.hidden);
    root.querySelector<HTMLButtonElement>('#lanes [aria-label="Copy to clipboard"]')!.click();
    await until(() => copied.length === 1);
    assert.deepEqual(copied, [cases[1]!.command]);
    assert.equal(writes, 0);
  } finally {
    app.dispose();
    dom.window.close();
    if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});


test("zero and unavailable races never invent a separate races empty state", () => {
  for (const available of [true, false]) {
    const view = snapshot("empty-races");
    if (!available) delete view.state!.races;
    const dom = new JSDOM(html(view, true, "work"));
    try {
      assert.equal(dom.window.document.querySelector('[data-first-run="races"]'), null);
      assert.doesNotMatch(dom.window.document.querySelector("#packets").textContent, /No races yet/);
      assert.ok(dom.window.document.querySelector("#packets table"));
    } finally {
      dom.window.close();
    }
  }
});
