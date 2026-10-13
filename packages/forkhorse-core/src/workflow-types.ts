/** Persistent public workflow records; none contain Git/API credentials. */
export interface Packet {
  id: string;
  /** Absent only in legacy storage; public reads normalize it to standard. */
  mode?: "standard" | "race";
  /** Immutable race-only limit on input plus output tokens. */
  tokenBudget?: number;
  /** Immutable enrolled agent; advisory only and never an entrant in this race. */
  judge?: string;
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
  /** Absent only in legacy storage; public reads normalize both sources to null. */
  usage?: UsageSources;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  model?: string;
  source: "reported" | "metered";
  at: string;
}
export interface UsageSources {
  reported: Usage | null;
  metered: Usage | null;
}
export type TokenBudgetState = "unchecked" | "within" | "near" | "over";
/** Race history is retained at entrant:<packet>:<agent>, including after release. */
export interface RaceEntrant extends Claim {
  firstPushAt: string | null;
  reviewRequestedAt: string | null;
  receiptPassedAt: string | null;
  approvedAt: string | null;
  promotedAt: string | null;
  place: number | null;
  closedAt: string | null;
  closedBy: "release" | "owner" | "race-finished" | null;
  /** Absent on older entrants; the first canonical-base refusal is retained. */
  promoteRejected?: { at: string; expected: string; found: string } | null;
}
/** Immutable finish at race:<packet>; places name agents, never fork aliases. */
export interface RaceResult {
  winner: string;
  places: { agent: string; place: number }[];
  finishedAt: string;
  ledgerEntryId: string;
}
export interface RaceVerdict {
  ranking: string[];
  rationale: string;
  at: string;
}
/** Advice may exist before the immutable finish is written at race:<packet>. */
export type RaceRecord = (RaceResult | {
  finishedAt?: never; winner?: never; places?: never; ledgerEntryId?: never;
}) & { verdict?: RaceVerdict };
export interface RaceState {
  packet: string;
  judge: string | null;
  verdict: RaceVerdict | null;
  tokenBudget: number | null;
  status: "open" | "finished";
  finishedAt: string | null;
  winner: string | null;
  ledgerEntryId: string | null;
  places: RaceResult["places"];
  entrants: (Omit<RaceEntrant, "packet" | "paths" | "createdAt"> & {
    claimedAt: string; usage: UsageSources; budget: TokenBudgetState;
  })[];
}
/** Durable release history. Claim identity and provenance only; no credentials. */
export interface ClaimReleaseAudit {
  packet: string;
  agent: string;
  repoName: string;
  claimedAt: string;
  releasedBy: "agent" | "owner" | "promote" | "race-finished";
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
  /** Immutable cumulative snapshot; absent only in legacy storage. */
  usageAtReview?: UsageSources;
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
  /** Gate used by this promotion; absent on legacy entries whose policy is unknown. */
  requireReceipt?: boolean;
  recordedAt: string;
  /** Packet ID linking this promotion to race:<packet>; absent on standard entries. */
  race?: string;
}
export interface SettingsChange {
  setting: "requireReceipt";
  before: boolean;
  after: boolean;
  by: "owner";
  via: "access" | "owner-api";
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
  resolved: null | { at: string; by: "release" | "promote" | "owner" | "race-finished"; reason?: string };
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
  agents: { name: string; createdAt: string | null }[];
  forks: (Fork & { head: string })[];
  packets: Packet[];
  /** Only live claims appear. Release removes the claim, but keeps historical reviews. */
  claims: (Claim & { usage: UsageSources })[];
  races: RaceState[];
  blockers: Blocker[];
  reviews: (Review & { receipt: ReceiptSummary | null; usageAtReview: UsageSources })[];
  ledger: LedgerEntry[];
  /** Actual owner changes only; legacy policy is never backfilled. */
  settingsChanges: SettingsChange[];
  /** Most recent 100 entries in ascending receive sequence. */
  activity: import("./types").Activity[];
  reconcilerAlerts: ReconcilerAlert[];
  /** A durable intent whose external outcome needs inspection; never an applied merge. */
  promotionPending: LedgerEntry | null;
}
