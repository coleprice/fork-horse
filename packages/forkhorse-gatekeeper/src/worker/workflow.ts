import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
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
  execute(operation: WorkflowWrite): Promise<void>;
}
interface Action {
  operation: WorkflowWrite;
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
 * Approval-only workflow controller. Not wired into the production account until
 * FH-065a's accepted credential provider is available. The fixture runs in workerd.
 */
export class WorkflowActions {
  constructor(
    private readonly store: Store,
    private readonly source: WorkflowSource,
    // Share with push when integrating, including its existing nextAction counter.
    private readonly serial = new SerialTaskQueue(),
  ) {}

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
      const entries = [...this.store.list<Action>({ prefix: "workflow:" })];
      const unresolved = entries.find(([, action]) => ["preparing", "pending", "applying"].includes(action.status));
      let id: number;
      if (unresolved) {
        const [key, action] = unresolved;
        if (action.status === "applying") throw new Error("Workflow outcome uncertain. Inspect context before starting more work; do not repeat join.");
        if (JSON.stringify(action.operation) !== JSON.stringify(operation)) throw new Error("Resolve the pending workflow action before submitting another.");
        if (action.status === "pending") return;
        id = Number(key.slice("workflow:".length));
      } else {
        id = (this.store.get<number>("nextAction") ?? 0) + 1;
        this.store.put("nextAction", id);
      }
      this.store.put(`workflow:${id}`, { operation, status: "preparing" } satisfies Action);
      try {
        await queue.submitAction(id, { ...description(operation), implementsRevert: false, awaitDecision: true });
      } catch {
        // The host may already have persisted this ID. Retry only its submission.
        throw new Error("Workflow submission interrupted. Retry the same call to recover its approval request.");
      }
      this.store.put(`workflow:${id}`, { operation, status: "pending" } satisfies Action);
    });
  }

  async apply(id: number): Promise<void> {
    await this.serial.run(async () => {
      const action = this.store.get<Action>(`workflow:${id}`);
      if (action?.status === "applied") return;
      if (action?.status === "applying") throw new Error("Workflow outcome uncertain. Inspect context; this action will not be sent again.");
      if (action?.status !== "preparing" && action?.status !== "pending") throw new Error("Workflow action is not pending approval.");
      await this.source.authorize();
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
