import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { checkConnectionDraft } from "../src/configuration.ts";
import { mountConfiguration } from "../src/configuration-form.ts";

const draft = { coreOrigin: "https://core.fixture.idiot.tax/", project: "fixture",
  agentCredential: "fixture-only-not-a-real-credential" };
test("draft format checks neither authenticate nor return credentials", () => {
  const result = checkConnectionDraft(draft);
  assert.equal(result.coreOrigin, "https://core.fixture.idiot.tax");
  assert.equal(result.connectionAvailable, false);
  assert.ok(!JSON.stringify(result).includes(draft.agentCredential));
  for (const coreOrigin of ["http://core.fixture.idiot.tax", "https://user:pass@core.fixture.idiot.tax",
    "https://core.fixture.idiot.tax/path", "https://127.0.0.1", "https://core.local",
    "https://core.fixture.idiot.tax/?token=sensitive", "https://core.fixture.idiot.tax:8443"]) {
    assert.throws(() => checkConnectionDraft({ ...draft, coreOrigin }), /HTTPS/);
  }
  assert.throws(() => checkConnectionDraft({ ...draft, project: "../foreign" }), /project ID/);
  assert.throws(() => checkConnectionDraft({ ...draft, agentCredential: "too short" }), /credential/);
});

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; Event: typeof Event; close(): void } };
};
for (const fail of [false, true]) test(`draft form clears credentials on ${fail ? "failure" : "success"} and never enables connection`, async (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById("root")!;
  const mounted = mountConfiguration(root, async (input) => {
    assert.equal(input.agentCredential, draft.agentCredential);
    if (fail) throw new Error(draft.agentCredential);
    return checkConnectionDraft(input);
  });
  t.after(() => mounted.dispose());
  for (const [name, value] of Object.entries(draft))
    root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = value;
  root.querySelector<HTMLButtonElement>("form button")!.click();
  await turn();
  assert.equal(root.querySelector<HTMLInputElement>('[name="agentCredential"]')!.value, "");
  assert.ok(root.querySelector<HTMLButtonElement>('button[data-create]')!.disabled);
  assert.ok(!root.textContent!.includes(draft.agentCredential));
  assert.match(root.textContent!, fail ? /format check failed/ : /Format checked for fixture/);
});
