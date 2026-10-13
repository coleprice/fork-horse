import { RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentWorkflowSession, WorkflowContext } from "../workflow-types.d.ts";
import { WorkflowActions } from "./workflow.ts";

/** Native RPC seam, exercised with fixture transport until the Stable provider lands. */
@validateRpc()
export class WorkflowSession extends RpcTarget implements AgentWorkflowSession {
  constructor(private readonly actions: WorkflowActions, private readonly queue: RpcStub<ApprovalQueue>) { super(); }
  async context(): Promise<WorkflowContext> { return this.actions.context(this.queue); }
  async join(): Promise<void> { await this.actions.submit(this.queue, { kind: "join" }); }
  async claim(packet: string, repoName?: string): Promise<void> {
    await this.actions.submit(this.queue, { kind: "claim", packet, ...(repoName === undefined ? {} : { repoName }) });
  }
  async requestReview(packet: string, repoName: string, sha: string): Promise<void> {
    await this.actions.submit(this.queue, { kind: "requestReview", packet, repoName, sha });
  }
  async release(packet: string): Promise<void> { await this.actions.submit(this.queue, { kind: "release", packet }); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}
