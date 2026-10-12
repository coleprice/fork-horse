import { RpcTarget, type RpcStub } from "capnweb";
import { SnapshotFeed } from "../src/feed.ts";
import type { UpdateReceiver } from "../src/ui-types.ts";

/** Fixture-only RPC endpoint; no account connection, core calls, credentials or Git transport. */
export class FixtureUi extends RpcTarget {
  readonly #feed: SnapshotFeed;
  readonly #push: boolean;
  calls = { snapshot: 0, subscribe: 0, poll: 0 };
  constructor(feed: SnapshotFeed, push = true) { super(); this.#feed = feed; this.#push = push; }
  async snapshot() { this.calls.snapshot++; return this.#feed.snapshot(); }
  async subscribe(receiver: RpcStub<UpdateReceiver>) {
    this.calls.subscribe++;
    if (!this.#push) throw new Error("Fixture: push unavailable.");
    const retained = receiver.dup();
    let disposed = false;
    const close = this.#feed.subscribe({
      receive: (batch) => retained.receive(batch),
      dispose() {
        if (!disposed) { disposed = true; retained[Symbol.dispose](); }
      },
    });
    return new class extends RpcTarget {
      async close() { close(); }
      [Symbol.dispose]() { close(); }
    }();
  }
  async waitForChanges(after: number) { this.calls.poll++; return this.#feed.waitForChanges(after); }
}
