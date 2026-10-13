/** Persistent public workflow records; none contain Git/API credentials. */
export interface Packet {
  id: string;
  title: string;
  goal: string;
  paths: string[];
  acceptance: string[];
  archived: null | { at: string; by: "owner" };
}
/** Durable owner audit; Git-push Activity records retain their existing schema. */
export interface PacketArchiveAudit {
  packet: string;
  action: "archive" | "unarchive";
  by: "owner";
  recordedAt: string;
}
export interface Fork {
  repoName: string;
  agent: string;
  remote: string;
  createdAt: string;
}
export interface Claim {
  packet: string;
  agent: string;
  repoName: string;
  paths: string[];
  createdAt: string;
}
/** Durable release history. Claim identity and provenance only; no credentials. */
export interface ClaimReleaseAudit {
  packet: string;
  agent: string;
  repoName: string;
  claimedAt: string;
  releasedBy: "agent" | "owner" | "promote";
  review?: string;
  recordedAt: string;
}
export interface ReceiptSummary {
  status: "running" | "passed" | "failed" | "infrastructure-error" | "timed-out";
  trigger: "review-created" | "before-promote";
  digest: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  checks: { name: string; tier: "full" | "quick"; runtime?: "container" | "dynamic-worker"; message?: string; outcome: ReceiptSummary["status"]; durationMs: number | null }[];
}
export interface Review {
  id: string;
  packet: string;
  agent: string;
  repoName: string;
  sha: string;
  base: string;
  receiptDigest: string | null;
  receipt?: ReceiptSummary | null;
  /** Private execution identity; stripped from public snapshots. */
  receiptGeneration?: string;
  approval: { sha: string; receiptDigest: string | null } | null;
  stale: boolean;
  promoted: boolean;
  returned: null | { reason: string; at: string };
  createdAt: string;
}
/** Caller-owned live work only; review execution identities and credentials are omitted. */
export interface WorkItem {
  packet: Pick<Packet, "id" | "title">;
  repoName: string;
  claimedAt: string;
  forkHead: string;
  canonicalHead: string;
  review:
    | null
    | (Pick<Review, "id" | "sha" | "stale" | "returned" | "promoted"> & {
        receipt: ReceiptSummary | null;
        approved: boolean;
      });
  next:
    | "push"
    | "request_review"
    | "wait_for_checks"
    | "fix_checks"
    | "address_return"
    | "wait_for_owner"
    | "done";
  hint: string;
}
export interface LedgerEntry {
  id: string;
  review: string;
  repoName: string;
  ref: string;
  before: string;
  after: string;
  receiptDigest: string | null;
  recordedAt: string;
}
export interface Blocker {
  id: string;
  packet: string;
  claimingAgent: string;
  pushingAgent: string;
  repoName: string;
  sha: string;
  paths: string[];
  at: string | null;
  pushingPacket: string | null;
  resolved: null | { at: string; by: "release" | "promote" | "owner"; reason?: string };
}
export interface ReconcilerAlert {
  id: string;
  repoName: string;
  ref: string;
  before: string;
  after: string;
  reason: string;
}
export interface CommitFile {
  path: string;
  content: string;
}

/** Authenticated dashboard/MCP snapshot. Arrays contain public records only. */
export interface StateSnapshot {
  project: import("./types").Project & { settings: { requireReceipt: boolean } };
  agents: { name: string }[];
  forks: (Fork & { head: string })[];
  packets: Packet[];
  /** Only live claims appear. Release removes the claim, but keeps historical reviews. */
  claims: Claim[];
  blockers: Blocker[];
  reviews: (Review & { receipt: ReceiptSummary | null })[];
  ledger: LedgerEntry[];
  /** Most recent 100 entries in ascending receive sequence. */
  activity: import("./types").Activity[];
  reconcilerAlerts: ReconcilerAlert[];
  /** A durable intent whose external outcome needs inspection; never an applied merge. */
  promotionPending: LedgerEntry | null;
}
