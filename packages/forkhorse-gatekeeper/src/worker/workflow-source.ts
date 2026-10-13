import type { WorkflowSource } from "./workflow.ts";

/**
 * Server-side transport seam, relative to one authenticated project. The adapter
 * must obtain bearer credentials only through FH-065a's accepted provider.
 * Kept unwired until that contract is accepted; tests use a labeled local fixture.
 */
export interface WorkflowTransport {
  identity(): Promise<{ agent: string; work: unknown[] }>;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

export function workflowSource(transport: WorkflowTransport): WorkflowSource {
  return {
    async authorize() { await transport.identity(); },
    async context() {
      const identity = await transport.identity();
      const result = await transport.request("/state") as Record<string, unknown>;
      // Match MCP context: /state plus the authenticated /me work summary.
      // The dashboard's normalized view loses the core resume instructions.
      if (!result || !result.project || !Array.isArray(identity.work)) {
        throw new Error("Invalid project context.");
      }
      return { ...result, myWork: identity.work };
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
