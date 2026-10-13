import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sidebarAccountDescription, type WorkerUpdateReceiver } from "../src/worker/sidebar.ts";
import type { SidebarBatch } from "../src/ui-types.ts";
import type { FixtureHarness } from "./worker.ts";
import brand from "../../../brand.json";
import { markIconUrl } from "../../forkhorse-dashboard/src/mark.ts";
import { railIconUrl } from "../src/rail-icon.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      FIXTURE: Service<FixtureHarness>;
    }
  }
}

class Receiver extends RpcTarget implements WorkerUpdateReceiver {
  readonly batches: SidebarBatch[] = [];
  async receive(batch: SidebarBatch): Promise<void> {
    this.batches.push(batch);
  }
}

async function refuses(operation: () => PromiseLike<unknown>, message = ""): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
    return;
  }
  throw new Error("Expected RPC refusal.");
}

describe("Worker-native sidebar capability (local fixtures)", () => {
  it("checks a configurator draft through native RPC without echoing its credential or granting a connection", async () => {
    using draft = await env.FIXTURE.configurator();
    const result = await draft.checkDraft({
      coreOrigin: "https://core.fixture.idiot.tax",
      project: "fixture",
      agentCredential: "fixture-only-not-a-real-credential",
    });
    expect(result.connectionAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-only-not-a-real-credential");
    await refuses(
      () =>
        draft.checkDraft({
          coreOrigin: "http://127.0.0.1",
          project: "fixture",
          agentCredential: "fixture-only-not-a-real-credential",
        }),
      "HTTPS",
    );
  });
  it("runs under workerd and keeps the emoji avatar separate from the regular Horse rail icon", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(sidebarAccountDescription()).toMatchObject({
      displayName: brand.name,
      providesUi: { title: brand.name },
    });
    expect(sidebarAccountDescription().singleton).toBeUndefined();
    const icon = { url: markIconUrl(brand.mark) };
    const description = sidebarAccountDescription();
    expect(description.avatar).toEqual(icon);
    expect(description.providesUi!.icon).toEqual({ url: railIconUrl(brand.railIcon) });
    expect(description.providesUi!.icon).not.toEqual(icon);
    const svg = decodeURIComponent(description.providesUi!.icon!.url.split(",").slice(1).join(","));
    expect(svg).toContain('viewBox="0 0 256 256" fill="currentColor"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    const path = /<path d="([^"]+)"/.exec(svg)![1]!;
    // Independently recorded from Phosphor 2.1.10's regular definition, not another weight.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""))
      .toBe("0003357977cd1a2ac5cf9cf1606a93830a72be0069dcb9434428c18e3c8a1232");
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

it("replaces and releases native subscriptions after reconnect without leaking callbacks", async () => {
  using session = await env.FIXTURE.session();
  using ui = await session.open();
  const first = new Receiver();
  using old = await ui.subscribe(first);
  await vi.waitFor(() => expect(first.batches.length).toBe(1));
  await old.close();
  const second = new Receiver();
  using replacement = await ui.subscribe(second);
  await session.publish();
  await vi.waitFor(() => expect(second.batches.at(-1)?.version).toBe(1));
  expect(first.batches.length).toBe(1);
  await replacement.close();
  await session.publish();
  await vi.waitFor(async () => expect((await ui.snapshot()).version).toBe(2));
  expect(second.batches.at(-1)?.version).toBe(1);
});
