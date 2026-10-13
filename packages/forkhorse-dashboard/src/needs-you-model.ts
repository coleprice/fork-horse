import type { Brand, ProjectState } from "./contracts.ts";
import { blockedLabel, blockerPacket, reviewGate, reviewState } from "./model.ts";
import { duration } from "./receipts.tsx";
import { relativeTime } from "./time.ts";

export type NeedKind =
  | "promotionPending"
  | "reconciler"
  | "blocker"
  | "failed"
  | "promote"
  | "approve";
export type CopyPart = string | { code: string; full?: string };
export interface OwnerNeed {
  id: string;
  kind: NeedKind;
  title: CopyPart[];
  why: CopyPart[];
  outcome: CopyPart[];
  target: { review: string } | { packet: string; collision?: string } | { repo: string } | { promotion: true };
}
export const copyText = (parts: CopyPart[]) =>
  parts.map((part) => (typeof part === "string" ? part : part.code)).join("");
const sha = (value?: string): CopyPart =>
  value ? { code: value.slice(0, 7), full: value } : "an unavailable head";
const mono = (code: string): CopyPart => ({ code });
const timestamp = (value?: string) => Date.parse(value ?? "") || 0;
// Core persists receive-sequence IDs for alerts and collisions; current-head has no sequence.
const sequence = (id?: string) =>
  /^\d+(?:-|$)/.test(id ?? "") ? Number(id!.split("-")[0]) : Infinity;

/** Public state only. Use the review panel's gate, never a second approval policy. */
export function ownerNeeds(state: ProjectState, brand: Brand, now = Date.now()): OwnerNeed[] {
  const items: OwnerNeed[] = [];
  const pending = state.promotionPending;
  if (pending) {
    const review = state.reviews.find((r) => r.id === pending.review);
    items.push({
      id: `promotion:${pending.id}`,
      kind: "promotionPending",
      title: [`Confirm a promotion of ${review?.packet ?? pending.review}`],
      why: [
        `${brand.name} started moving `,
        mono("main"),
        " ",
        sha(pending.before),
        " → ",
        sha(pending.after),
        " but couldn't confirm the result.",
      ],
      outcome: ["Until it's confirmed, the ledger may not match ", mono("main"), "."],
      target: pending.review ? { review: pending.review } : { promotion: true },
    });
  }
  for (const alert of state.reconcilerAlerts.toSorted((a, b) => sequence(a.id) - sequence(b.id))) {
    items.push({
      id: `alert:${alert.id ?? `${alert.sha}:${alert.message}`}`,
      kind: "reconciler",
      title: [mono(alert.ref ?? "main"), ` moved outside ${brand.name}`],
      why:
        alert.before && alert.after
          ? [
              mono(alert.repoName ?? state.project.repoName),
              " went ",
              sha(alert.before),
              " → ",
              sha(alert.after),
              " without a promotion.",
            ]
          : [alert.message, " ", sha(alert.sha)],
      outcome: alert.before
        ? ["Open reviews based on ", sha(alert.before), " may now be stale."]
        : ["Open reviews may now be stale."],
      target: { repo: alert.repoName ?? state.project.repoName },
    });
  }
  for (const blocker of state.blockers
    .filter((b) => !b.resolved)
    .toSorted((a, b) => sequence(a.id) - sequence(b.id))) {
    items.push({
      id: `blocker:${blocker.id}`,
      kind: "blocker",
      title: [`Sort out a claim collision on ${blocker.packet}`],
      why:
        blocker.pushingAgent && blocker.claimingAgent && blocker.sha && blocker.paths.length
          ? [
              `${blocker.pushingAgent} pushed `,
              sha(blocker.sha),
              " to ",
              mono(blocker.paths[0]),
              ...(blocker.paths.length > 1 ? [` +${blocker.paths.length - 1}`] : []),
              `, which ${blocker.claimingAgent} has claimed.`,
            ]
          : [blocker.reason],
      outcome: [`${blockedLabel(blocker)} stays blocked until the collision is resolved.`],
      target: { packet: blockerPacket(blocker), collision: blocker.id },
    });
  }
  const required = state.project.settings?.requireReceipt === true;
  const reviews = state.reviews
    .filter(
      (review) =>
        reviewState(review, state).kind === "current" &&
        review.status !== "stale" &&
        state.forks.find((f) => f.repoName === review.repoName)?.head === review.sha,
    )
    .toSorted(
      (a, b) => timestamp(a.requestedAt) - timestamp(b.requestedAt) || a.id.localeCompare(b.id),
    );
  for (const review of reviews) {
    const receipt = review.receipt;
    if (
      !required ||
      !receipt ||
      !["failed", "timed-out", "infrastructure-error"].includes(receipt.status)
    )
      continue;
    const checks = receipt.checks.filter((check) => check.outcome === receipt.status);
    const count = receipt.checks.length;
    const why: CopyPart[] =
      receipt.status === "failed"
        ? [`${checks.length} of ${count} ${count === 1 ? "check" : "checks"} failed`]
        : receipt.status === "timed-out"
          ? ["Checks timed out"]
          : ["The checks didn't start"];
    for (const check of checks) {
      why.push(" · ", mono(check.name));
      if (duration(check.durationMs)) why.push(` (${duration(check.durationMs)})`);
    }
    items.push({
      id: `failed:${review.id}`,
      kind: "failed",
      title: [`${review.packet} didn't pass its checks`],
      why,
      outcome:
        receipt.status === "failed"
          ? [
              `It can't be approved until ${review.agent} pushes a fix. Return it to say what to change.`,
            ]
          : ["Promote or a new push runs the checks again."],
      target: { review: review.id },
    });
  }
  for (const kind of ["promote", "approve"] as const) {
    for (const review of reviews) {
      // A failed-required row routes to the evidence once, even when an interrupted approved run can retry.
      if (
        required &&
        review.receipt &&
        ["failed", "timed-out", "infrastructure-error"].includes(review.receipt.status)
      )
        continue;
      const gate = reviewGate(review, state);
      if (!gate[kind]) continue;
      items.push({
        id: `${kind}:${review.id}`,
        kind,
        title:
          kind === "promote"
            ? [`Promote ${review.packet} to `, mono("main")]
            : [`Review ${review.packet} from ${review.agent}`],
        why:
          kind === "promote"
            ? [
                "Approved at ",
                sha(review.sha),
                ...(review.receipt?.status === "passed" ? [" · Checks passed"] : []),
              ]
            : [
                `Requested ${relativeTime(review.requestedAt ?? "", now) || "at an unavailable time"}`,
                ...(required ? [" · Checks passed"] : [" · Checks advisory"]),
              ],
        outcome:
          kind === "promote"
            ? [
                mono("main"),
                " moves ",
                sha(review.base),
                " → ",
                sha(review.sha),
                ".",
                ...(required ? [" Checks run again first."] : []),
              ]
            : ["Approving lets you promote it to ", mono("main"), "."],
        target: { review: review.id },
      });
    }
  }
  return items;
}
