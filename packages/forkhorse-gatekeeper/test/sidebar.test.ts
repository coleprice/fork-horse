import { installDom } from "../../forkhorse-dashboard/test/dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { newMessagePortRpcSession } from "capnweb";
import { createRateLimitedCapability } from "../../../cloudflare-os/packages/workshop-frontend/src/rateLimitedCapability.ts";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { SnapshotFeed } from "../src/feed.ts";
import { connectSidebar, OWNER_UNAVAILABLE } from "../src/client.ts";
import { mountSidebar } from "../src/mount.ts";
import type { SidebarUi } from "../src/ui-types.ts";
import { FixtureUi } from "./fixture-ui.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => {
    window: { document: Document; MouseEvent: typeof MouseEvent; close(): void };
  };
};
const fixture = () => stateView(fixtureState());
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await turn();
  assert.ok(predicate(), "asynchronous condition settled");
}

function connection(push = true) {
  const feed = new SnapshotFeed(fixture());
  const service = new FixtureUi(feed, push);
  // Actual frozen upstream limiter, not a copy of its budget math.
  const limited = createRateLimitedCapability(service, {
    maxConcurrency: 8,
    maxCallsPerMinute: 600,
    maxPendingCalls: 128,
    onRateLimit: "throttle",
    label: "Fixture sidebar",
  });
  const { port1, port2 } = new MessageChannel();
  const server = newMessagePortRpcSession(port2, limited.capability);
  const remote = newMessagePortRpcSession<SidebarUi>(port1);
  return {
    feed,
    service,
    remote,
    close() {
      feed.dispose();
      limited.dispose();
      server[Symbol.dispose]();
      remote[Symbol.dispose]();
      port1.close();
      port2.close();
    },
  };
}

test("240 quarter-second pushed batches traverse RPC and pinned limiter without inbound refresh calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const link = connection();
  t.after(() => link.close());
  const errors: string[] = [];
  const client = await connectSidebar(link.remote, (message) => errors.push(message));
  t.after(() => client.dispose());
  let changes = 0;
  client.transport.subscribe!(client.project, () => changes++);
  for (let i = 1; i <= 240; i++) {
    const state = fixture();
    state.packets[0]!.title = `Fixture ${i}`;
    link.feed.publish(state);
    t.mock.timers.tick(250);
    await until(() => changes === i);
  }
  assert.equal((await client.transport.getState("demo")).packets[0]!.title, "Fixture 240");
  assert.deepEqual(link.service.calls, { snapshot: 1, subscribe: 1, poll: 0 });
  assert.deepEqual(errors, []);
  await assert.rejects(client.transport.approve("demo", "review-1"), {
    message: OWNER_UNAVAILABLE,
  });
  await assert.rejects(client.transport.promote("demo", "review-1"), {
    message: OWNER_UNAVAILABLE,
  });
  await assert.rejects(client.transport.getState("other"), /another project/);
});

test("fallback uses one long poll and stays below 600 calls for 240 batches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const link = connection(false);
  t.after(() => link.close());
  const errors: string[] = [];
  const client = await connectSidebar(link.remote, (message) => errors.push(message));
  t.after(() => client.dispose());
  let changes = 0;
  client.transport.subscribe!(client.project, () => changes++);
  for (let i = 1; i <= 240; i++) {
    const state = fixture();
    state.packets[0]!.title = `Fallback ${i}`;
    link.feed.publish(state);
    t.mock.timers.tick(250);
    await until(() => changes === i);
  }
  assert.ok(link.service.calls.poll <= 241);
  assert.equal(link.service.calls.snapshot, 1);
  assert.deepEqual(errors, []);
});

