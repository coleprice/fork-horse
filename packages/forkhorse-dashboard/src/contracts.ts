/** View projection of the public FH-005 wire state; never includes credentials. */
export interface ProjectState {
  project: { id: string; repoName: string; defaultBranch: string; remote?: string };
  canonicalHead?: string;
  recentActivity?: Activity[];
  agents: { name: string }[];
  forks: { agent: string; repoName: string; head: string }[];
  packets: { id: string; title: string; goal: string; paths: string[]; acceptance: string[] }[];
  claims: { packet: string; agent: string; repoName: string; paths: string[]; active: boolean }[];
  blockers: {
    id: string;
    agent: string;
    packet: string;
    paths: string[];
    reason: string;
    resolved: boolean;
  }[];
  reviews: Review[];
  ledger: { review: string; sha: string; promotedAt: string }[];
  reconcilerAlerts: { sha: string; message: string }[];
}

export interface Review {
  id: string;
  repoName: string;
  agent: string;
  packet: string;
  sha: string;
  receiptDigest: string | null;
  requestedAt?: string;
  status: "pending" | "approved" | "stale" | "promoted";
  receipt?: { status: "passed" | "failed"; commands: string[] };
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
  getState(project: string): Promise<ProjectState>;
  getActivity(project: string, after?: number): Promise<ActivityPage>;
  approve(project: string, review: string): Promise<unknown>;
  promote(project: string, review: string): Promise<{ sha: string }>;
  /** Optional invalidations only. The authoritative snapshot still comes from getState. */
  subscribe?(project: string, invalidate: () => void): () => void;
}

/** FH-005 JSON snapshot. Only live claims appear; blockers currently have no resolution field. */
export interface StateResponse {
  project: {
    id: string;
    namespace: string;
    repoName: string;
    remote: string;
    defaultBranch: string;
  };
  agents: { name: string }[];
  forks: { agent: string; repoName: string; head: string; remote: string; createdAt: string }[];
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
  }[];
  reviews: {
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
