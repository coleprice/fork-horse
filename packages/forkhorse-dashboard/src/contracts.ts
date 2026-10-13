/** View projection of the public FH-005 wire state; never includes credentials. */
export interface ProjectState {
  project: {
    id: string;
    repoName: string;
    defaultBranch: string;
    remote?: string;
    events?: "pending" | "active";
    settings?: { requireReceipt: boolean };
  };
  canonicalHead?: string;
  recentActivity?: Activity[];
  agents: { name: string; createdAt?: string | null }[];
  forks: { agent: string; repoName: string; head: string; events?: "pending" | "active" }[];
  packets: Packet[];
  claims: {
    packet: string;
    agent: string;
    repoName: string;
    paths: string[];
    active: boolean;
    createdAt?: string;
  }[];
  blockers: {
    id: string;
    agent: string;
    packet: string;
    paths: string[];
    reason: string;
    resolved: boolean | null | { at: string; by: string };
    claimingAgent?: string;
    pushingAgent?: string;
    sha?: string;
    repoName?: string;
    at?: string | null;
    pushingPacket?: string | null;
  }[];
  races?: Race[];
  reviews: Review[];
  ledger: {
    id?: string;
    before?: string;
    review: string;
    sha: string;
    promotedAt: string;
    receiptDigest?: string | null;
  }[];
  reconcilerAlerts: {
    sha: string;
    message: string;
    id?: string;
    repoName?: string;
    ref?: string;
    before?: string;
    after?: string;
  }[];
  promotionPending?: LedgerEntry | null;
}

export interface Packet {
  id: string;
  title: string;
  goal: string;
  paths: string[];
  acceptance: string[];
  mode?: "standard" | "race";
  /** Absent legacy records are treated as null. */
  archived?: null | { at: string; by: "owner" };
}

export interface Review {
  id: string;
  repoName: string;
  agent: string;
  packet: string;
  sha: string;
  receiptDigest: string | null;
  requestedAt?: string;
  approvedAt?: string | null;
  base?: string;
  status: "pending" | "approved" | "stale" | "promoted";
  /** Raw core flag, independent of the derived display status. */
  promoted?: boolean;
  stale?: boolean;
  returned?: null | { reason: string; at: string };
  approval?: { sha: string; receiptDigest: string | null } | null;
  receipt?: ReceiptSummary | null;
}

/** FH-032 fixed public wire summary: logs belong only to the owner receipt endpoint. */
export type ReceiptStatus = "running" | "passed" | "failed" | "infrastructure-error" | "timed-out";
export interface ReceiptSummary {
  status: ReceiptStatus;
  trigger: "review-created" | "before-promote";
  digest: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  checks: { name: string; tier: "full"; outcome: ReceiptStatus; durationMs: number | null }[];
}
/** Stored runner receipt returned by the owner-only endpoint. No bearer token plumbing. */
export interface OwnerReceipt {
  digest: string;
  receipt: {
    commit: string;
    checks: {
      check: { name: string };
      logs: { stdout: string; stderr: string; truncated: boolean };
    }[];
  };
}

/** FH-003 receive sequence is the cursor, not event time. */
export interface Activity {
  sequence: number;
  namespace: string;
  repoName: string;
  agent: string | null;
  ref: string;
  before: string;
  after: string;
  changedPaths: string[];
  changedPathCount?: number;
  changedPathsTruncated?: boolean;
  eventTimestamp: string;
  recordedAt: string;
}

export interface ActivityPage {
  activity: Activity[];
  nextAfter: number;
}
export interface ProjectOption {
  id: string;
  label: string;
}
export interface Brand {
  name: string;
  tagline: string;
}

