import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createSidebarFrame, type SidebarUiImpl, type SidebarSource } from "../src/worker/sidebar.ts";
import type { ProjectState } from "../../forkhorse-dashboard/src/contracts.ts";
import { ConnectionDraftUiImpl } from "../src/worker/configurator.ts";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";

export class FixtureConnectCallback extends WorkerEntrypoint implements GatekeeperConnectCallback {
  async complete(): Promise<never> { throw new Error("Fixture callback must not be invoked."); }
  async reconnectComplete(): Promise<never> { throw new Error("Fixture callback must not be invoked."); }
  async credentialsExpired(): Promise<never> { throw new Error("Fixture callback must not be invoked."); }
  async credentialsRestored(): Promise<never> { throw new Error("Fixture callback must not be invoked."); }
}

// Isolated, labeled fixture producer. No HTTP, account credentials or external service bindings.
export class FixtureSession extends RpcTarget implements SidebarSource {
  #authorized = true;
  #changed?: (state: ProjectState) => void;
  #revoked?: () => void;
  #stops = 0;
  #state: ProjectState = {
    project: { id: "fixture", repoName: "fixture", defaultBranch: "main" },
    agents: [], forks: [], packets: [], claims: [], blockers: [], reviews: [],
    ledger: [], reconcilerAlerts: [],
  };
  constructor(authorized: boolean) { super(); this.#authorized = authorized; }
  async authorize(): Promise<void> {
    if (!this.#authorized) throw new Error("Fixture access revoked.");
  }
  async read(): Promise<ProjectState> { return structuredClone(this.#state); }
  watch(changed: (state: ProjectState) => void, revoked: () => void): () => void {
    this.#changed = changed; this.#revoked = revoked;
    return () => { this.#stops++; this.#changed = undefined; this.#revoked = undefined; };
  }
  async open(): Promise<SidebarUiImpl> {
    const frame = await createSidebarFrame(this, "<!doctype html><p>Fixture sidebar</p>");
    return frame.ui as unknown as SidebarUiImpl;
  }
  async publish(): Promise<void> {
    this.#state.packets.push({ id: `fixture-${this.#state.packets.length}`, title: "Fixture packet", goal: "Fixture", paths: [], acceptance: [] });
    this.#changed?.(structuredClone(this.#state));
  }
  async foreign(): Promise<void> {
    const state = structuredClone(this.#state); state.project.id = "foreign";
    this.#changed?.(state);
  }
  async revoke(notify = true): Promise<void> {
    this.#authorized = false;
    if (notify) this.#revoked?.();
  }
  async stopped(): Promise<number> { return this.#stops; }
}

// Runtime control: deliberately contains no sidebar, feed or validation implementation.
class DiagnosticTarget extends RpcTarget {
  constructor(private readonly disposed: () => void) { super(); }
  async reject(): Promise<void> { throw new Error("Plain target diagnostic refusal."); }
  async ping(): Promise<string> { return "ready"; }
  [Symbol.dispose](): void { this.disposed(); }
}

let diagnosticDisposals = 0;
export class FixtureHarness extends WorkerEntrypoint {
  async diagnosticTarget(): Promise<DiagnosticTarget> {
    return new DiagnosticTarget(() => { diagnosticDisposals++; });
  }
  async diagnosticDisposals(): Promise<number> { return diagnosticDisposals; }
  async diagnosticReject(): Promise<void> { throw new Error("Plain native RPC diagnostic refusal."); }
  async session(authorized = true): Promise<FixtureSession> { return new FixtureSession(authorized); }
  async configurator(): Promise<ConnectionDraftUiImpl> { return new ConnectionDraftUiImpl(); }
  async deniedSetup(): Promise<{ opened: boolean; reads: number }> {
    let reads = 0;
    try {
      const frame = await createSidebarFrame({
        async authorize() { throw new Error("Fixture access denied."); },
        async read() { reads++; return new FixtureSession(true).read(); },
        watch() { throw new Error("Must not start a denied source."); },
      }, "Fixture");
      frame.ui[Symbol.dispose]();
      return { opened: true, reads };
    } catch { return { opened: false, reads }; }
  }
}
export { default, GatekeeperVendor } from "../src/worker/index.ts";
