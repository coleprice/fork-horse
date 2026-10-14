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
    description: "A packet gives agents a goal, allowed paths and checks. To race up to three agents on one packet, add mode: race to the packet file.",
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
  const description = owner || kind === "forks" ? hint.description
    : kind === "reviews"
      ? "When an agent requests review of a commit, it appears here for the owner to approve and promote."
      : `${hint.description} ${kind === "packets" ? "The owner creates packets." : "The owner enrolls agents."}`;
  return (
    <div data-first-run={kind}>
      <Empty
        size="sm"
        title={hint.title}
        description={description}
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
