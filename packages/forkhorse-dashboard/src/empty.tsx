import { Button, ClipboardText, Empty } from "@cloudflare/kumo";
import brand from "../../../brand.json" with { type: "json" };
import type { ProjectState } from "./contracts.ts";

type FirstRunKind = "projects" | "agents" | "packets" | "forks" | "reviews";
const firstRun: Record<FirstRunKind, { title: string; description: string; command?: string }> = {
  projects: {
    title: "No projects yet",
    description: "Create a project with the owner CLI. It sets up the canonical repo and enrolls your first agents.",
    command: `${brand.slug} project create <project> --config "$CLI_CONFIG" --agents <agent> --output "$PRIVATE_TOKEN_FILE"`,
  },
  agents: {
    title: "No agents yet",
    description: "Enroll an agent. Each agent works in its own fork.",
    command: `${brand.slug} agent enroll <agent> --config "$CLI_CONFIG" --output "$NEW_PRIVATE_TOKEN_FILE"`,
  },
  packets: {
    title: "No packets yet",
    description: "A packet gives agents a goal, allowed paths and checks. Set mode: race to let several agents work on it at once.",
    command: `${brand.slug} packet create packet.yaml --config "$CLI_CONFIG"`,
  },
  forks: {
    title: "No forks yet",
    description: "Forks appear here when an agent claims a packet.",
  },
  reviews: {
    title: "No reviews yet",
    description: "When an agent requests review of a commit, it appears here for you to approve and promote.",
  },
};

/** Retained forks, promotions and race entries are history, even without a current claim. */
export function overviewFirstRun(state: ProjectState): FirstRunKind | undefined {
  if (!state.agents.length) return "agents";
  if (!state.packets.length) return "packets";
  if (!state.claims.some((claim) => claim.active) && !state.forks.length &&
    !state.ledger.length && !state.races?.some((race) => race.entrants.length)) return "forks";
  return undefined;
}

/** Read-only owner guidance. Copying a placeholder command never performs an owner write. */
export function FirstRunEmpty({ kind, owner, goToWork }: {
  kind: FirstRunKind;
  owner: boolean;
  goToWork?(): void;
}) {
  const hint = firstRun[kind];
  const agentNote = kind === "projects" || kind === "agents"
    ? "The owner enrolls agents." : "The owner creates packets.";
  return (
    <div data-first-run={kind}>
      <Empty
        size="sm"
        title={hint.title}
        description={owner ? hint.description : `${hint.description} ${agentNote}`}
        contents={owner && (hint.command ? (
          <div className="first-run-command">
            <code>{hint.command}</code>
            <ClipboardText text="" textToCopy={hint.command} size="sm" className="first-run-copy" />
          </div>
        ) : kind === "reviews" && goToWork ? (
          <Button variant="ghost" size="sm" onClick={goToWork}>Go to Work</Button>
        ) : undefined)}
      />
    </div>
  );
}
