import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sidebarAccountDescription, type WorkerUpdateReceiver } from "../src/worker/sidebar.ts";
import type { SidebarBatch } from "../src/ui-types.ts";
import type { FixtureHarness } from "./worker.ts";
import brand from "../../../brand.json";

declare global {
  namespace Cloudflare { interface Env { FIXTURE: Service<FixtureHarness> } }
}

class Receiver extends RpcTarget implements WorkerUpdateReceiver {
  readonly batches: SidebarBatch[] = [];
  async receive(batch: SidebarBatch): Promise<void> { this.batches.push(batch); }
}

async function refuses(operation: () => PromiseLike<unknown>, message = ""): Promise<void> {
  try { await operation(); } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
    return;
  }
  throw new Error("Expected RPC refusal.");
}

describe("Worker-native sidebar capability (local fixtures)", () => {
  it("checks a configurator draft through native RPC without echoing its credential or granting a connection", async () => {
    using draft = await env.FIXTURE.configurator();
    const result = await draft.checkDraft({ coreOrigin: "https://core.fixture.idiot.tax",
      project: "fixture", agentCredential: "fixture-only-not-a-real-credential" });
    expect(result.connectionAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-only-not-a-real-credential");
    await refuses(() => draft.checkDraft({ coreOrigin: "http://127.0.0.1",
      project: "fixture", agentCredential: "fixture-only-not-a-real-credential" }), "HTTPS");
  });
  it("runs under workerd and derives sidebar metadata from branding", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(sidebarAccountDescription()).toMatchObject({ displayName: brand.name, providesUi: { title: brand.name } });
    expect(sidebarAccountDescription().singleton).toBeUndefined();
  });

  it("authorizes before returning a capability", async () => {
    expect(await env.FIXTURE.deniedSetup()).toMatchObject({ opened: false, reads: 0 });
  });

  it("releasing the UI capability stops its producer", async () => {
    using session = await env.FIXTURE.session();
    {
      using ui = await session.open();
      await ui.snapshot();
    }
    await vi.waitFor(async () => expect(await session.stopped()).toBe(1));
  });

  it("retains push callbacks across RPC and closes subscriptions", async () => {
    using session = await env.FIXTURE.session();
    using ui = await session.open();
    expect((await ui.snapshot()).state.project.id).toBe("fixture");
    const receiver = new Receiver();
    using subscription = await ui.subscribe(receiver);
    await vi.waitFor(() => expect(receiver.batches).toHaveLength(1));
    await session.publish();
    await vi.waitFor(() => expect(receiver.batches.at(-1)?.version).toBe(1));
    expect(receiver.batches.at(-1)?.state.packets).toHaveLength(1);
    await subscription.close();
    await subscription.close();
    await session.publish();
    await vi.waitFor(async () => expect((await ui.snapshot()).version).toBe(2));
    expect(receiver.batches).toHaveLength(2);
  });

  it("bounds pending polls, wakes on a batch, and rejects forged cursors", async () => {
    using session = await env.FIXTURE.session();
    using ui = await session.open();
    const pending = ui.waitForChanges(0);
    await refuses(() => ui.waitForChanges(0), "one pending poll");
    await session.publish();
    expect((await pending).version).toBe(1);
    await refuses(() => ui.waitForChanges(-1), "Invalid UI version");
    await refuses(() => ui.waitForChanges(99), "Invalid UI version");
  });

  it("revocation stops the producer and rejects already-waiting reads", async () => {
    using session = await env.FIXTURE.session();
    using ui = await session.open();
    const pending = ui.waitForChanges(0);
    const rejected = refuses(() => pending);
    await session.revoke();
    await rejected;
    await refuses(() => ui.snapshot(), "unavailable");
    expect(await session.stopped()).toBe(1);
  });

  it("rechecks authorization before a callback even without a revocation notification", async () => {
    using session = await env.FIXTURE.session();
    using ui = await session.open();
    const receiver = new Receiver();
    using _subscription = await ui.subscribe(receiver);
    await vi.waitFor(() => expect(receiver.batches).toHaveLength(1));
    await session.revoke(false);
    await session.publish();
    await vi.waitFor(async () => expect(await session.stopped()).toBe(1));
    expect(receiver.batches).toHaveLength(1);
    await refuses(() => ui.snapshot(), "unavailable");
  });

  it("closes instead of leaking a foreign project emitted by its producer", async () => {
    using session = await env.FIXTURE.session();
    using ui = await session.open();
    await session.foreign();
    await refuses(() => ui.snapshot(), "unavailable");
    expect(await session.stopped()).toBe(1);
  });
});
