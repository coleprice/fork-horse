import { useEffect, useId, useRef, useState } from "react";
import { Button, LayerCard, Tooltip } from "@cloudflare/kumo";
import type { ProjectState } from "./contracts.ts";
import { LaneLine, LaneMarker, Saddlecloth, silkStyle } from "./lane.tsx";
import {
  clockTime,
  collisionLink,
  foldMarks,
  forkGraph,
  timestamp,
  type ForkLane,
  type WindowChoice,
} from "./fork-graph-model.ts";

const eventText = (lane: ForkLane, kinds: string[]) =>
  lane.events
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${clockTime(e.at)} ${e.label}`)
    .join(" · ") || "—";
const storageKey = (project: string) => `fork-table:${project}`;
function defaultTable(project: string) {
  try {
    const saved = localStorage.getItem(storageKey(project));
    if (saved !== null) return saved === "open";
  } catch {
    /* Host storage can be unavailable. */
  }
  return typeof window !== "undefined" && window.innerWidth < 640;
}
export function ForkGraph({
  state,
  owner,
  openReview,
  openPacket,
  openReceipt,
  now = Date.now(),
}: {
  state: ProjectState;
  owner: boolean;
  openReview(id: string): void;
  openPacket(id: string): void;
  openReceipt(id: string): void;
  now?: number;
}) {
  const [choice, setChoice] = useState<WindowChoice>("recent");
  const [expanded, setExpanded] = useState(false);
  const [tableOpen, setTableOpen] = useState(() => defaultTable(state.project.id));
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 640,
  );
  const effectiveOpen = phone || tableOpen;
  useEffect(() => {
    const resize = () => setPhone(window.innerWidth < 640);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const tableId = useId();
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const graph = forkGraph(state, now, choice);
  const lanes = expanded ? graph.lanes : graph.lanes.slice(0, 8);
  const innerWidth = Math.max(1, width - 52);
  const percent = (at: number) =>
    (100 *
      (12 +
        Math.max(0, Math.min(1, (at - graph.start) / Math.max(1, now - graph.start))) *
          innerWidth)) /
    Math.max(1, width);
  const x = (at: number) =>
    12 + Math.max(0, Math.min(1, (at - graph.start) / Math.max(1, now - graph.start))) * innerWidth;
  const layout = lanes.map((lane, index) => ({
    lane,
    y:
      80 +
      index * 64 +
      lanes.slice(0, index + 1).filter((l, i) => l.race && l.race !== lanes[i - 1]?.race).length *
        30,
  }));
  const height = (layout.at(-1)?.y ?? 54) + 52;
  const navigate = (lane: ForkLane) => {
    if (owner && lane.review) openReview(lane.review.id);
    else if (lane.race) location.hash = `race/${encodeURIComponent(lane.race)}`;
    else openPacket(lane.packet);
  };
  const ticks: number[] = [];
  const tickStep =
    now - graph.start > 12 * 3600000
      ? 4 * 3600000
      : now - graph.start > 6 * 3600000
        ? 2 * 3600000
        : 3600000;
  for (
    let at = Math.ceil(graph.start / tickStep) * tickStep;
    at < now - (20 / innerWidth) * (now - graph.start);
    at += tickStep
  )
    ticks.push(at);
  const mainMarks = foldMarks(
    graph.ledger.map((e) => ({
      id: e.review,
      kind: "promoted" as const,
      at: timestamp(e.promotedAt)!,
      label: `${e.sha.slice(0, 7)} promoted to main`,
    })),
    graph.start,
    now,
    innerWidth,
  );
  const summary = `Fork graph: ${graph.summary}`;
  return (
    <LayerCard className="p-4 fork-card">
      <div className="fork-header">
        <div>
          <h2>Forks</h2>
          <p className="caption muted">{graph.summary}</p>
        </div>
        <p className="caption muted fork-window">
          {clockTime(graph.start)} – now
          <br />
          hover a mark for its time
        </p>
      </div>
      <div className="fork-chips" aria-label="Fork graph time window">
        {(
          [
            ["recent", "Recent"],
            ["four", "Last 4 h"],
            ["today", "Today"],
            ["day", "24 h"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            className="fork-window-chip"
            variant={choice === value ? "secondary" : "ghost"}
            aria-pressed={choice === value}
            onClick={() => setChoice(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="fork-picture" role="img" aria-label={summary} aria-describedby={tableId}>
        <div className="fork-labels" style={{ height }}>
          <div className="fork-main-label">
            <code>main</code> <span className="caption muted">canonical</span>
          </div>
          {layout.map(({ lane, y }, index) => (
            <div key={lane.id}>
              {lane.race && lane.race !== lanes[index - 1]?.race && (
                <a
                  className="fork-race-label caption"
                  style={{ top: y - 48 }}
                  href={`#race/${encodeURIComponent(lane.race)}`}
                >
                  Race · {lane.packet} · {graph.lanes.filter((l) => l.race === lane.race).length}{" "}
                  entrants
                </a>
              )}
              <button
                className="fork-lane-label"
                style={{ top: y - 24, ...silkStyle(lane.identity) }}
                onClick={() => navigate(lane)}
              >
                <Saddlecloth identity={lane.identity} />
                <span>
                  <strong>{lane.agent}</strong>
                  <code className="caption">{lane.packet}</code>
                  <span
                    className={`fork-state caption ${
                      lane.state === "Promoted to main" || lane.state === "Approved"
                        ? "fork-state-success"
                        : lane.state === "Checks running"
                          ? "fork-state-info"
                          : lane.state === "Racing"
                            ? "fork-state-brand"
                            : ""
                    }`}
                  >
                    <span aria-hidden="true">●</span> {lane.state}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
        <div ref={plot} className="fork-plot" style={{ height }}>
          <svg width="100%" height={height} aria-hidden="true">
            {ticks.map((at) => (
              <line
                key={at}
                x1={`${percent(at)}%`}
                x2={`${percent(at)}%`}
                y1="12"
                y2={height - 26}
                className="fork-grid"
              />
            ))}
            <line
              x1="12"
              x2={Math.max(12, width - 40)}
              y1="30"
              y2="30"
              className="fork-main-line"
            />
            <line
              x1={Math.max(12, width - 40)}
              x2={Math.max(12, width - 40)}
              y1="14"
              y2={height - 26}
              className="fork-now-line"
            />
            {layout.map(({ lane, y }) => {
              const start = x(lane.start ?? graph.start),
                end = x(lane.end ?? now);
              const known = lane.claimedAt !== undefined && lane.claimedAt >= graph.start;
              const branchEnd = Math.min(end, start + 20);
              const mergeStart = Math.max(branchEnd, end - 28);
              return (
                <g key={lane.id} style={silkStyle(lane.identity)}>
                  {lane.race && (
                    <path d={`M 3 ${y - 12} L 3 ${y + 12}`} className="fork-race-bracket" />
                  )}
                  <LaneLine
                    path={
                      known
                        ? `M ${start} 30 C ${start} ${y} ${branchEnd - 12} ${y} ${branchEnd} ${y} H ${lane.promoted ? mergeStart : end}`
                        : `M ${start} ${y} H ${lane.promoted ? mergeStart : end}`
                    }
                  />
                  {lane.promoted && (
                    <LaneLine path={`M ${mergeStart} ${y} C ${end} ${y} ${end} 30 ${end} 30`} />
                  )}
                  {lane.releasedAt && (
                    <line className="fork-lane-line" x1={end} x2={end} y1={y - 5} y2={y + 5} />
                  )}
                </g>
              );
            })}
          </svg>
          <span className="fork-now caption" style={{ left: `${percent(now)}%` }}>
            now
          </span>
          {ticks.map((at) => (
            <span
              className="fork-tick caption muted"
              key={at}
              style={{ left: `${percent(at)}%`, top: height - 22 }}
            >
              {clockTime(at)}
            </span>
          ))}
          {mainMarks.map((group, index) => {
            const entry = graph.ledger.find((e) => e.review === group.event.id)!;
            const text = group.events.map((e) => `${clockTime(e.at)} ${e.label}`).join(" · ");
            const hasReceipt = state.reviews.some(
              (r) =>
                r.id === entry.review &&
                r.sha === entry.sha &&
                r.receipt?.digest === entry.receiptDigest &&
                r.receipt?.status !== "running" &&
                !!entry.receiptDigest,
            );
            return (
              <div
                key={group.event.id}
                className="fork-main-mark"
                style={{ left: `${percent(group.event.at)}%`, top: 30 }}
              >
                <Tooltip
                  content={text}
                  render={
                    <button
                      className="fork-mark-button"
                      aria-label={text}
                      onClick={() => {
                        if (hasReceipt) openReceipt(entry.review);
                        else if (owner) openReview(entry.review);
                      }}
                    />
                  }
                >
                  <span className="fork-commit-dot" aria-hidden="true" />
                </Tooltip>
                {group.events.length === 1 &&
                  innerWidth > 450 &&
                  x(group.event.at) > 35 &&
                  width - x(group.event.at) > 35 &&
                  (index === 0 || group.x - mainMarks[index - 1].x > 60) &&
                  (index === mainMarks.length - 1 || mainMarks[index + 1].x - group.x > 60) && (
                    <code className="caption fork-sha">{entry.sha.slice(0, 7)}</code>
                  )}
              </div>
            );
          })}
          {layout.map(({ lane, y }) => (
            <div key={lane.id}>
              {(lane.claimedAt === undefined ||
                lane.claimedAt < graph.start ||
                lane.earlierPushes) && (
                <span
                  className="fork-history caption muted"
                  style={{ left: `${percent(lane.start ?? graph.start)}%`, top: y + 10 }}
                >
                  {lane.claimedAt === undefined ? (
                    <Tooltip
                      content="Started before the loaded history"
                      render={
                        <button
                          className="fork-stub"
                          aria-label="Started before the loaded history"
                        />
                      }
                    >
                      ‹
                    </Tooltip>
                  ) : lane.claimedAt < graph.start ? (
                    <span className="fork-stub">‹ since {clockTime(lane.claimedAt)}</span>
                  ) : null}
                  {lane.earlierPushes && (
                    <span className="fork-earlier">Earlier pushes not shown</span>
                  )}
                </span>
              )}
              {foldMarks(
                lane.events.filter((e) => !lane.promoted || e.kind !== "promoted"),
                graph.start,
                now,
                innerWidth,
              ).map((group) => {
                const text = group.events.map((e) => `${clockTime(e.at)} ${e.label}`).join(" · ");
                return (
                  <Tooltip
                    key={group.event.id}
                    content={text}
                    render={
                      <button
                        className="fork-mark-button fork-event"
                        style={{
                          left: `${percent(group.event.at)}%`,
                          top: y,
                          ...silkStyle(lane.identity),
                        }}
                        aria-label={text}
                        onClick={() => navigate(lane)}
                      />
                    }
                  >
                    <LaneMarker kind={group.event.kind} />
                  </Tooltip>
                );
              })}
            </div>
          ))}
          {state.blockers.map((blocker) => {
            const at = timestamp(blocker.at);
            if (at === undefined || at < graph.start || at > now) return null;
            const pushing = layout.find(
              ({ lane }) =>
                lane.agent === blocker.pushingAgent &&
                lane.repoName === blocker.repoName &&
                lane.packet === blocker.pushingPacket,
            );
            const claiming = layout.find(
              ({ lane }) => lane.agent === blocker.claimingAgent && lane.packet === blocker.packet,
            );
            if (!pushing || !claiming || pushing === claiming) return null;
            const { ringY, segments } = collisionLink(
              pushing.y,
              claiming.y,
              layout.map(({ y }) => y),
            );
            const caption = `collision · ${blocker.resolved ? "resolved" : "open"}`;
            const text = `${clockTime(at)} ${caption}: ${blocker.pushingAgent} with ${blocker.claimingAgent}`;
            const freeRight = innerWidth - (x(at) - 12) > 150;
            const freeLeft = x(at) - 12 > 150;
            const nearMark = layout.some(
              ({ lane, y }) =>
                Math.abs(y - ringY) < 22 &&
                lane.events.some((e) => Math.abs(x(e.at) - x(at)) < 150),
            );
            const showCaption =
              (freeRight || freeLeft) && !nearMark && Math.abs(claiming.y - pushing.y) === 64;
            return (
              <div
                key={blocker.id}
                className={`fork-collision ${blocker.resolved ? "resolved" : ""}`}
              >
                {segments.map(({ top, height: segmentHeight }) => (
                  <span
                    key={top}
                    className="fork-collision-line"
                    style={{ left: `${percent(at)}%`, top, height: segmentHeight }}
                  />
                ))}
                <Tooltip
                  content={text}
                  render={
                    <button
                      className="fork-collision-ring fork-mark-button"
                      style={{ left: `${percent(at)}%`, top: ringY }}
                      aria-label={text}
                    />
                  }
                >
                  <span aria-hidden="true">✕</span>
                </Tooltip>
                {showCaption && (
                  <span
                    className={`fork-collision-caption caption ${freeRight ? "right" : "left"}`}
                    style={{ left: `${percent(at)}%`, top: ringY - 8 }}
                  >
                    {caption}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!graph.lanes.length && (
        <p className="caption muted">
          No forks in flight. Agents' branches appear here when they claim a packet.
        </p>
      )}
      {graph.lanes.length > 8 && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show ${graph.lanes.length - 8} more`}
        </Button>
      )}
      <p className="fork-legend caption muted">
        ● push · ○ review requested · ✓/✗ checks passed/failed · ◆ approved · ● promoted to{" "}
        <code>main</code>
        <br />
        Numbers and colors stay with the agent everywhere in this graph and in races.
      </p>
      <button
        className="fork-disclosure"
        aria-expanded={effectiveOpen}
        aria-controls={tableId}
        onClick={() => {
          const next = !tableOpen;
          setTableOpen(next);
          try {
            localStorage.setItem(storageKey(state.project.id), next ? "open" : "closed");
          } catch {
            /* Remembering is optional. */
          }
        }}
      >
        {effectiveOpen ? "▾" : "▸"} Same facts as a table
      </button>
      <div className={`fork-table ${effectiveOpen ? "" : "fork-table-collapsed"}`} id={tableId}>
        <table>
          <caption className="caption">
            Recorded fork events. Times are local; all loaded events are listed.
          </caption>
          <thead>
            <tr>
              {[
                "Agent",
                "Packet",
                "Claimed",
                "Last push",
                "Review",
                "Checks",
                "Approved",
                "Promoted",
              ].map((text) => (
                <th key={text} scope="col">
                  {text}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {graph.lanes.map((lane) => (
              <tr key={lane.id}>
                <th scope="row">
                  <Saddlecloth identity={lane.identity} />
                  {lane.agent}
                </th>
                <td>
                  <button onClick={() => navigate(lane)}>
                    <code>{lane.packet}</code>
                    {lane.race ? " (race)" : ""}
                  </button>
                </td>
                <td>{lane.claimedAt !== undefined ? clockTime(lane.claimedAt) : "—"}</td>
                <td>
                  {eventText(lane, ["push"])}
                  {lane.earlierPushes && (
                    <span className="caption muted">Earlier pushes not shown</span>
                  )}
                </td>
                <td>{eventText(lane, ["review"])}</td>
                <td>
                  {eventText(lane, ["failed", "passed"])}
                  {lane.review?.receipt?.status === "running" && " · Running"}
                </td>
                <td>{eventText(lane, ["approved"])}</td>
                <td>
                  {lane.promoted
                    ? `${clockTime(timestamp(lane.promoted.promotedAt)!)} · ${lane.promoted.sha.slice(0, 7)}`
                    : lane.promotedAt
                      ? clockTime(lane.promotedAt)
                      : lane.releasedAt
                        ? "Released"
                        : "Not yet"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {state.blockers
          .filter((b) => timestamp(b.at)! >= graph.start && timestamp(b.at)! <= now)
          .map((b) => (
            <p className="caption" key={b.id}>
              {clockTime(timestamp(b.at)!)} collision · {b.resolved ? "resolved" : "open"} ·{" "}
              {b.pushingAgent} → {b.claimingAgent}
            </p>
          ))}
      </div>
    </LayerCard>
  );
}
