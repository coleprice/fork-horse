import { installDom } from "../../forkhorse-dashboard/test/dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { getByRole, queryByRole } from "../../forkhorse-dashboard/test/roles.ts";
import { mountSidebar, ownerLink } from "../src/mount.ts";

// DOM fixtures only. The browser fixture and pinned OS review verify real frame geometry.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const origin = "https://core.fixture.idiot.tax";
const expected = `${origin}/app?project=demo`;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await turn();
  assert.ok(predicate(), "fixture condition settled");
}
function setup(coreOrigin = origin) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://os.fixture.idiot.tax/" });
  installDom(dom.window);
  const root = dom.window.document.getElementById("root") as HTMLElement;
  const view = mountSidebar(root, {
    brand: { name: "Fixture product", tagline: "Fixture collaboration" },
    project: "demo", coreOrigin, fixture: true,
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

test("copy success writes exactly the public owner URL and announces it", async (t) => {
  const f = setup();
  t.after(() => f.close());
  const copied: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { copied.push(text); },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  getByRole(f.root, "button", { name: "Copy owner link" }).click();
  await until(() => f.root.textContent!.includes("Owner link copied."));
  assert.deepEqual(copied, [expected]);
  assert.match(getByRole(f.root, "button", { name: "Copy owner link" }).textContent!, /Copied/);
  assert.equal(f.root.querySelector(".owner-link-action [role=status]")!.textContent, "Owner link copied.");
});

test("clipboard denial replaces the action with focused, selected URL text", async (t) => {
  const f = setup();
  t.after(() => f.close());
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async () => { throw new Error("Fixture sandbox clipboard denial"); },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  getByRole(f.root, "button", { name: "Copy owner link" }).click();
  await until(() => !!f.root.querySelector(".owner-link-fallback code"));
  const code = f.root.querySelector(".owner-link-fallback code")!;
  assert.equal(code.textContent, expected);
  assert.equal(f.dom.window.document.activeElement, code);
  assert.equal(f.dom.window.getSelection()!.toString(), expected);
  assert.equal(queryByRole(f.root, "button", { name: "Copy owner link" }), null);
  assert.equal(f.root.querySelector(".owner-link-action [role=status]")!.textContent, "");
});

test("owner URL rejects missing, credential-bearing or non-origin input", () => {
  assert.equal(ownerLink(origin, "demo"), expected);
  assert.equal(ownerLink(`${origin}/`, "demo"), expected);
  for (const value of [undefined, "", "null", "http://core.fixture.idiot.tax", `${origin}/api`,
    `${origin}?token=fixture`, `${origin}#fragment`, "https://agent:fixture@core.fixture.idiot.tax"]) {
    assert.equal(ownerLink(value, "demo"), undefined);
  }
  assert.equal(ownerLink(origin, "demo&token=fixture"), undefined);
});

test("missing or invalid public origin leaves the agent banner without an owner-link control", () => {
  for (const value of ["", "null", `${origin}?token=fixture`]) {
    const f = setup(value);
    try {
      assert.ok(f.root.querySelector(".agent-notice"));
      assert.equal(queryByRole(f.root, "button", { name: "Copy owner link" }), null);
      assert.equal(f.root.querySelector(".owner-link-action"), null);
    } finally { f.close(); }
  }
});
