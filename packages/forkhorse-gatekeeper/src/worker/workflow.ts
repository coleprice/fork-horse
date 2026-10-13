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
  authorize(): Promise<void>;
  context(): Promise<WorkflowContext>;
  readReview(review: string): Promise<ReadReviewResponse>;
  readReceipts(review: string): Promise<ReadReceiptsResponse>;
  execute(operation: WorkflowWrite): Promise<void>;
}
interface Action {
  operation: WorkflowWrite;
  actionKind: ActionKind;
  status: "preparing" | "pending" | "applying" | "applied" | "rejected";
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
function description(operation: WorkflowWrite) {
  switch (operation.kind) {
    case "join": return { title: "Create an agent fork", description: "Create one new fork for the connected agent. After approval, read context and attach the new fork before editing. Do not repeat join to resume work." };
    case "claim": return { title: `Claim ${operation.packet}`, description: `Claim packet ${operation.packet}${operation.repoName ? ` on fork ${operation.repoName}` : " on the connected agent's latest registered fork"}.` };
    case "requestReview": return { title: `Request review of ${operation.packet}`, description: `Request review of exact commit ${operation.sha} on fork ${operation.repoName} for packet ${operation.packet}.` };
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
    private readonly beforeSubmit: () => void = () => {},
  ) {}

  has(id: number): boolean { return !!this.store.get<Action>(`workflow:${id}`); }
  hasPending(): boolean {
    return [...this.store.list<Action>({ prefix: "workflow:" })]
      .some(([, action]) => ["preparing", "pending", "applying"].includes(action.status));
  }
  async #kind(operation: WorkflowWrite): Promise<ActionKind> {
    if (operation.kind !== "claim") return actionKinds[operation.kind];
    const packet = (await this.source.context()).packets.find(candidate => candidate.id === operation.packet);
    if (!packet) throw new Error("Packet is unavailable.");
    return packet.mode === "race" ? actionKinds.raceEntry : actionKinds.claim;
  }
  async readReview(queue: Pick<ApprovalQueue, "authorizeObservation">, review: string): Promise<ReadReviewResponse> {
    await queue.authorizeObservation({ title: "Read review", description: "Read the connected agent's review at its recorded commit." });
    await this.source.authorize();
    const result = await this.source.readReview(review);
    await this.source.authorize();
    return result;
  }
  async readReceipts(queue: Pick<ApprovalQueue, "authorizeObservation">, review: string): Promise<ReadReceiptsResponse> {
    await queue.authorizeObservation({ title: "Read receipt summary", description: "Read the public check summary on the connected agent's review." });
    await this.source.authorize();
    const result = await this.source.readReceipts(review);
    await this.source.authorize();
    return result;
  }

  async context(queue: Pick<ApprovalQueue, "authorizeObservation">): Promise<WorkflowContext> {
    await queue.authorizeObservation({ title: "Read project context", description: "Read project state and the connected agent's work to choose the next step." });
    await this.source.authorize();
    const result = await this.source.context();
    await this.source.authorize();
    return result;
  }

  async submit(queue: Pick<ApprovalQueue, "submitAction">, operation: WorkflowWrite): Promise<void> {
    validate(operation);
    await this.serial.run(async () => {
      await this.source.authorize();
      this.beforeSubmit();
      const entries = [...this.store.list<Action>({ prefix: "workflow:" })];
      const unresolved = entries.find(([, action]) => ["preparing", "pending", "applying"].includes(action.status));
      let id: number;
      let actionKind: ActionKind;
      if (unresolved) {
        const [key, action] = unresolved;
        if (action.status === "applying") throw new Error("Workflow outcome uncertain. Inspect context before starting more work; do not repeat join.");
        if (JSON.stringify(action.operation) !== JSON.stringify(operation)) throw new Error("Resolve the pending workflow action before submitting another.");
        if (action.status === "pending") return;
        id = Number(key.slice("workflow:".length));
        actionKind = action.actionKind;
      } else {
        actionKind = await this.#kind(operation);
        id = (this.store.get<number>("nextAction") ?? 0) + 1;
        this.store.put("nextAction", id);
      }
      this.store.put(`workflow:${id}`, { operation, actionKind, status: "preparing" } satisfies Action);
      try {
        await queue.submitAction(id, { ...description(operation), ...(actionKind.tag === actionKinds.raceEntry.tag ? { title: `Enter race ${"packet" in operation ? operation.packet : ""}` } : {}), implementsRevert: false, awaitDecision: true, actionKind, autoApprovable: true });
      } catch {
        // The host may already have persisted this ID. Retry only its submission.
        throw new Error("Workflow submission interrupted. Retry the same call to recover its approval request.");
      }
      this.store.put(`workflow:${id}`, { operation, actionKind, status: "pending" } satisfies Action);
    });
  }

  async apply(id: number): Promise<void> {
    await this.serial.run(async () => {
      const action = this.store.get<Action>(`workflow:${id}`);
      if (action?.status === "applied") return;
      if (action?.status === "applying") throw new Error("Workflow outcome uncertain. Inspect context; this action will not be sent again.");
      if (action?.status !== "preparing" && action?.status !== "pending") throw new Error("Workflow action is not pending approval.");
      await this.source.authorize();
      if ((await this.#kind(action.operation)).tag !== action.actionKind.tag) throw new Error("Packet action kind changed; discard this action.");
      // Core join/review are not idempotent. Persist the boundary before sending;
      // never repeat an ambiguous call after a crash or lost response.
      this.store.put(`workflow:${id}`, { ...action, status: "applying" });
      try {
        await this.source.execute(action.operation);
      } catch {
        throw new Error("Workflow outcome uncertain. Inspect context; do not repeat join or request review.");
      }
      this.store.put(`workflow:${id}`, { ...action, status: "applied" });
    });
  }

  async reject(id: number): Promise<void> {
    await this.serial.run(async () => {
      const action = this.store.get<Action>(`workflow:${id}`);
      if (!action || action.status === "rejected") return;
      if (action.status === "applied" || action.status === "applying") throw new Error("Workflow action was already sent; inspect context.");
      this.store.put(`workflow:${id}`, { ...action, status: "rejected" });
    });
  }
}
