import type { RpcTarget } from "cloudflare:workers";

/** Temporary opaque core context; replaced by the accepted Stable public types. */
export interface WorkflowContext { [key: string]: unknown; myWork: unknown[] }

/**
 * Workflow surface under local acceptance, not yet published by the production
 * fork binding. Writes queue approval and return before the action is applied.
 */
export interface AgentWorkflowSession extends RpcTarget {
  /** Observe state and authenticated work; follow existing work before joining. */
  context(): Promise<WorkflowContext>;
  /** Queue one new fork. After approval, read context and attach it; never retry blindly. */
  join(): Promise<void>;
  /** Queue a claim; omitted repoName means the latest registered fork at apply time. */
  claim(packet: string, repoName?: string): Promise<void>;
  /** Queue owner review of this exact fork commit, after its push is applied. */
  requestReview(packet: string, repoName: string, sha: string): Promise<void>;
  /** Queue release of the connected agent's packet claim. */
  release(packet: string): Promise<void>;
}
