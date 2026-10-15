import type { ContextResponse, WorkItem, ReadReviewResponse } from "../../../forkhorse-stable/src/index.ts";
import type { WorkflowSource, WorkflowSubmission } from "./workflow.ts";

/**
 * Server-side transport seam, relative to one authenticated project. The adapter
 * obtains bearer credentials through the accepted Stable provider in CoreClient.
 */
export interface WorkflowTransport {
  project: string;
  identity(): Promise<{ agent: string; work: WorkItem[]; forks: { repoName: string; createdAt: string }[] }>;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

export function workflowSource(transport: WorkflowTransport): WorkflowSource {
  return {
    async authorize() { return transport.identity(); },
    async context() {
      const identity = await transport.identity();
      const result = await transport.request("/state") as ContextResponse;
      // Match MCP context: /state plus the authenticated /me work summary.
      // The dashboard's normalized view loses the core resume instructions.
      if (!result || !result.project || !Array.isArray(identity.work)) {
        throw new Error("Invalid project context.");
      }
      return { ...result, myWork: identity.work };
    },
    async submission(operation) {
      const identity = await transport.identity();
      let packets: WorkflowSubmission["packets"] = [];
      if (operation.kind === "claim") {
        // Core has GET /packets, but no single-packet GET. Never load /state
        // just to choose the approval kind; apply/recovery still read full evidence.
        const result = await transport.request("/packets") as Pick<WorkflowSubmission, "packets">;
        if (!result || !Array.isArray(result.packets)) throw new Error("Invalid packet response.");
        const packet = result.packets.find(candidate => candidate.id === operation.packet);
        if (packet) {
          if (packet.mode !== undefined && packet.mode !== "standard" && packet.mode !== "race") {
            throw new Error("Invalid packet response.");
          }
          packets = [{ id: packet.id, mode: packet.mode }];
        }
      }
      return {
        project: { id: transport.project }, packets,
        forks: operation.kind === "claim" && !operation.repoName
          ? identity.forks.map(fork => ({ repoName: fork.repoName, createdAt: fork.createdAt, agent: identity.agent }))
          : [],
      };
    },
    async readReview(review) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(review)) throw new Error("Invalid review ID.");
      return transport.request(`/reviews/${encodeURIComponent(review)}`) as Promise<ReadReviewResponse>;
    },
    async readReceipts(review) {
      const result = await this.readReview(review);
      return { receipt: result.review.receipt ?? null };
    },
    async execute(operation) {
      const identity = await transport.identity();
      let path: string;
      let method = "POST";
      let body: Record<string, unknown> | undefined;
      switch (operation.kind) {
        case "join":
          path = "/join";
          body = { agent: identity.agent, ttlSeconds: 60 };
          break;
        case "claim":
          path = `/packets/${encodeURIComponent(operation.packet)}/claim`;
          body = operation.repoName === undefined ? {} : { repoName: operation.repoName };
          break;
        case "requestReview":
          path = "/reviews";
          body = { packet: operation.packet, repoName: operation.repoName, sha: operation.sha };
          break;
        case "release":
          path = `/packets/${encodeURIComponent(operation.packet)}/claim`;
          method = "DELETE";
          break;
      }
      // In particular, join's token-bearing response never leaves this function,
      // is never persisted, and is never included in queue metadata or errors.
      try {
        await transport.request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        throw new Error("Workflow request failed. Inspect context before retrying.");
      }
    },
  };
}
