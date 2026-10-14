import { evidence, outcome, uncertain, type Evidence } from "./workflow-evidence.ts";
import { actionKinds } from "./action-kinds.ts";
import type { ReadReviewResponse, ReadReceiptsResponse } from "../../../forkhorse-stable/src/index.ts";
import type { ApprovalQueue, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";

import type { WorkflowContext } from "../workflow-types.d.ts";
export type { WorkflowContext } from "../workflow-types.d.ts";

export type WorkflowWrite =
  | { kind: "join" }
  | { kind: "claim"; packet: string; repoName?: string }
  | { kind: "requestReview"; packet: string; repoName: string; sha: string }
  | { kind: "release"; packet: string };

/** Credential-free seam. Production implementation must use the accepted Stable provider. */
export interface WorkflowSource {
  authorize(): Promise<{ agent: string }>;
  context(): Promise<WorkflowContext>;
  readReview(review: string): Promise<ReadReviewResponse>;
  readReceipts(review: string): Promise<ReadReceiptsResponse>;
  execute(operation: WorkflowWrite): Promise<void>;
}
interface Action {
  operation: WorkflowWrite;
  actionKind: ActionKind;
  status: "preparing" | "pending" | "applying" | "retryable" | "applied" | "rejected";
  before?: Evidence;
  attempts?: number;
  copy?: { title: string; description: string };
}
type Store = Pick<DurableObjectStorage["kv"], "get" | "put" | "list">;
const component = (value: string) => value !== "." && value !== ".." && /^[a-zA-Z0-9._-]{1,255}$/.test(value);

function validate(operation: WorkflowWrite): void {
  if ("packet" in operation && !component(operation.packet)) throw new Error("Invalid packet ID.");
  if ("repoName" in operation && operation.repoName !== undefined && !component(operation.repoName)) {
    throw new Error("Invalid fork name.");
  }
  if (operation.kind === "requestReview" && (!/^[a-f0-9]{40}$/.test(operation.sha) || /^0+$/.test(operation.sha))) {
    throw new Error("A full, nonzero commit ID is required.");
  }
}
function sameWrite(requested: WorkflowWrite, stored: WorkflowWrite): boolean {
  if (requested.kind !== stored.kind) return false;
  if ("packet" in requested && "packet" in stored && requested.packet !== stored.packet) return false;
  if (requested.kind === "claim" && stored.kind === "claim") return requested.repoName === undefined || requested.repoName === stored.repoName;
  if (requested.kind === "requestReview" && stored.kind === "requestReview") return requested.repoName === stored.repoName && requested.sha === stored.sha;
  return true;
}
function description(operation: WorkflowWrite, project: string, agent: string, race: boolean) {
  switch (operation.kind) {
    case "join": return { title: "Create an agent fork", description: `Create one new fork of ${project} for ${agent}.` };
    case "claim": return race ? { title: `Enter race ${operation.packet}`, description: `Enter ${agent} in race ${operation.packet} on fork ${operation.repoName}.` } : { title: `Claim ${operation.packet}`, description: `Claim packet ${operation.packet}${operation.repoName ? ` on fork ${operation.repoName}` : " on the connected agent's latest registered fork"}.` };
    case "requestReview": return { title: `Request review of ${operation.packet}`, description: `Request review of commit ${operation.sha.slice(0, 7)} on fork ${operation.repoName} for ${operation.packet}.` };
    case "release": return { title: `Release ${operation.packet}`, description: `Release the connected agent's claim on packet ${operation.packet}.` };
  }
}

/**
 * Durable approval controller. Applied operations use the connected account
 * and its Stable credential provider, never model-supplied authority.
 */
export class WorkflowActions {
  constructor(
    private readonly store: Store,
    private readonly source: WorkflowSource,
    // Share with push when integrating, including its existing nextAction counter.
    private readonly serial = new SerialTaskQueue(),
    private readonly beforeSubmit: () => void | Promise<void> = () => {},
  ) {}

  has(id: number): boolean { return !!this.store.get<Action>(`workflow:${id}`); }
  hasPending(): boolean {
    return [...this.store.list<Action>({ prefix: "workflow:" })]
      .some(([, action]) => ["preparing", "pending", "applying", "retryable"].includes(action.status));
  }
  #kind(operation: WorkflowWrite, context: WorkflowContext): ActionKind {
    if (operation.kind !== "claim") return actionKinds[operation.kind];
    const packet = context.packets.find(candidate => candidate.id === operation.packet);
    if (!packet) throw new Error("Packet is unavailable.");
    return packet.mode === "race" ? actionKinds.raceEntry : actionKinds.claim;
  }
  async #reconcile(context?: WorkflowContext): Promise<void> {
    for (const [key, action] of this.store.list<Action>({ prefix: "workflow:" })) {
      if (action.status !== "applying" && action.status !== "retryable") continue;
      const identity = await this.source.authorize();
      let snapshot: WorkflowContext;
      try { snapshot = context ?? await this.source.context(); } catch { throw uncertain(action.operation); }
      await this.source.authorize();
      if (!action.before || identity.agent !== action.before.agent) continue;
      const result = outcome(snapshot, action.before, action.operation, action.actionKind.tag === actionKinds.raceEntry.tag);
      if (result === "applied") this.store.put(key, { ...action, status: "applied" });
      else this.store.put(key, { ...action, status: result === "absent" && (action.attempts ?? 1) < 2 ? "retryable" : "applying" });
    }
  }
  // Caller must already hold the shared push/workflow serial queue.
  async reconcileInsideQueue(): Promise<void> { await this.#reconcile(); }
  async readReview(queue: Pick<ApprovalQueue, "authorizeObservation">, review: string): Promise<ReadReviewResponse> {
    await queue.authorizeObservation({ title: "Read review", description: "Read the connected agent's review at its recorded commit." });
    await this.source.authorize();
    await this.serial.run(() => this.#reconcile());
    const result = await this.source.readReview(review);
    await this.source.authorize();
    return result;
  }
  async readReceipts(queue: Pick<ApprovalQueue, "authorizeObservation">, review: string): Promise<ReadReceiptsResponse> {
    await queue.authorizeObservation({ title: "Read receipt summary", description: "Read the public check summary on the connected agent's review." });
    await this.source.authorize();
    await this.serial.run(() => this.#reconcile());
    const result = await this.source.readReceipts(review);
    await this.source.authorize();
    return result;
  }

  async context(queue: Pick<ApprovalQueue, "authorizeObservation">): Promise<WorkflowContext> {
    await queue.authorizeObservation({ title: "Read project context", description: "Read project state and the connected agent's work to choose the next step." });
    return this.serial.run(async () => {
      await this.source.authorize();
      const result = await this.source.context();
      await this.source.authorize();
      await this.#reconcile(result);
      return result;
    });
  }

  async submit(queue: Pick<ApprovalQueue, "submitAction">, operation: WorkflowWrite): Promise<void> {
    validate(operation);
    await this.serial.run(async () => {
      const identity = await this.source.authorize();
      await this.beforeSubmit();
      const prior = [...this.store.list<Action>({ prefix: "workflow:" })].find(([, action]) => action.status === "applying" || action.status === "retryable");
      await this.#reconcile();
      if (prior && this.store.get<Action>(prior[0])?.status === "applied" && sameWrite(operation, prior[1].operation)) return;
      const unresolved = [...this.store.list<Action>({ prefix: "workflow:" })].find(([, action]) => ["preparing", "pending", "applying", "retryable"].includes(action.status));
      let id: number;
      let action: Action;
      if (unresolved) {
        const [key, existing] = unresolved;
        if (existing.status === "applying") throw uncertain(existing.operation);
        // Omitted fork is resolved once, before approval, and stays fixed on retry.
        if (!sameWrite(operation, existing.operation)) throw new Error("Resolve the pending workflow action before submitting another.");
        if (existing.status === "pending") return;
        id = Number(key.slice("workflow:".length));
        action = existing;
      } else {
        const snapshot = await this.source.context();
        await this.source.authorize();
        if (operation.kind === "claim" && !operation.repoName) {
          const forks = snapshot.forks.filter(fork => fork.agent === identity.agent);
          const latest = forks.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (!latest) throw new Error("The connected agent has no fork to claim.");
          operation = { ...operation, repoName: latest.repoName };
        }
        const actionKind = this.#kind(operation, snapshot);
        id = (this.store.get<number>("nextAction") ?? 0) + 1;
        this.store.put("nextAction", id);
        action = { operation, actionKind, status: "preparing", copy: description(operation, snapshot.project.id, identity.agent, actionKind.tag === actionKinds.raceEntry.tag) };
      }
      this.store.put(`workflow:${id}`, { ...action, status: "preparing" });
      try {
        await queue.submitAction(id, { ...action.copy!, implementsRevert: false, awaitDecision: true, actionKind: action.actionKind, autoApprovable: true });
      } catch {
        throw new Error("Workflow submission interrupted. Retry the same call to recover its approval request.");
      }
      this.store.put(`workflow:${id}`, { ...action, status: "pending" });
    });
  }

  async apply(id: number): Promise<void> {
    await this.serial.run(async () => {
      let action = this.store.get<Action>(`workflow:${id}`);
      if (action && action.status !== "applied" && action.status !== "rejected" && (action.attempts ?? 0) > 0) {
        // Recheck even a previously observed absence immediately before retrying.
        this.store.put(`workflow:${id}`, { ...action, status: "applying" });
        await this.#reconcile();
        action = this.store.get<Action>(`workflow:${id}`);
      }
      if (action?.status === "applied") return;
      if (action?.status === "applying") throw uncertain(action.operation);
      if (!action || !["preparing", "pending", "retryable"].includes(action.status)) throw new Error("Workflow action is not pending approval.");
      const identity = await this.source.authorize();
      const snapshot = await this.source.context();
      await this.source.authorize();
      if (this.#kind(action.operation, snapshot).tag !== action.actionKind.tag) throw new Error("Packet action kind changed; discard this action.");
      if (action.before && (action.attempts ?? 0) > 0) {
        const result = outcome(snapshot, action.before, action.operation, action.actionKind.tag === actionKinds.raceEntry.tag);
        if (result === "applied") { this.store.put(`workflow:${id}`, { ...action, status: "applied" }); return; }
        if (result !== "absent" || (action.attempts ?? 0) >= 2) throw uncertain(action.operation);
      }
      const before = evidence(snapshot, identity.agent, action.operation);
      const sent: Action = { ...action, before, attempts: (action.attempts ?? 0) + 1, status: "applying" };
      this.store.put(`workflow:${id}`, sent);
      try {
        await this.source.execute(action.operation);
      } catch {
        throw uncertain(action.operation);
      }
      this.store.put(`workflow:${id}`, { ...sent, status: "applied" });
    });
  }

  async reject(id: number): Promise<void> {
    await this.serial.run(async () => {
      await this.#reconcile();
      const action = this.store.get<Action>(`workflow:${id}`);
      if (!action || action.status === "rejected") return;
      if (action.status === "applied" || action.status === "applying") throw new Error("Workflow action was already sent; inspect context.");
      this.store.put(`workflow:${id}`, { ...action, status: "rejected" });
    });
  }
}
