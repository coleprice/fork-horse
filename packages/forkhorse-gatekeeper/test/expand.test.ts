import { installDom } from "../../forkhorse-dashboard/test/dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { getByRole, queryByRole } from "../../forkhorse-dashboard/test/roles.ts";
import { framePresentation, mountSidebar } from "../src/mount.ts";

// DOM fixtures only. The browser fixture and pinned OS review verify real frame geometry.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const ack = { rect: null, willResize: false };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await turn();
  assert.ok(predicate(), "fixture condition settled");
}
function setup(setPresenting?: (active: boolean) => Promise<typeof ack>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://os.fixture.idiot.tax/" });
  installDom(dom.window);
  const root = dom.window.document.getElementById("root") as HTMLElement;
  const view = mountSidebar(root, {
    brand: { name: "Fixture product", tagline: "Fixture collaboration" },
    project: "demo", fixture: true, setPresenting,
    openPrompt: async () => {},
    transport: {
      getState: async () => stateView(fixtureState()),
      getActivity: async () => ({ activity: [], nextAfter: 0 }),
      approve: async () => { throw new Error("Agent cannot approve"); },
      promote: async () => { throw new Error("Agent cannot promote"); },
    },
  });
  return { dom, root, view, close() { view.dispose(); dom.window.close(); } };
}

test("Expand is optional; its label, icon and pressed state flip without losing focus", async (t) => {
  const calls: boolean[] = [];
  const f = setup(async (active) => { calls.push(active); return ack; });
  t.after(() => f.close());
  await until(() => !!f.root.querySelector(".fork-card"));
  const expand = getByRole(f.root, "button", { name: "Expand" });
  const icon = expand.querySelector("svg")!.innerHTML;
  const activity = getByRole(f.root, "button", { name: "Hide activity" });
  assert.ok(expand.compareDocumentPosition(activity) & 4, "Expand precedes Activity");
  expand.focus();
  expand.click();
  await until(() => expand.getAttribute("aria-label") === "Exit full view");
  assert.equal(expand.getAttribute("aria-pressed"), "true");
  assert.notEqual(expand.querySelector("svg")!.innerHTML, icon);
  assert.equal(f.dom.window.document.activeElement, expand);
  for (const name of ["Work", "Agents", "Races", "Overview"]) {
    getByRole(f.root, "tab", { name: new RegExp(`^${name}`) }).click();
    await turn();
  }
  assert.equal(f.root.querySelectorAll(".fork-card").length, 1);
  assert.equal(getByRole(f.root, "button", { name: "Exit full view" }), expand);
  expand.click();
  await until(() => expand.getAttribute("aria-label") === "Expand");
  assert.equal(expand.getAttribute("aria-pressed"), "false");
  assert.equal(expand.querySelector("svg")!.innerHTML, icon);
  assert.deepEqual(calls, [true, false]);
  for (const name of ["Work", "Overview"]) {
    getByRole(f.root, "tab", { name: new RegExp(`^${name}`) }).click();
    await turn();
  }
  assert.equal(f.root.querySelectorAll(".fork-card").length, 1);
});

test("no presentation option renders no Expand", async (t) => {
  const f = setup();
  t.after(() => f.close());
  assert.equal(queryByRole(f.root, "button", { name: "Expand" }), null);
});

test("Escape closes the Kumo Activity dialog first, then exits full view", async (t) => {
  const calls: boolean[] = [];
  const f = setup(async (active) => { calls.push(active); return ack; });
  t.after(() => f.close());
  getByRole(f.root, "button", { name: "Expand" }).click();
  await until(() => !!queryByRole(f.root, "button", { name: "Exit full view" }));
  f.dom.window.innerWidth = 800;
  f.dom.window.dispatchEvent(new f.dom.window.Event("resize"));
  await until(() => !!f.dom.window.document.querySelector('[role="dialog"]'));
  const escape = () => f.dom.window.document.activeElement.dispatchEvent(
    new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  escape();
  await until(() => !f.dom.window.document.querySelector('[role="dialog"]:not([data-closed])'));
  assert.equal(calls.at(-1), true, "dialog dismissal does not exit full view");
  escape();
  await until(() => !!queryByRole(f.root, "button", { name: "Expand" }));
  assert.equal(calls.at(-1), false);
  const count = calls.length;
  escape();
  assert.equal(calls.length, count, "collapsed Escape does nothing");
});

test("reconnect reset and dispose restore the host, ignoring late opening acknowledgements", async (t) => {
  const calls: boolean[] = [];
  let release!: (ack: { rect: null; willResize: boolean }) => void;
  const f = setup((active) => {
    calls.push(active);
    return active ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(ack);
  });
  t.after(() => f.close());
  getByRole(f.root, "button", { name: "Expand" }).click();
  await until(() => !!queryByRole(f.root, "button", { name: "Exit full view" }));
  f.view.resetPresentation();
  release(ack);
  await until(() => !!queryByRole(f.root, "button", { name: "Expand" }));
  assert.equal(calls.at(-1), false);
  getByRole(f.root, "button", { name: "Expand" }).click();
  f.view.dispose();
  release(ack);
  await turn();
  assert.equal(calls.at(-1), false);
  assert.equal(f.root.childElementCount, 0);
});

test("rejected host presentation remains collapsed and restores with false", async () => {
  const calls: boolean[] = [];
  const presentation = framePresentation(async (active) => {
    calls.push(active);
    if (active) throw new Error("Fixture unsupported host");
    return ack;
  });
  presentation.toggle();
  await turn();
  assert.equal(presentation.getSnapshot(), false);
  assert.deepEqual(calls, [true, false]);
  presentation.dispose();
});