/** An HTTP implementation today; a host may supply its Cap'n Web ui capability later. */
export interface DashboardTransport {
  /** Local connection state, separate from the Core wire snapshot. */
  live?: {
    subscribe(listener: (paused: boolean) => void): () => void;
    reconnect(): Promise<void>;
  };
  getReview?(project: string, review: string): Promise<ReviewDetail>;
  getDiff?(project: string, review: string, path: string): Promise<ReviewDiff>;
  returnReview?(
    project: string,
    review: string,
    reason: string,
  ): Promise<{ review: StateResponse["reviews"][number] }>;
  archivePacket?(project: string, packet: string): Promise<{ packet: Packet }>;
  unarchivePacket?(project: string, packet: string): Promise<{ packet: Packet }>;
  getState(project: string): Promise<ProjectState>;
  getActivity(project: string, after?: number): Promise<ActivityPage>;
  approve(project: string, review: string): Promise<unknown>;
  promote(project: string, review: string): Promise<{ sha: string }>;
  /** Optional because the read-only agent host has no owner capabilities. */
  getReceipt?(project: string, review: string): Promise<OwnerReceipt>;
  setSettings?(
    project: string,
    settings: { requireReceipt: boolean },
  ): Promise<{ settings: { requireReceipt: boolean } }>;
  /** Optional invalidations only. The authoritative snapshot still comes from getState. */
  subscribe?(project: string, invalidate: () => void): () => void;
}

/** Public wire snapshot, with optional FH-048/050/052 fields for legacy records. */
export interface StateResponse {
  project: {
    id: string;
    namespace: string;
    repoName: string;
    remote: string;
    defaultBranch: string;
    events?: "pending" | "active";
    settings?: { requireReceipt: boolean };
  };
  agents: { name: string; createdAt?: string | null }[];
  forks: {
    agent: string;
    repoName: string;
    head: string;
    remote: string;
    createdAt: string;
    events?: "pending" | "active";
  }[];
  packets: ProjectState["packets"];
  claims: { packet: string; agent: string; repoName: string; paths: string[]; createdAt: string }[];
  blockers: {
    id: string;
    packet: string;
    claimingAgent: string;
    pushingAgent: string;
    repoName: string;
    sha: string;
    paths: string[];
    at?: string | null;
    pushingPacket?: string | null;
    resolved?: { at: string; by: "release" | "promote" | "owner"; reason?: string } | null;
  }[];
  races?: Race[];
  reviews: {
    approvedAt?: string | null;
    id: string;
    packet: string;
    agent: string;
    repoName: string;
    sha: string;
    base: string;
    receiptDigest: string | null;
    receipt?: ReceiptSummary | null;
    returned?: null | { reason: string; at: string };
    approval: { sha: string; receiptDigest: string | null } | null;
    stale: boolean;
    promoted: boolean;
    createdAt: string;
  }[];
  ledger: LedgerEntry[];
  activity: Activity[];
  reconcilerAlerts: {
    id: string;
    repoName: string;
    ref: string;
    before: string;
    after: string;
    reason: string;
  }[];
  promotionPending: LedgerEntry | null;
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

/** FH-039 fixed bounded detail contract. Public reads never contain logs or tokens. */
export interface ReviewDetail {
  review: StateResponse["reviews"][number];
  packet: ProjectState["packets"][number];
  changes: {
    base: string;
    head: string;
    fileCount: number;
    truncated: boolean;
    files: { path: string; status: "added" | "modified" | "deleted" }[];
  };
  commits: {
    sha: string;
    subject: string;
    authorName: string;
    packetTrailer: string | null;
    agentTrailer: string | null;
  }[];
  commitsTruncated: boolean;
  promotion: null | {
    before: string;
    after: string;
    recordedAt: string;
    receiptDigest: string | null;
  };
  blockers: StateResponse["blockers"];
}
export interface ReviewDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
  patch: string;
  truncated: boolean;
}

/** Optional FH-052/053 read projection; absent races never produce invented entrants. */
export interface Race {
  packet: string;
  status: "open" | "finished";
  finishedAt: string | null;
  winner: string | null;
  ledgerEntryId: string | null;
  entrants: {
    agent: string;
    repoName: string;
    claimedAt: string;
    firstPushAt: string | null;
    reviewRequestedAt: string | null;
    receiptPassedAt: string | null;
    approvedAt: string | null;
    promotedAt: string | null;
    place: number | null;
    closedAt: string | null;
    closedBy: "release" | "owner" | "race-finished" | null;
    promoteRejected?: { at: string; expected: string; found: string } | null;
  }[];
}

export type RaceEntrant = Race["entrants"][number];
