/** Native Sandbox 1.0 platform API; mocked ports use the same signatures. */
export type ContainerPort = Pick<Container,
  "running" | "images" | "start" | "exec" | "destroy" | "setInactivityTimeout" | "interceptOutboundHttps"
>;
export type ForkRepository = Pick<ArtifactsRepo,
  "createToken" | "revokeToken" | "readCommit" | "readTree" | "readBlob" | typeof Symbol.dispose
>;
export interface FullCheck {
  name: string;
  tier: "full";
  /** Key in the owner's configured container.images map. */
  image: string;
  run: string;
}
export interface QuickCheck {
  name: string;
  tier: "quick";
  module: string;
}
/** Metadata only; binary is the NUL heuristic over the first 8 KiB. */
export interface QuickFileStat {
  size: number;
  binary: boolean;
}
export type Check = FullCheck | QuickCheck;
export interface RunRequest {
  reviewId: string;
  trigger: "review-created" | "before-promote";
}
/** Returned by the trusted FH-005 authority, never accepted from an HTTP body. */
export interface AuthorizedReview extends RunRequest {
  projectId: string;
  forkRepoName: string;
  forkRemote: string;
  commit: string;
  /** A reserved execution generation; concurrent/older attempts cannot replace this one. */
  generation: string;
}
export interface CheckReceipt {
  commit: string;
  check: Check;
  imageDigest: string;
  exitStatus: number | null;
  outcome: "passed" | "failed" | "infrastructure-error" | "timed-out";
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  /** Absent only in receipts written before quick-tier support. */
  runtime?: "dynamic-worker" | "container";
  message?: string;
  logs: { stdout: string; stderr: string; truncated: boolean };
  /** SHA-256 of JSON.stringify(logs), with the field order above. */
  logDigest: string;
}
export interface Receipt {
  schema: 1;
  evidence: "mocked-container-port" | "container" | "dynamic-worker" | "mixed" | "mocked-worker-loader";
  projectId: string;
  reviewId: string;
  forkRepoName: string;
  commit: string;
  generation: string;
  trigger: RunRequest["trigger"];
  checks: CheckReceipt[];
}
export interface StoredReceipt {
  digest: string;
  receipt: Receipt;
}
/** Core supplies a per-execution RPC capability implementing this trusted contract. */
export interface ReviewAuthority {
  /** Authenticate caller, authorize fork ownership/commit, reserve generation, clear stale digest. */
  authorize(request: RunRequest): Promise<AuthorizedReview>;
  /** Durably store the whole immutable receipt in Supervisor under its digest. */
  storeReceipt(record: StoredReceipt): Promise<void>;
  /** Atomically compare review commit + generation, then attach digest; false means stale. */
  setReviewReceiptDigest(review: AuthorizedReview, digest: string): Promise<boolean>;
}
export interface RunnerPorts {
  authority: ReviewAuthority;
  getFork(name: string): Promise<ForkRepository>;
  container?: ContainerPort;
  quick?: import("./quick").QuickPorts;
  gitGateway(remote: string): Fetcher;
  /** Set by the adapter, never by a RunRequest. */
  evidence: Receipt["evidence"];
}
