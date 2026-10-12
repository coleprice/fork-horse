import type { Supervisor } from "./supervisor";

/** Narrow views of the generated platform types; fixtures implement this same API. */
export type Repository = Pick<
  ArtifactsRepo,
  "log" | "fork" | "createToken" | "listTokens" | "revokeToken" | "readCommit" | "readTree" | typeof Symbol.dispose
>;
export type ArtifactsBinding = Pick<Artifacts, "create" | "import"> & {
  get(name: string): Promise<Repository>;
};

export interface Env {
  ARTIFACTS: ArtifactsBinding;
  ARTIFACTS_NAMESPACE: string;
  OWNER_API_TOKEN_HASH: string;
  CF_ACCOUNT_ID?: string;
  CF_EVENTS_API_TOKEN?: string;
  PUSH_QUEUE_ID?: string;
  // Optional only for API-only offline fixtures. Public integration fails closed if incomplete.
  CORE_PUBLIC_ORIGIN?: string;
  MCP_PATH?: string;
  MCP_PROJECT?: string;
  CORE_ACCESS_ISSUER?: string;
  CORE_ACCESS_AUDIENCE?: string;
  CORE_ACCESS_OWNERS?: string[];
  OAUTH_KV?: KVNamespace;
  ASSETS?: Fetcher;
  SUPERVISOR: DurableObjectNamespace<Supervisor>;
}

export interface Project {
  id: string;
  namespace: string;
  repoName: string;
  remote: string;
  defaultBranch: string;
}

export interface PushEvent {
  type: "cf.artifacts.repo.pushed";
  source: { namespace: string; repoName: string };
  payload: { ref: string; before: string; after: string };
  metadata: { eventTimestamp: string };
}

export interface Activity {
  sequence: number;
  namespace: string;
  repoName: string;
  agent: string | null;
  ref: string;
  before: string;
  after: string;
  changedPaths: string[];
  eventTimestamp: string;
  recordedAt: string;
}
