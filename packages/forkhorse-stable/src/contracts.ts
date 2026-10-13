import type {
  Blocker, Claim, LedgerEntry, Packet, RaceEntrant, ReceiptSummary, Review,
  StateSnapshot, UsageSources, WorkItem,
} from "./records.ts";

/** Public subscription metadata returned by core's publicEvents(). */
export interface EventStatus {
  events: "pending" | "active";
  subscriptionId?: string;
}

export interface ProjectRequest { project: string }
export type ContextRequest = ProjectRequest;
/** GET /state plus GET /me's work, matching the existing MCP context projection. */
export type ContextResponse = Omit<StateSnapshot, "project" | "forks"> & {
  project: StateSnapshot["project"] & EventStatus;
  forks: (StateSnapshot["forks"][number] & EventStatus)[];
  myWork: WorkItem[];
};

/** POST /join. HTTP adapters should use 60 seconds for the discarded Git grant. */
export interface JoinRequest extends ProjectRequest { agent: string; ttlSeconds?: number }
/** Explicit public projection: the core token is never part of this contract. */
export interface JoinResponse extends EventStatus {
  project: string;
  agent: string;
  repoName: string;
  remote: string;
  scope: "write";
  expiresAt: string;
  ttlSeconds: number;
}

/** POST /packets/:packet/claim; race entry uses this same core route. */
export interface ClaimRequest extends ProjectRequest { packet: string; repoName?: string }
export interface ClaimResponse {
  claim: (Claim | RaceEntrant) & { usage: UsageSources };
}
/** DELETE /packets/:packet/claim; authenticated agent only, no owner override. */
export interface ReleaseRequest extends ProjectRequest { packet: string }
export interface ReleaseResponse { released: true }

/** POST /reviews; sha must be the exact full commit at the caller's fork head. */
export interface RequestReviewRequest extends ProjectRequest {
  packet: string;
  repoName: string;
  sha: string;
}
export interface RequestReviewResponse { review: Review }

/** GET /reviews/:review; core authorizes the review's agent or the owner. */
export interface ReadReviewRequest extends ProjectRequest { review: string }
export interface ReadReviewResponse {
  review: Review;
  packet: Pick<Packet, "id" | "title" | "goal" | "paths" | "acceptance">;
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
  promotion: (Pick<LedgerEntry, "before" | "after" | "recordedAt" | "receiptDigest"> &
    Pick<LedgerEntry, "requireReceipt">) | null;
  blockers: Blocker[];
}

/** Read only the review's public summary, never the owner-only /receipt log route. */
export type ReadReceiptsRequest = ReadReviewRequest;
export interface ReadReceiptsResponse { receipt: ReceiptSummary | null }

export interface ContributionContract {
  context: { request: ContextRequest; response: ContextResponse };
  join: { request: JoinRequest; response: JoinResponse };
  claim: { request: ClaimRequest; response: ClaimResponse };
  release: { request: ReleaseRequest; response: ReleaseResponse };
  requestReview: { request: RequestReviewRequest; response: RequestReviewResponse };
  readReview: { request: ReadReviewRequest; response: ReadReviewResponse };
  readReceipts: { request: ReadReceiptsRequest; response: ReadReceiptsResponse };
}

/** v1 names are reserved capabilities only; they carry no request/response shapes. */
export const contributionVerbs = [
  { name: "context", status: "v0" },
  { name: "join", status: "v0" },
  { name: "claim", status: "v0" },
  { name: "release", status: "v0" },
  { name: "requestReview", status: "v0" },
  { name: "readReview", status: "v0" },
  { name: "readReceipts", status: "v0" },
  { name: "list_projects", status: "v1" },
  { name: "start_work", status: "v1" },
  { name: "resume_work", status: "v1" },
  { name: "end_work", status: "v1" },
  { name: "read_tree", status: "v1" },
  { name: "read_file", status: "v1" },
  { name: "read_diff", status: "v1" },
  { name: "run_checks", status: "v1" },
] as const;

export type ContributionVerb = typeof contributionVerbs[number]["name"];
export type V0Verb = keyof ContributionContract;
export type V1Verb = Extract<typeof contributionVerbs[number], { status: "v1" }>["name"];
export type ContributionRequest<V extends V0Verb> = ContributionContract[V]["request"];
export type ContributionResponse<V extends V0Verb> = ContributionContract[V]["response"];
export type ContributionApi = {
  [V in V0Verb]: (request: ContributionRequest<V>) => Promise<ContributionResponse<V>>;
};
