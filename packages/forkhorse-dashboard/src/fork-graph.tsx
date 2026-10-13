import { relativeTime } from "./time.ts";
import { UsageFigures } from "./usage.tsx";
import { laneUsage, totalTokens, tokenNumber, usageTooltip, usageValues } from "./usage.ts";
import { useEffect, useId, useRef, useState } from "react";
import { Button, LayerCard, Tooltip } from "@cloudflare/kumo";
import type { Brand, ProjectState } from "./contracts.ts";
import { LaneLine, LaneMarker, Saddlecloth, silkStyle } from "./lane.tsx";
import {
  clockTime,
  collisionLink,
  foldMarks,
  forkGraph,
  timestamp,
  type ForkLane,
  mainShaLabels,
  tableEvents,
  type WindowChoice,
} from "./fork-graph-model.ts";

const eventText = (events: ForkLane["events"]) =>
  events.map((e) => `${clockTime(e.at)} ${e.label}`).join(" · ");
function EventCell({
  lane,
  kinds,
  open,
  empty = "—",
}: {
  lane: ForkLane;
  kinds: string[];
  open: boolean;
  empty?: string;
}) {
  const { shown, earlier } = tableEvents(lane.events, kinds);
  return (
    <>
      <span className="fork-cell-visible" aria-hidden="true">
        {shown
          .map(
            (e) =>
              `${clockTime(e.at)}${e.kind === "passed" || e.kind === "failed" ? ` ${e.label.split(" · ")[0].replace(/^checks /, "")}` : ""}`,
          )
          .join(" · ") || empty}
      </span>
      <span className="sr-only">{eventText(shown) || empty}</span>
      {earlier.length > 0 && (
        <Tooltip
          content={eventText(earlier)}
          render={
            <span
              className="fork-earlier-events"
              tabIndex={open ? 0 : -1}
              aria-label={`${earlier.length} earlier events: ${eventText(earlier)}`}
            />
          }
        >
          {" "}
          · +{earlier.length} earlier
        </Tooltip>
      )}
    </>
  );
}
// State-owned hiding ships with the shared component in both bundles, even with stale host CSS.
const collapsedTableStyle = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;
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
  brand,
  owner,
  openReview,
  openPacket,
  openReceipt,
  now = Date.now(),
}: {
  state: ProjectState;
  brand?: Brand;
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
  const mainLabels = mainShaLabels(
    mainMarks.map((group) => ({
      id: group.event.id,
      at: group.events.at(-1)!.at,
      x: x(group.event.at),
    })),
    width,
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
                title={usageValues(laneUsage(state, lane)).map((u) => `${tokenNumber(totalTokens(u))} tokens · ${u.source} · as of ${relativeTime(u.at)}. ${brand ? usageTooltip(u, lane.agent, brand) : ""}`).join("; ") || "Not reported"}
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
                        : lane.state === "Checks running" || lane.state === "In review"
                          ? "fork-state-info"
                          : lane.state === "Checks failed"
                            ? "fork-state-danger"
                            : lane.state === "Timed out" || lane.state === "Couldn't run"
                              ? "fork-state-warning"
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
              const beforeWindow = lane.claimedAt !== undefined && lane.claimedAt < graph.start;
              const leadStart = beforeWindow ? start : Math.max(12, start - 24);
              const leadEnd = beforeWindow || start <= 12 ? Math.min(end, start + 24) : start;
              const solidStart = !known && (beforeWindow || start <= 12) ? leadEnd : start;
              const branchEnd = Math.min(end, solidStart + 20);
              const mergeStart = Math.max(branchEnd, end - 28);
              return (
                <g key={lane.id} style={silkStyle(lane.identity)}>
                  {lane.race && (
                    <path d={`M 3 ${y - 12} L 3 ${y + 12}`} className="fork-race-bracket" />
                  )}
                  {!known && (
                    <line
                      className="fork-lead-in fork-lane-line"
                      x1={leadStart}
                      x2={leadEnd}
                      y1={y}
                      y2={y}
                    />
                  )}
                  <LaneLine
                    path={
                      known
                        ? `M ${start} 30 C ${start} ${y} ${branchEnd - 12} ${y} ${branchEnd} ${y} H ${lane.promoted ? mergeStart : end}`
                        : `M ${solidStart} ${y} H ${lane.promoted ? mergeStart : end}`
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
          {/* Reserve half of a 48px HH:mm label; the grid lines keep every tick. */}
          {ticks
            .filter((at) => x(at) >= 24 && x(at) <= width - 24)
            .map((at) => (
              <span
                className="fork-tick caption muted"
                key={at}
                style={{ left: `${percent(at)}%`, top: height - 22 }}
              >
                {clockTime(at)}
              </span>
            ))}
          {mainMarks.map((group) => {
            const entry = graph.ledger.find((e) => e.review === group.events.at(-1)!.id)!;
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
                {mainLabels.has(group.event.id) && (
                  <code
                    className="caption fork-sha"
                    style={{ left: mainLabels.get(group.event.id)! - x(group.event.at) }}
                  >
                    {entry.sha.slice(0, 7)}
                  </code>
                )}
              </div>
            );
          })}
          {layout.map(({ lane, y }) => (
            <div key={lane.id}>
              {(lane.claimedAt === undefined || lane.claimedAt < graph.start) && (
                <Tooltip
                  content={
                    lane.claimedAt === undefined
                      ? "Started before the loaded history"
                      : `Started at ${clockTime(lane.claimedAt)}, before this window`
                  }
                  render={
                    <button
                      className="fork-start"
                      aria-label={
                        lane.claimedAt === undefined
                          ? "Started before the loaded history"
                          : `Started at ${clockTime(lane.claimedAt)}, before this window`
                      }
                      style={{
                        left:
                          x(lane.start ?? graph.start) <= 12 || lane.claimedAt !== undefined
                            ? x(lane.start ?? graph.start)
                            : x(lane.start ?? graph.start) - 24,
                        top: y - 8,
                      }}
                    />
                  }
                >
                  <span className="sr-only">Fork start</span>
                </Tooltip>
              )}
              {((lane.claimedAt !== undefined && lane.claimedAt < graph.start) ||
                lane.earlierPushes) && (
                <span
                  className="fork-history caption muted"
                  style={{ left: `${percent(lane.start ?? graph.start)}%`, top: y + 10 }}
                >
                  {lane.claimedAt !== undefined && lane.claimedAt < graph.start && (
                    <span className="fork-stub">since {clockTime(lane.claimedAt)}</span>
                  )}
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
      <div
        className={`fork-table ${effectiveOpen ? "" : "fork-table-collapsed"}`}
        style={effectiveOpen ? undefined : collapsedTableStyle}
        id={tableId}
      >
        <table>
          <caption className="caption">
            Recorded fork events. Times are local; each cell shows up to three events. Earlier
            events are available on focus or hover.
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
                "Tokens",
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
                  <button tabIndex={effectiveOpen ? 0 : -1} onClick={() => navigate(lane)}>
                    <code>{lane.packet}</code>
                    {lane.race ? " (race)" : ""}
                  </button>
                </td>
                <td>{lane.claimedAt !== undefined ? clockTime(lane.claimedAt) : "—"}</td>
                <td>
                  <EventCell lane={lane} kinds={["push"]} open={effectiveOpen} />
                  {lane.earlierPushes && (
                    <span className="caption muted">Earlier pushes not shown</span>
                  )}
                </td>
                <td>
                  <EventCell lane={lane} kinds={["review"]} open={effectiveOpen} />
                </td>
                <td>
                  <EventCell
                    lane={lane}
                    kinds={["failed", "passed"]}
                    open={effectiveOpen}
                    empty={lane.review?.receipt?.status === "running" ? "Running" : "—"}
                  />
                  {lane.review?.receipt?.status === "running" &&
                    lane.events.some((e) => e.kind === "failed" || e.kind === "passed") &&
                    " · Running"}
                </td>
                <td>
                  <EventCell lane={lane} kinds={["approved"]} open={effectiveOpen} />
                </td>
                <td>
                  {lane.promoted
                    ? `${clockTime(timestamp(lane.promoted.promotedAt)!)} · ${lane.promoted.sha.slice(0, 7)}`
                    : lane.promotedAt
                      ? clockTime(lane.promotedAt)
                      : lane.releasedAt
                        ? "Released"
                        : "Not yet"}
                </td>
                <td>{brand ? <UsageFigures usage={laneUsage(state, lane)} agent={lane.agent} brand={brand} compact focusable={effectiveOpen} /> : <span className="caption muted">Not reported</span>}</td>
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
