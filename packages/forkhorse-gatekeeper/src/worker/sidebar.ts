import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AccountDescription, GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type { ProjectState } from "../../../forkhorse-dashboard/src/contracts.ts";
import type { SidebarBatch } from "../ui-types.ts";
import { SnapshotFeed } from "../feed.ts";
import brand from "../../../../brand.json";
import { markIconUrl } from "../../../forkhorse-dashboard/src/mark.ts";

const icon = { url: markIconUrl(brand.mark) };

/** Only an authenticated account may use this metadata; it grants no owner authority. */
export function sidebarAccountDescription(): AccountDescription {
  return { displayName: brand.name, avatar: icon, providesUi: { title: brand.name, icon } };
}

/** Trusted host seam supplied by the authenticated, project-bound account. */
export interface SidebarSource {
  authorize(): Promise<void>;
  read(): Promise<ProjectState>;
  /** Replay current state on registration; invoke revoked on auth loss or source failure. */
  watch(changed: (state: ProjectState) => void, revoked: () => void): () => void;
}

export interface WorkerUpdateReceiver extends RpcTarget {
  receive(batch: SidebarBatch): Promise<void>;
}

@validateRpc()
export class SidebarSubscription extends RpcTarget {
  readonly #release: () => void;
  #closed = false;
  constructor(release: () => void) { super(); this.#release = release; }
  async close(): Promise<void> {
    if (!this.#closed) { this.#closed = true; this.#release(); }
  }
  [Symbol.dispose](): void { void this.close(); }
}

/** Worker-native, read-only UI surface; publishing and credentials are never RPC methods. */
@validateRpc()
export class SidebarUiImpl extends RpcTarget {
  readonly #feed: SnapshotFeed;
  readonly #authorize: () => Promise<void>;
  readonly #close: () => void;
  constructor(feed: SnapshotFeed, authorize: () => Promise<void>, close: () => void) {
    super(); this.#feed = feed; this.#authorize = authorize; this.#close = close;
  }

  async snapshot(): Promise<SidebarBatch> {
    await this.#authorize();
    return this.#feed.snapshot();
  }

  async subscribe(receiver: RpcStub<WorkerUpdateReceiver>): Promise<SidebarSubscription> {
    await this.#authorize();
    const retained = receiver.dup();
    let disposed = false;
    const dispose = () => {
      if (!disposed) { disposed = true; retained[Symbol.dispose](); }
    };
    try {
      return new SidebarSubscription(this.#feed.subscribe({
        receive: async (batch) => {
          await this.#authorize();
          await retained.receive(batch);
        },
        dispose,
      }));
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async waitForChanges(after: number): Promise<SidebarBatch> {
    await this.#authorize();
    const batch = await this.#feed.waitForChanges(after);
    // A poll can span revocation; authorize again immediately before disclosure.
    await this.#authorize();
    return batch;
  }

  [Symbol.dispose](): void { this.#close(); }
}

/** Compose startAppUi only after account authorization. */
export async function createSidebarFrame(source: SidebarSource, iframeHtml: string): Promise<GatekeeperUiFrame> {
  let initial: ProjectState;
  try {
    await source.authorize();
    initial = await source.read();
    await source.authorize();
  } catch { throw new Error("Sidebar session unavailable."); }
  const feed = new SnapshotFeed(initial);
  let stop: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { stop?.(); } finally { feed.dispose(); }
  };
  const authorize = async () => {
    if (closed) throw new Error("Sidebar session unavailable.");
    try { await source.authorize(); } catch { close(); throw new Error("Sidebar session unavailable."); }
    if (closed) throw new Error("Sidebar session unavailable.");
  };
  try {
    stop = source.watch((state) => {
      if (closed) return;
      try { feed.publish(state); } catch { close(); }
    }, close);
    // Handle a source that synchronously revokes while registering the watch.
    if (closed) { stop(); throw new Error("Sidebar session unavailable."); }
    return { iframeHtml, ui: new RpcStub(new SidebarUiImpl(feed, authorize, close)) };
  } catch (error) { close(); throw error; }
}
