import { RpcTarget } from "capnweb";
import { assertState } from "../../forkhorse-dashboard/src/model.ts";
import type { DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";
import type { SidebarBatch, SidebarUi, Subscription, UpdateReceiver } from "./ui-types.ts";

export const OWNER_UNAVAILABLE = "Approve and Promote are unavailable for this agent connection.";

/** One snapshot and one subscription; updates need no per-batch inbound snapshot RPCs. */
export async function connectSidebar(ui: SidebarUi, onError: (message: string) => void) {
  let batch = await ui.snapshot();
  assertState(batch.state);
  if (!Number.isSafeInteger(batch.version) || batch.version < 0)
    throw new Error("Invalid sidebar version.");
  const project = batch.state.project.id;
  let closed = false;
  let polling = false;
  let subscription: Subscription | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function accept(next: SidebarBatch): void {
    if (closed) return;
    assertState(next.state);
    if (next.state.project.id !== project || !Number.isSafeInteger(next.version) || next.version < 0)
      throw new Error("Invalid sidebar update.");
    if (next.version <= batch.version) return;
    batch = next;
    for (const listener of listeners) listener();
  }

  async function poll(): Promise<void> {
    if (closed || polling) return;
    polling = true;
    clearTimeout(watchdog);
    try {
      await subscription?.close();
      while (true) {
        if (closed) break;
        accept(await ui.waitForChanges(batch.version));
      }
    } catch {
      if (!closed) onError("Activity connection lost. Reopen the sidebar to reconnect.");
    }
  }

  function watch(): void {
    clearTimeout(watchdog);
    if (!closed && !polling) watchdog = setTimeout(() => void poll(), 30_000);
  }

  class Receiver extends RpcTarget implements UpdateReceiver {
    async receive(next: SidebarBatch): Promise<void> {
      accept(next);
      watch();
    }
  }
  const receiver = new Receiver();
  try {
    subscription = await ui.subscribe(receiver);
    watch();
  } catch {
    void poll();
  }

  function requireProject(id: string): void {
    if (id !== project) throw new Error("This sidebar connection is bound to another project.");
  }

  const transport: DashboardTransport = {
    async getState(id) {
      requireProject(id);
      return structuredClone(batch.state);
    },
    async getActivity(id, after = 0) {
      requireProject(id);
      const activity = (batch.state.recentActivity ?? []).filter((event) => event.sequence > after);
      return { activity, nextAfter: activity.at(-1)?.sequence ?? after };
    },
    async approve() { throw new Error(OWNER_UNAVAILABLE); },
    async promote() { throw new Error(OWNER_UNAVAILABLE); },
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
      clearTimeout(watchdog);
      listeners.clear();
      void subscription?.close().catch(() => {});
    },
  };
}
