import { RpcTarget } from "capnweb";
import { assertState } from "../../forkhorse-dashboard/src/model.ts";
import type { DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";
import type { SidebarBatch, SidebarUi, Subscription, UpdateReceiver } from "./ui-types.ts";

export const OWNER_UNAVAILABLE = "Approve and Promote are unavailable for this agent connection.";

function disposeStub(value: object | undefined) {
  if (value && Symbol.dispose in value) {
    const dispose = value[Symbol.dispose];
    if (typeof dispose === "function") dispose.call(value);
  }
}

/** One active session and at most one abandoned remote call awaiting settlement. */
export async function connectSidebar(
  initialUi: SidebarUi,
  onError: (message: string) => void,
  resubscribeTheme: (isCurrent: () => boolean) => Promise<void> = async () => {},
  acquireUi?: () => Promise<SidebarUi>,
) {
  let batch = await initialUi.snapshot();
  assertState(batch.state);
  if (!Number.isSafeInteger(batch.version) || batch.version < 0)
    throw new Error("Invalid sidebar version.");
  const project = batch.state.project.id;
  let closed = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const statusListeners = new Set<(paused: boolean) => void>();
  type Session = {
    generation: number;
    ui?: SidebarUi;
    receiver?: Receiver;
    subscription?: Subscription;
    pending?: Promise<unknown>;
    stalled: boolean;
  };
  let session: Session = { generation: 0, ui: initialUi, stalled: false };
  let running: { session: Session; promise: Promise<void> } | undefined;
  let abandoned: Promise<unknown> | undefined;
  const current = (value: Session) => !closed && value === session;

  function status(value: boolean) {
    if (closed || paused === value) return;
    paused = value;
    onError(value ? "Live updates paused." : "");
    for (const listener of statusListeners) listener(value);
  }
  function accept(owner: Session, next: SidebarBatch, snapshot = false): void {
    if (!current(owner)) return;
    assertState(next.state);
    if (
      next.state.project.id !== project ||
      !Number.isSafeInteger(next.version) ||
      next.version < 0
    )
      throw new Error("Invalid sidebar update.");
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
        void operation();
      }, delay);
  }
  async function observe<T>(owner: Session, operation: PromiseLike<T>): Promise<T> {
    const pending = Promise.resolve(operation);
    owner.pending = pending;
    const deadline = setTimeout(() => {
      if (!current(owner)) return;
      owner.stalled = true;
      status(true);
      // Give normal relay restoration time, then try a fresh capability without a call storm.
      schedule(reconnect, 60_000);
    }, 30_000);
    deadlines.add(deadline);
    try {
      const result = await pending;
      if (!current(owner)) {
        if (result && typeof result === "object") disposeStub(result);
        throw new Error("Sidebar session retired.");
      }
      return result;
    } finally {
      clearTimeout(deadline);
      deadlines.delete(deadline);
      if (owner.pending === pending) {
        owner.pending = undefined;
        owner.stalled = false;
      }
    }
  }
  async function release(owner: Session, remote = true) {
    if (owner.receiver) owner.receiver.active = false;
    owner.receiver = undefined;
    const previous = owner.subscription;
    owner.subscription = undefined;
    let closing: Promise<void> | undefined;
    try {
      if (remote) closing = previous?.close();
    } catch {
      /* Broken remote. */
    }
    disposeStub(previous);
    try {
      if (closing) await observe(owner, closing);
    } catch {
      /* Disconnected or retired. */
    }
  }
  function single(owner: Session, operation: () => Promise<void>): Promise<void> {
    if (!current(owner)) return Promise.resolve();
    if (running) return running.promise;
    const entry = { session: owner, promise: Promise.resolve() };
    running = entry;
    entry.promise = Promise.resolve()
      .then(operation)
      .catch(() => {
        if (!current(owner)) return; // Late failures cannot overwrite a recovered generation.
        status(true);
        schedule(reconnect, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
      })
      .finally(() => {
        if (running === entry) running = undefined;
      });
    return entry.promise;
  }
  function watch(owner: Session) {
    if (current(owner)) schedule(() => single(owner, () => poll(owner)), 30_000);
  }
  async function poll(owner: Session) {
    await release(owner);
    while (current(owner))
      accept(owner, await observe(owner, owner.ui!.waitForChanges(batch.version)));
  }
  class Receiver extends RpcTarget implements UpdateReceiver {
    active = true;
    readonly owner: Session;
    constructor(owner: Session) {
      super();
      this.owner = owner;
    }
    async receive(next: SidebarBatch) {
      if (!this.active || !current(this.owner)) return;
      accept(this.owner, next);
      watch(this.owner);
    }
  }
  async function subscribe(owner: Session) {
    try {
      owner.receiver = new Receiver(owner);
      const subscription = await observe(owner, owner.ui!.subscribe(owner.receiver));
      if (!current(owner)) {
        disposeStub(subscription);
        return;
      }
      owner.subscription = subscription;
      status(false);
      watch(owner);
    } catch {
      if (current(owner)) schedule(() => single(owner, () => poll(owner)), 0);
    }
  }
  async function recover(owner: Session) {
    await release(owner);
    if (!current(owner)) return;
    if (acquireUi) owner.ui = await observe(owner, acquireUi());
    else owner.ui = initialUi;
    // Host-local and current: apply theme even if the replacement UI snapshot then fails.
    await observe(
      owner,
      resubscribeTheme(() => current(owner)),
    );
    accept(owner, await observe(owner, owner.ui.snapshot()), true);
    if (current(owner)) await subscribe(owner);
  }
  async function reconnect(): Promise<void> {
    if (closed) return;
    clearTimeout(timer);
    if (running) {
      const old = running.session;
      if (!old.stalled) return running.promise;
      // A second hung attempt must wait while the first abandoned call is still outstanding.
      if (abandoned || !acquireUi) {
        schedule(reconnect, 60_000);
        return;
      }
      const pending = old.pending!;
      abandoned = pending;
      void pending.then(
        () => {
          if (abandoned === pending) abandoned = undefined;
        },
        () => {
          if (abandoned === pending) abandoned = undefined;
        },
      );
      session = { generation: old.generation + 1, stalled: false };
      running = undefined;
      // Local disposal must not add a remote close call behind the already hung operation.
      void release(old, false);
      disposeStub(old.ui);
    } else {
      const old = session;
      session = { generation: old.generation + 1, stalled: false };
      void release(old, false);
      if (acquireUi) disposeStub(old.ui);
    }
    const owner = session;
    return single(owner, () => recover(owner));
  }
  await single(session, async () => {
    const owner = session;
    await observe(
      owner,
      resubscribeTheme(() => current(owner)),
    );
    if (current(owner)) await subscribe(owner);
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
      reconnect,
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
      void release(session, false);
      if (acquireUi) disposeStub(session.ui);
    },
  };
}
