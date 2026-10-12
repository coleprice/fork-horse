import { RpcTarget } from "capnweb";
import { assertState } from "../../forkhorse-dashboard/src/model.ts";
import type { DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";
import type { SidebarBatch, SidebarUi, Subscription, UpdateReceiver } from "./ui-types.ts";

export const OWNER_UNAVAILABLE = "Approve and Promote are unavailable for this agent connection.";

/** One owned subscription or long poll, with a single bounded retry timer. */
export async function connectSidebar(
  ui: SidebarUi,
  onError: (message: string) => void,
  resubscribeTheme: () => Promise<void> = async () => {},
) {
  let batch = await ui.snapshot();
  assertState(batch.state);
  if (!Number.isSafeInteger(batch.version) || batch.version < 0)
    throw new Error("Invalid sidebar version.");
  const project = batch.state.project.id;
  let closed = false;
  let paused = false;
  let subscription: Subscription | undefined;
  let receiver: Receiver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let failures = 0;
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const statusListeners = new Set<(paused: boolean) => void>();

  function status(value: boolean) {
    if (closed || paused === value) return;
    paused = value;
    onError(value ? "Live updates paused." : "");
    for (const listener of statusListeners) listener(value);
  }
  function accept(next: SidebarBatch, snapshot = false): void {
    if (closed) return;
    assertState(next.state);
    if (
      next.state.project.id !== project ||
      !Number.isSafeInteger(next.version) ||
      next.version < 0
    )
      throw new Error("Invalid sidebar update.");
    // A fresh snapshot may reset the session-local version after a Worker restart.
    if (!snapshot && next.version < batch.version) throw new Error("Sidebar version moved back.");
    if (snapshot || next.version > batch.version) {
      batch = next;
      for (const listener of listeners) listener();
    }
    status(false);
    failures = 0;
  }
  function schedule(operation: () => Promise<void>, delay: number) {
    clearTimeout(timer);
    if (!closed)
      timer = setTimeout(() => {
        timer = undefined;
        void single(operation);
      }, delay);
  }
  async function observe<T>(operation: PromiseLike<T>): Promise<T> {
    // A broken upstream relay can leave a call pending indefinitely. Show the cached view's
    // warning after 30s, but never race an uncancellable remote call with new retries.
    const deadline = closed ? undefined : setTimeout(() => status(true), 30_000);
    if (deadline) deadlines.add(deadline);
    try { return await operation; } finally {
      clearTimeout(deadline);
      if (deadline) deadlines.delete(deadline);
    }
  }
  async function release() {
    if (receiver) receiver.active = false;
    receiver = undefined;
    const previous = subscription;
    subscription = undefined;
    let closing: Promise<void> | undefined;
    try { closing = previous?.close(); } catch { /* Broken remote. */ }
    // Release our local stub immediately, even when the remote close never settles.
    if (previous && Symbol.dispose in previous) {
      const dispose = previous[Symbol.dispose];
      if (typeof dispose === "function") dispose.call(previous);
    }
    try { if (closing) await observe(closing); } catch { /* Already disconnected. */ }
  }
  async function single(operation: () => Promise<void>): Promise<void> {
    if (closed) return;
    if (running) return running;
    // Defer execution so synchronous callbacks cannot start an overlapping operation.
    running = Promise.resolve()
      .then(operation)
      .catch(() => {
        status(true);
        schedule(recover, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }
  function watch() {
    // Quiet projects are normal. A long poll distinguishes quiet from a broken callback.
    schedule(poll, 30_000);
  }
  async function poll() {
    await release();
    while (true) {
      if (closed) break;
      // One outstanding poll (server timeout 25s), never a burst of health checks.
      accept(await observe(ui.waitForChanges(batch.version)));
    }
  }
  class Receiver extends RpcTarget implements UpdateReceiver {
    active = true;
    async receive(next: SidebarBatch) {
      if (!this.active || closed) return;
      accept(next);
      watch();
    }
  }
  async function subscribe() {
    try {
      receiver = new Receiver();
      subscription = await observe(ui.subscribe(receiver));
      if (closed) {
        await release();
        return;
      }
      status(false);
      watch();
    } catch {
      // Hosts without push support still receive updates through the bounded fallback.
      schedule(poll, 0);
    }
  }
  async function recover() {
    await release();
    if (closed) return;
    // Theme is host-local; renew even if the UI capability remains unavailable.
    await observe(resubscribeTheme());
    const next = await observe(ui.snapshot());
    if (closed) return;
    accept(next, true);
    await subscribe();
  }
  await single(async () => {
    await observe(resubscribeTheme());
    await subscribe();
  });
  function requireProject(id: string) {
    if (id !== project) throw new Error("This sidebar connection is bound to another project.");
  }
  const transport: DashboardTransport = {
    live: {
      subscribe(listener) {
        statusListeners.add(listener);
        listener(paused);
        return () => statusListeners.delete(listener);
      },
      async reconnect() {
        clearTimeout(timer);
        // An active long poll owns the remote call until it settles; do not race it.
        if (running) return running;
        await single(recover);
      },
    },
    async getState(id) {
      requireProject(id);
      return structuredClone(batch.state);
    },
    async getActivity(id, after = 0) {
      requireProject(id);
      const activity = (batch.state.recentActivity ?? []).filter((event) => event.sequence > after);
      return { activity, nextAfter: activity.at(-1)?.sequence ?? after };
    },
    async approve() {
      throw new Error(OWNER_UNAVAILABLE);
    },
    async promote() {
      throw new Error(OWNER_UNAVAILABLE);
    },
    subscribe(id, invalidate) {
      requireProject(id);
      listeners.add(invalidate);
      return () => listeners.delete(invalidate);
    },
  };
  return {
    project,
    transport,
    dispose() {
      closed = true;
      clearTimeout(timer);
      for (const deadline of deadlines) clearTimeout(deadline);
      deadlines.clear();
      listeners.clear();
      statusListeners.clear();
      void release();
    },
  };
}
