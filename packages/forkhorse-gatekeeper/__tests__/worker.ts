import { WorkflowActions } from "../src/worker/workflow.ts";
import { workflowSource } from "../src/worker/workflow-source.ts";
import { WorkflowSession } from "../src/worker/workflow-session.ts";
import { DurableObject, RpcTarget, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { createSidebarFrame, type SidebarUiImpl, type SidebarSource } from "../src/worker/sidebar.ts";
import type { AgentForkSession } from "../src/fork-types.d.ts";
import type { AgentAccount } from "../src/worker/account.ts";
import type { ForkGatekeeper } from "../src/worker/fork.ts";
import type { ProjectState } from "../../forkhorse-dashboard/src/contracts.ts";
import { ConnectionDraftUiImpl } from "../src/worker/configurator.ts";
import type { ApprovalQueue, GitCache, GitPullHints, GatekeeperUser, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";

let reconnectStage: string | undefined;
export class FixtureConnectCallback extends WorkerEntrypoint implements GatekeeperConnectCallback {
  async complete(user: Fetcher<GatekeeperUser>) {
    await this.env.WORKSPACES.getByName("callback-vault").saveAccount(user);
    return { targetOrigin: "https://os.fixture.idiot.tax", ticket: "fixture-handoff-ticket" };
  }
  async reconnectComplete(stageId: string) {
    reconnectStage = stageId;
    return { targetOrigin: "https://os.fixture.idiot.tax", ticket: "fixture-reconnect-ticket" };
  }
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(): Promise<void> {}
}
export class FixtureWorkspace extends DurableObject {
  #workflow() {
    return new WorkflowActions(this.ctx.storage.kv, workflowSource({
      project: "fixture",
      identity: async () => ({ agent: "fixture-agent", work: [], forks: [] }),
      request: async (path, init) => {
        if (!init) return { project: { id: "fixture" }, packets: [{ id: "fixture-packet", mode: "standard" }], forks: [], claims: [], races: [], reviews: [] };
        const calls = this.ctx.storage.kv.get<unknown[]>("fixtureCalls") ?? [];
        calls.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
        this.ctx.storage.kv.put("fixtureCalls", calls);
        return { token: "fixture-token-must-not-escape" };
      },
    }));
  }
  async workflowSession(queue: RpcStub<ApprovalQueue>): Promise<WorkflowSession> {
    return new WorkflowSession(this.#workflow(), queue.dup());
  }
  async applyWorkflow(id: number): Promise<void> { await this.#workflow().apply(id); }
  async rejectWorkflow(id: number): Promise<void> { await this.#workflow().reject(id); }
  async workflowCalls(): Promise<unknown[]> { return this.ctx.storage.kv.get<unknown[]>("fixtureCalls") ?? []; }
  #fork() {
    return this.ctx.facets.get<ForkGatekeeper>("fork", () => ({
      class: this.ctx.storage.kv.get<DurableObjectClass<ForkGatekeeper>>("forkClass")!,
    }));
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<AgentForkSession> {
    return await this.#fork().startSession(queue as unknown as ApprovalQueue) as unknown as AgentForkSession;
  }
  async describeFork() { return this.#fork().describe(); }
  async forkTypes() { return this.#fork().getTypeScriptTypes(); }
  async autoApprovable() { return this.#fork().getAutoApprovableActions(); }
  async applyAction(id: number, cache: RpcStub<GitCache>): Promise<void> { await this.#fork().applyAction(id, cache); }
  async gitPull(oids: string[], cache: RpcStub<GitCache>, hints: GitPullHints): Promise<void> { await this.#fork().gitPull(oids, cache, hints); }
  async rejectAction(id: number): Promise<void> { await this.#fork().rejectAction(id); }

  async saveAccount(user: Fetcher<GatekeeperUser>): Promise<void> { this.ctx.storage.kv.put("account", user); }
  async getAccount(): Promise<AgentAccount> {
    const user = this.ctx.storage.kv.get<Fetcher<GatekeeperUser>>("account");
    if (!user) throw new Error("No fixture account completed.");
    return user as unknown as AgentAccount;
  }
  async bind(user: Fetcher<GatekeeperUser>, url: string) {
    const resolved = await user.getGatekeeperClassFor(url);
    this.ctx.storage.kv.put("forkClass", resolved.class);
  }
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
  async begin(): Promise<{ url: string }> {
    const exports = this.ctx.exports as unknown as {
      FixtureConnectCallback(options: {}): Fetcher<GatekeeperConnectCallback>;
    };
    return this.ctx.exports.GatekeeperVendor({}).connectAccount(exports.FixtureConnectCallback({}));
  }
  async account(): Promise<AgentAccount> {
    return await this.env.WORKSPACES.getByName("callback-vault").getAccount() as unknown as AgentAccount;
  }
  async reconnectStage(): Promise<string> {
    if (!reconnectStage) throw new Error("No fixture reconnect staged.");
    return reconnectStage;
  }
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
export { default, GatekeeperVendor, UserAccount, AgentAccount, AgentVerifier, ForkGatekeeper } from "../src/worker/index.ts";