test("feed coalesces bursts and slow receivers, releases polls, refuses cross-project state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feed = new SnapshotFeed(fixture());
  t.after(() => feed.dispose());
  let release!: () => void;
  const received: number[] = [];
  let disposed = 0;
  const close = feed.subscribe({
    async receive(batch) {
      received.push(batch.version);
      if (batch.version === 0)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
    dispose() {
      disposed++;
    },
  });
  await until(() => received.length === 1);
  for (let i = 0; i < 20; i++) feed.publish(fixture());
  const waiting = feed.waitForChanges(0);
  await assert.rejects(feed.waitForChanges(0), /one pending poll/);
  t.mock.timers.tick(250);
  assert.equal((await waiting).version, 1);
  feed.publish(fixture());
  t.mock.timers.tick(250);
  assert.deepEqual(received, [0]);
  release();
  await until(() => received.length === 2);
  assert.deepEqual(received, [0, 2]);
  const state = fixture();
  state.project.id = "foreign";
  assert.throws(() => feed.publish(state), /bound to one project/);
  await assert.rejects(feed.waitForChanges(99), /Invalid UI version/);
  const timeout = feed.waitForChanges(2);
  t.mock.timers.tick(25_000);
  assert.equal((await timeout).version, 2);
  close();
  assert.equal(disposed, 1);
  const pending = feed.waitForChanges(2);
  feed.dispose();
  await assert.rejects(pending, /closed/);
});

for (const fixtureMode of [true, false])
  test(`dashboard renders with fixture=${fixtureMode}, owner actions disabled, and host openPrompt`, async (t) => {
    const dom = new JSDOM('<div id="root"></div>');
    t.after(() => dom.window.close());
    const link = connection();
    t.after(() => link.close());
    const client = await connectSidebar(link.remote, () => {});
    t.after(() => client.dispose());
    installDom(dom.window as unknown as Window & typeof globalThis);
    const root = dom.window.document.getElementById("root")!;
    const prompts: string[] = [];
    const view = mountSidebar(root, {
      brand: { name: "Fixture product", tagline: "Fixture collaboration" },
      project: client.project,
      transport: client.transport,
      fixture: fixtureMode,
      async openPrompt(prompt) {
        prompts.push(prompt);
      },
    });
    t.after(() => view.dispose());
    await until(() => !!root.querySelector('button[data-action="approve"]'));
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      'button[data-action="approve"], button[data-action="promote"]',
    )) {
      assert.ok(button.disabled);
      assert.match(
        root.querySelector(".agent-notice")!.textContent!,
        /Promote and approve stay with the owner/,
      );
      // Even a synthetic dispatch that skips HTML disabled behavior is capture-blocked.
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    }
    const ask = [...root.querySelectorAll("button")].find(
      (button) => button.textContent === "Ask an agent",
    )!;
    ask.click();
    await until(() => prompts.length === 1);
    assert.equal(prompts[0], "Help me review project demo in Fixture product.");
    assert.match(root.textContent!, /your pushes need approval on your fork/);
    assert.ok(root.querySelector(".tab-gutter + .content .agent-notice"));
    assert.ok(root.querySelector(".page-header [data-action=ask]"));
    if (fixtureMode) assert.match(root.textContent!, /FIXTURE · OFFLINE/);
    assert.doesNotMatch(
      root.textContent!,
      /Owner workspace|Owner Access session|Owner actions are authorized/,
    );
    assert.equal(root.querySelector(".sidebar, .topbar"), null);
    assert.equal(root.querySelector<HTMLElement>("#open-project")!.hidden, true);
    const reviewTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
      button.textContent!.startsWith("Review"),
    )!;
    reviewTab.click();
    await until(() => !root.querySelector<HTMLElement>("#view-review")!.hidden);
    assert.equal(root.querySelectorAll('[role="tab"]').length, 4);
  });

test("silent push channel falls back after 30 seconds without overlapping polls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const link = connection();
  t.after(() => link.close());
  const client = await connectSidebar(link.remote, () => {});
  t.after(() => client.dispose());
  await turn();
  t.mock.timers.tick(30_000);
  await until(() => link.service.calls.poll === 1);
  assert.equal(link.service.calls.snapshot, 1);
  let updates = 0;
  client.transport.subscribe!("demo", () => updates++);
  link.feed.publish(fixture());
  t.mock.timers.tick(250);
  await until(() => updates === 1);
  assert.ok(link.service.calls.poll <= 2);
});
