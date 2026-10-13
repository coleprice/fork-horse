import { openEntrants } from "./race-entrants";
import type { Claim, Packet, Review, WorkItem } from "./workflow-types";

const hints: Record<WorkItem["next"], string> = {
  push: "Push your changes to the claimed fork.",
  request_review: "Request a review of the current fork head.",
  wait_for_checks: "Wait for the current review checks to finish.",
  fix_checks: "Fix the review checks and request a review of your updated work.",
  address_return: "Address the owner's return, push your changes, and request a new review.",
  wait_for_owner: "Wait for the owner to review and promote your work.",
  done: "This review has been promoted.",
};

/** First-match precedence is shared by every caller-owned work item. */
function nextStep(
  item: Omit<WorkItem, "next" | "hint">,
  requireReceipt: boolean,
): WorkItem["next"] {
  const review = item.review;
  if (review?.promoted) return "done";
  if (review?.returned && item.forkHead === review.sha) return "address_return";
  if (!review || review.stale || item.forkHead !== review.sha)
    return !review && item.forkHead === item.canonicalHead ? "push" : "request_review";
  if (review.receipt?.status === "running") return "wait_for_checks";
  if (requireReceipt && review.receipt?.status !== "passed") return "fix_checks";
  return "wait_for_owner";
}

/** Heads come only from already-validated caller-owned fork records in /me. */
export async function resumeWork(
  storage: DurableObjectStorage,
  agent: string,
  heads: Map<string, string>,
  canonicalHead: string,
  requireReceipt: boolean,
): Promise<WorkItem[]> {
  const claims = await storage.list<Claim>({ prefix: "claim:" });
  // Preserve standard validation below while presenting live entrants through the same work rules.
  const owned = [...claims.entries(), ...(await openEntrants(storage)).map(entrant => [`claim:${entrant.packet}`, entrant] as const)];
  const packets = await storage.list<Packet>({ prefix: "packet:" });
  const reviews = [...(await storage.list<Review>({ prefix: "review:" })).entries()]
    .filter(
      ([key, review]) => key === `review:${review.id}` && review.agent === agent && !review.stale,
    )
    .map(([, review]) => review)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const work: WorkItem[] = [];
  for (const [key, claim] of owned) {
    const forkHead = heads.get(claim.repoName);
    const packet = packets.get(`packet:${claim.packet}`);
    if (
      claim.agent !== agent ||
      key !== `claim:${claim.packet}` ||
      forkHead === undefined ||
      !packet ||
      packet.id !== claim.packet
    )
      continue;
    const review = reviews.find(
      (candidate) => candidate.packet === claim.packet && candidate.repoName === claim.repoName,
    );
    const item = {
      packet: { id: packet.id, title: packet.title },
      repoName: claim.repoName,
      claimedAt: claim.createdAt,
      forkHead,
      canonicalHead,
      review: review
        ? {
            id: review.id,
            sha: review.sha,
            // A raw Git push may precede its event; report current staleness without mutating history.
            stale: !review.promoted && forkHead !== review.sha,
            returned: review.returned ?? null,
            receipt: review.receipt ?? null,
            approved: !!review.approval,
            promoted: review.promoted,
          }
        : null,
    };
    const next = nextStep(item, requireReceipt);
    work.push({ ...item, next, hint: hints[next] });
  }
  return work;
}
