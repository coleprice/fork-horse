import { Tooltip } from "@cloudflare/kumo";
import type { CSSProperties } from "react";
import type { ProjectState } from "./contracts.ts";

export interface AgentIdentity {
  number: number;
  silk: 1 | 2 | 3;
}
/** Enrollment rank, never response/claim/race order. Legacy agents precede dated agents. */
export function agentIdentities(agents: ProjectState["agents"]): Map<string, AgentIdentity> {
  const sorted = agents.toSorted((a, b) => {
    if (!a.createdAt && b.createdAt) return -1;
    if (a.createdAt && !b.createdAt) return 1;
    return (
      (Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0) ||
      a.name.localeCompare(b.name)
    );
  });
  return new Map(
    sorted.map((agent, index) => [
      agent.name,
      {
        number: index + 1,
        silk: ((index % 3) + 1) as 1 | 2 | 3,
      },
    ]),
  );
}
export function silkStyle(identity?: AgentIdentity): CSSProperties {
  return {
    "--lane-silk": identity ? `var(--race-silk-${identity.silk})` : "var(--text-color-kumo-subtle)",
  } as CSSProperties;
}
export function Saddlecloth({ identity }: { identity?: AgentIdentity }) {
  // Unknown agents get no invented rank. Numbers always accompany a known silk.
  return (
    <span
      className="race-saddlecloth race-cloth"
      style={silkStyle(identity)}
    >
      <span aria-hidden="true">{identity?.number ?? "—"}</span>
      <span className="sr-only">{identity ? `Agent number ${identity.number}` : "Agent number unavailable"}</span>
    </span>
  );
}
export type LaneMarkKind =
  | "claim"
  | "push"
  | "review"
  | "passed"
  | "failed"
  | "approved"
  | "promoted";
export const markGlyph: Record<LaneMarkKind, string> = {
  claim: "●",
  push: "●",
  review: "○",
  passed: "✓",
  failed: "✗",
  approved: "◆",
  promoted: "●",
};
export function LaneMarker({ kind }: { kind: LaneMarkKind | "unreached" | "reached" }) {
  const hurdle = kind === "passed" || kind === "failed";
  const reached = kind !== "unreached" && kind !== "failed";
  return (
    <span className={`lane-marker lane-marker-${kind} race-marker ${reached ? "reached" : ""} ${kind === "promoted" ? "promoted" : ""} ${hurdle ? `hurdle ${kind}` : ""}`} aria-hidden="true">
      {kind === "unreached" ? "○" : kind === "reached" ? "●" : markGlyph[kind]}
    </span>
  );
}

/** FH-055-compatible API, shared with the fork graph. */
export function saddlecloth(state: ProjectState, agent: string): number | undefined {
  return agentIdentities(state.agents).get(agent)?.number;
}
export function laneSilkStyle(state: ProjectState, agent: string): CSSProperties {
  const style = silkStyle(agentIdentities(state.agents).get(agent));
  return {
    ...style,
    "--entrant-silk": style["--lane-silk" as keyof CSSProperties],
  } as CSSProperties;
}
export function LaneRunner({
  entrant,
  state,
}: {
  entrant: { agent: string; repoName: string };
  state: ProjectState;
}) {
  return (
    <span className="race-runner" style={laneSilkStyle(state, entrant.agent)}>
      <Saddlecloth identity={agentIdentities(state.agents).get(entrant.agent)} />
      <span className="race-runner-copy">
        <strong>{entrant.agent}</strong>
        <Tooltip content={entrant.repoName} render={<code className="caption race-fork" />}>
          {entrant.repoName}
        </Tooltip>
      </span>
    </span>
  );
}

/** Decorative SVG lane path; callers supply only proven endpoints. */
export function LaneLine({ path }: { path: string }) {
  return <path className="lane-line" d={path} aria-hidden="true" />;
}
/** Table-based race connector: only consecutive recorded milestones may connect. */
export function LaneConnector({ reached }: { reached: boolean }) {
  return reached ? <span className="lane-connector" aria-hidden="true" /> : null;
}
