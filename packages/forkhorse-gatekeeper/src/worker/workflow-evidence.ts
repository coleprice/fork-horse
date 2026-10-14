import type { WorkflowContext, WorkflowWrite } from "./workflow.ts";

/** Public identifiers captured before sending; existing forks cannot prove a new join. */
export interface Evidence {
  agent: string;
  project: string;
  forks: string[];
  claim: string | null;
}
const claimKey = (claim: { repoName: string; createdAt?: string; claimedAt?: string }) =>
  JSON.stringify([claim.repoName, claim.createdAt ?? claim.claimedAt]);
export function evidence(context: WorkflowContext, agent: string, operation: WorkflowWrite): Evidence {
  if (!Array.isArray(context.forks) || !Array.isArray(context.claims) || !Array.isArray(context.races) || !Array.isArray(context.reviews)) {
    throw new Error("Workflow context is incomplete. Check the project's forks, claims, races and reviews.");
  }
  const packet = "packet" in operation ? operation.packet : undefined;
  const claim = context.claims.find(item => item.packet === packet && item.agent === agent);
  const entrant = context.races.find(race => race.packet === packet)?.entrants.find(item => item.agent === agent && !item.closedAt);
  return { agent, project: context.project.id, forks: context.forks.filter(fork => fork.agent === agent).map(fork => fork.repoName), claim: claim ? claimKey(claim) : entrant ? claimKey(entrant) : null };
}
export function outcome(context: WorkflowContext, before: Evidence, operation: WorkflowWrite, race: boolean): "applied" | "absent" | "ambiguous" {
  const now = evidence(context, before.agent, operation);
  if (now.project !== before.project) return "ambiguous";
  switch (operation.kind) {
    case "join": {
      const added = now.forks.filter(name => !before.forks.includes(name));
      if (added.length === 1) return "applied";
      return added.length === 0 && before.forks.every(name => now.forks.includes(name)) ? "absent" : "ambiguous";
    }
    case "claim": {
      if (race) {
        const entrants = context.races.find(item => item.packet === operation.packet)?.entrants;
        if (!entrants) return "ambiguous";
        const entrant = entrants.find(item => item.agent === before.agent);
        if (!entrant) return "absent";
        return entrant.repoName === operation.repoName ? "applied" : "ambiguous";
      }
      const claim = context.claims.find(item => item.packet === operation.packet && item.agent === before.agent);
      if (!claim) return "absent";
      return claim.repoName === operation.repoName ? "applied" : "ambiguous";
    }
    case "requestReview":
      return context.reviews.some(review => review.agent === before.agent && review.packet === operation.packet && review.repoName === operation.repoName && review.sha === operation.sha) ? "applied" : "absent";
    case "release":
      if (now.claim === null) return "applied";
      return now.claim === before.claim ? "absent" : "ambiguous";
  }
}
export function uncertain(operation: WorkflowWrite): Error {
  const check = operation.kind === "join" ? "the connected agent's new forks" : operation.kind === "requestReview" ? `reviews for commit ${operation.sha.slice(0, 7)}` : `claims and race entrants for ${operation.packet}`;
  return new Error(`Workflow outcome uncertain. Check ${check} in context; this call will not blindly resend the write.`);
}
