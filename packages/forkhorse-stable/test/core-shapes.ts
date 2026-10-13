// Compiled against declarations freshly read from core by contracts.test.ts.
// These aliases are test-only paths; the shipping package imports no core code.
import type * as Core from "core-workflow";
import type { Project, Activity } from "core-records";
import type { CoreOperation } from "core-operations";
import type * as Stable from "../src/index.ts";

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type ExpectedReview = Omit<Core.Review, "receiptGeneration" | "receipt" | "usageAtReview"> & {
  receipt: Core.ReceiptSummary | null;
  usageAtReview: Core.UsageSources;
};
type ExpectedState = Omit<Core.StateSnapshot, "reviews"> & { reviews: ExpectedReview[] };
type RequestFor<K extends CoreOperation["kind"]> = Omit<Extract<CoreOperation, { kind: K }>, "kind">;

export type CoreCompatibility = [
  Assert<Same<Stable.Project, Project>>,
  Assert<Same<Stable.Activity, Activity>>,
  Assert<Same<Stable.Packet, Core.Packet>>,
  Assert<Same<Stable.Claim, Core.Claim>>,
  Assert<Same<Stable.RaceEntrant, Core.RaceEntrant>>,
  Assert<Same<Stable.RaceState, Core.RaceState>>,
  Assert<Same<Stable.ReceiptSummary, Core.ReceiptSummary>>,
  Assert<Same<Stable.WorkItem, Core.WorkItem>>,
  Assert<Same<Stable.Blocker, Core.Blocker>>,
  Assert<Same<Stable.LedgerEntry, Core.LedgerEntry>>,
  Assert<Same<Stable.StateSnapshot, ExpectedState>>,
  Assert<Same<Stable.Review, ExpectedReview>>,
  Assert<Same<keyof Stable.Review, keyof ExpectedReview>>,
  Assert<Same<Stable.ContextResponse["myWork"], Core.WorkItem[]>>,
  Assert<Same<Stable.ClaimResponse["claim"], (Core.Claim | Core.RaceEntrant) & { usage: Core.UsageSources }>>,
  Assert<Same<Stable.RequestReviewResponse["review"], ExpectedReview>>,
  Assert<Same<Stable.ReadReviewResponse["review"], ExpectedReview>>,
  Assert<Same<Stable.ReadReviewResponse["packet"], Pick<Core.Packet, "id" | "title" | "goal" | "paths" | "acceptance">>>,
  Assert<Same<Stable.ReadReviewResponse["promotion"], Pick<Core.LedgerEntry, "before" | "after" | "recordedAt" | "receiptDigest" | "requireReceipt"> | null>>,
  Assert<Same<Stable.ReadReceiptsResponse["receipt"], Core.ReceiptSummary | null>>,
  Assert<Same<Stable.ContextRequest, RequestFor<"state">>>,
  Assert<Same<Stable.JoinRequest, RequestFor<"join">>>,
  Assert<Same<Stable.ClaimRequest, RequestFor<"claim">>>,
  Assert<Same<Stable.RequestReviewRequest, RequestFor<"review">>>,
  Assert<Same<Exclude<Stable.ContributionVerb, Stable.V1Verb>, keyof Stable.ContributionContract>>,
  Assert<Same<Extract<keyof Stable.JoinResponse, "token" | "apiToken" | "agentCredential">, never>>,
];

// v1 cannot accidentally enter a typed v0 adapter.
// @ts-expect-error v1 shapes are deliberately undefined.
export type NoV1Shape = Stable.ContributionRequest<"start_work">;
// @ts-expect-error execution generation stays private to core.
export type NoGeneration = Stable.Review["receiptGeneration"];
// @ts-expect-error the join grant is never a public response field.
export type NoJoinKey = Stable.JoinResponse["token"];
