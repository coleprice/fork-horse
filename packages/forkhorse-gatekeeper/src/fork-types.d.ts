import type { RpcTarget } from "cloudflare:workers";

/** One fork owned by the connected agent. */
export interface AgentForkSession extends RpcTarget {
  /** Read the default branch and its full commit ID for createWorktree(). */
  getHead(): Promise<{ repoName: string; branch: string; commitId: string }>;
  /** Move the default branch forward to a descendant commit from this workspace. */
  push(branch: string, commitId: string): Promise<void>;
}
