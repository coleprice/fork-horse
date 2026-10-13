import { Tooltip } from "@cloudflare/kumo";
import type { CSSProperties } from "react";
import type { ProjectState, RaceEntrant } from "./contracts.ts";
import { saddlecloth } from "./race-model.ts";

/** Shared identity for race lanes and their results; enrollment carries the number. */
export function LaneRunner({
  entrant,
  state,
}: {
  entrant: Pick<RaceEntrant, "agent" | "repoName">;
  state: ProjectState;
}) {
  const number = saddlecloth(state, entrant.agent);
  return (
    <span className="race-runner">
      {number !== undefined && (
        <span className="race-cloth" aria-label={`Saddlecloth ${number}`}>
          {number}
        </span>
      )}
      <span className="race-runner-copy">
        <strong>{entrant.agent}</strong>
        <Tooltip content={entrant.repoName} render={<code className="caption race-fork" />}>
          {entrant.repoName}
        </Tooltip>
      </span>
    </span>
  );
}
export function laneSilkStyle(state: ProjectState, agent: string): CSSProperties {
  const number = saddlecloth(state, agent);
  return {
    "--entrant-silk":
      number === undefined
        ? "var(--color-kumo-ring)"
        : `var(--race-silk-${((number - 1) % 3) + 1})`,
  } as CSSProperties;
}
/** Shapes describe recorded events; silk describes identity. */
export function LaneMarker({
  kind,
}: {
  kind: "unreached" | "reached" | "promoted" | "passed" | "failed";
}) {
  const hurdle = kind === "passed" || kind === "failed";
  const reached = kind !== "unreached" && kind !== "failed";
  return (
    <span
      className={`race-marker ${reached ? "reached" : ""} ${kind === "promoted" ? "promoted" : ""} ${hurdle ? `hurdle ${kind}` : ""}`}
      aria-hidden="true"
    >
      {hurdle ? (kind === "failed" ? "✗" : "✓") : ""}
    </span>
  );
}
