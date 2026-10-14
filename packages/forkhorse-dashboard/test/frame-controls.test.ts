import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { fixtureState } from "./fixtures.ts";
import { stateView } from "../src/model.ts";
import { queryByRole } from "./roles.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
test("owner dashboard never renders agent banner, frame control", (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  installDom(dom.window);
  const root = dom.window.document.getElementById("root") as HTMLElement;
  let calls = 0;
  const view = mountDashboard(root, {
    brand: { name: "Fixture product", tagline: "Fixture collaboration" },
    initialProject: "demo", owner: true,
    // Even accidental host metadata must not add these controls to the owner surface.
    framePresentation: {
      getSnapshot: () => false,
      subscribe: () => () => {},
      toggle: () => { calls++; },
      reset: () => { calls++; },
    },
    transport: {
      getState: async () => stateView(fixtureState()),
      getActivity: async () => ({ activity: [], nextAfter: 0 }),
      approve: async () => {},
      promote: async () => ({ sha: "fixture" }),
    },
  });
  t.after(() => { view.dispose(); dom.window.close(); });
  assert.equal(queryByRole(root, "button", { name: "Expand" }), null);
  assert.equal(root.querySelector(".agent-notice"), null);
  assert.equal(calls, 0);
});
