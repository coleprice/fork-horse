import type { ProjectState } from "../../forkhorse-dashboard/src/contracts.ts";
import type { SidebarBatch } from "./ui-types.ts";

type Receiver = { receive(batch: SidebarBatch): Promise<void>; dispose(): void };
type Sink = { receiver: Receiver; busy: boolean; pending?: SidebarBatch };

/** Host-owned state holder; never expose this object as an iframe capability. */
export class SnapshotFeed {
  #batch: SidebarBatch;
  #sink?: Sink;
  #timer?: ReturnType<typeof setTimeout>;
  #pending?: ProjectState;
  #wait?: { resolve(batch: SidebarBatch): void; reject(error: Error): void };
  #waitTimer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(initial: ProjectState) {
    this.#batch = { version: 0, state: structuredClone(initial) };
  }

  snapshot(): SidebarBatch {
    this.#assertOpen();
    return structuredClone(this.#batch);
  }

  /** Coalesce bursts at 250ms. A slow receiver retains at most one latest snapshot. */
  publish(state: ProjectState): void {
    this.#assertOpen();
    if (state.project.id !== this.#batch.state.project.id)
      throw new Error("A sidebar session is bound to one project.");
    this.#pending = structuredClone(state);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#batch = { version: this.#batch.version + 1, state: this.#pending! };
      this.#pending = undefined;
      const wait = this.#wait;
      this.#clearWait();
      wait?.resolve(this.snapshot());
      if (this.#sink) {
        this.#sink.pending = this.snapshot();
        this.#send(this.#sink);
      }
    }, 250);
  }

  subscribe(receiver: Receiver): () => void {
    this.#assertOpen();
    this.#sink?.receiver.dispose();
    const sink: Sink = { receiver, busy: false, pending: this.snapshot() };
    this.#sink = sink;
    this.#send(sink);
    return () => {
      if (this.#sink === sink) this.#sink = undefined;
      sink.pending = undefined;
      receiver.dispose();
    };
  }

  waitForChanges(after: number): Promise<SidebarBatch> {
    this.#assertOpen();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#batch.version)
      return Promise.reject(new Error("Invalid UI version."));
    if (after < this.#batch.version) return Promise.resolve(this.snapshot());
    if (this.#wait) return Promise.reject(new Error("Only one pending poll per UI session."));
    return new Promise((resolve, reject) => {
      this.#wait = { resolve, reject };
      this.#waitTimer = setTimeout(() => {
        this.#clearWait();
        resolve(this.snapshot());
      }, 25_000);
    });
  }

  #send(sink: Sink): void {
    if (sink.busy || !sink.pending || this.#sink !== sink) return;
    const batch = sink.pending;
    sink.pending = undefined;
    sink.busy = true;
    void Promise.resolve().then(() => sink.receiver.receive(batch)).catch(() => {
      if (this.#sink === sink) this.#sink = undefined;
      sink.pending = undefined;
      sink.receiver.dispose();
    }).finally(() => {
      sink.busy = false;
      this.#send(sink);
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Sidebar session closed.");
  }

  #clearWait(): void {
    clearTimeout(this.#waitTimer);
    this.#waitTimer = undefined;
    this.#wait = undefined;
  }

  dispose(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#pending = undefined;
    this.#sink?.receiver.dispose();
    this.#sink = undefined;
    this.#wait?.reject(new Error("Sidebar session closed."));
    this.#clearWait();
  }
}
