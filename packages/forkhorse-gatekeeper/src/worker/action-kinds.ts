import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";

/** Eligibility only. The OS applies its user-controlled per-kind approval rules. */
export const actionKinds = {
  claim: { tag: "claim", label: "Claim a packet" },
  raceEntry: { tag: "race-entry", label: "Enter a race" },
  join: { tag: "join", label: "Create an agent fork" },
  push: { tag: "push", label: "Push a commit" },
  requestReview: { tag: "request-review", label: "Request review" },
  release: { tag: "release", label: "Release a claim" },
} satisfies Record<string, ActionKind>;
