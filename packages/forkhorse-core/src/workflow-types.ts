/** Persistent public workflow records; none contain Git/API credentials. */
export interface Packet {
  id: string;
  title: string;
  goal: string;
  paths: string[];
  acceptance: string[];
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
export interface Review {
  id: string;
  packet: string;
  agent: string;
  repoName: string;
  sha: string;
  base: string;
  receiptDigest: string | null;
  approval: { sha: string; receiptDigest: string | null } | null;
  stale: boolean;
  promoted: boolean;
  createdAt: string;
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
  project: import("./types").Project;
  agents: { name: string }[];
  forks: (Fork & { head: string })[];
  packets: Packet[];
  /** Only live claims appear. Release removes the claim, but keeps historical reviews. */
  claims: Claim[];
  blockers: Blocker[];
  reviews: Review[];
  ledger: LedgerEntry[];
  /** Most recent 100 entries in ascending receive sequence. */
  activity: import("./types").Activity[];
  reconcilerAlerts: ReconcilerAlert[];
  /** A durable intent whose external outcome needs inspection; never an applied merge. */
  promotionPending: LedgerEntry | null;
}
