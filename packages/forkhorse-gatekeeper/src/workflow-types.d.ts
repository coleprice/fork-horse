import type { RpcTarget } from "cloudflare:workers";

import type { ContextResponse, ReadReviewResponse, ReadReceiptsResponse } from "../../forkhorse-stable/src/contracts.ts";
export type WorkflowContext = ContextResponse;

/**
 * Writes queue approval and return before the action is applied.
 * Read context after approval; no applied result is fabricated while pending.
 */
export interface AgentWorkflowSession extends RpcTarget {
  /** Observe state and authenticated work; follow existing work before joining. */
  context(): Promise<WorkflowContext>;
  readReview(review: string): Promise<ReadReviewResponse>;
  readReceipts(review: string): Promise<ReadReceiptsResponse>;
  /** Queue one new fork. After approval, read context and attach it; never retry blindly. */
  join(): Promise<void>;
  /** Queue a claim; omitted repoName means the latest registered fork at apply time. */
  claim(packet: string, repoName?: string): Promise<void>;
  /** Queue owner review of this exact fork commit, after its push is applied. */
  requestReview(packet: string, repoName: string, sha: string): Promise<void>;
  /** Queue release of the connected agent's packet claim. */
  release(packet: string): Promise<void>;
}
