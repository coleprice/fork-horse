import { useEffect, useRef, useState } from "react";
import { Badge, Button, Empty, LayerCard, Table, Tooltip } from "@cloudflare/kumo";
import type { Activity, Brand, ProjectState } from "./contracts.ts";
import { agentStatusRows, type AgentStatusRow } from "./agent-status-model.ts";
import { clockTime, oldestLoadedActivity, packetPushes, timestamp } from "./fork-graph-model.ts";
import { Saddlecloth } from "./lane.tsx";
import { relativeTime } from "./time.ts";
import { agentUsageToday } from "./usage.ts";
import { UsageFigures } from "./usage.tsx";

function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function AgentStatusBadge({ row }: { row: AgentStatusRow }) {
  return row.status ? <Badge appearance="dot" variant="neutral" className={`status-dot status-${row.status.tone}`}>
    {row.status.label}
  </Badge> : <Badge variant="secondary">Idle</Badge>;
}
function LastPush({ row, now }: { row: AgentStatusRow; now: number }) {
  return row.lastPush ? <Tooltip content={new Date(row.lastPush.recordedAt).toLocaleString()}
    render={<span className="agent-last-push" />}>
    <code>{row.lastPush.after.slice(0, 7)}</code> · <time dateTime={row.lastPush.recordedAt}>{relativeTime(row.lastPush.recordedAt, now)}</time>
  </Tooltip> : <span>{row.missingPush}</span>;
}
function Fork({ value }: { value?: string }) {
  return value ? <Tooltip content={value} render={<code className="truncated-code" />}>{value}</Tooltip> : null;
}
export function AgentStatusTable({ state, activity, brand, owner, openPacket, revealRepo }: {
  state: ProjectState; activity: Activity[]; brand: Brand; owner: boolean; openPacket(id: string): void;
  revealRepo?: string;
}) {
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const rows = agentStatusRows(state, activity, now);
  const live = rows.filter((row) => row.status);
  const idle = rows.filter((row) => !row.status);
  const section = useRef<HTMLElement>(null);
  const revealedFork = state.forks.find((fork) => fork.repoName === revealRepo);
  // Needs you can target an idle fork; reveal that disclosure before moving focus.
  useEffect(() => {
    if (revealedFork && !state.claims.some((claim) => claim.active && claim.agent === revealedFork.agent))
      setExpanded(true);
  }, [revealRepo, revealedFork, state.claims]);
  useEffect(() => {
    if (!revealRepo) return;
    const row = [...(section.current?.querySelectorAll<HTMLElement>("[data-agent-repo]") ?? [])]
      .find((entry) => entry.dataset.agentRepo === revealRepo);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  }, [revealRepo, expanded]);
  const table = (items: AgentStatusRow[]) => <div className="table-scroll table-agent-status">
    <Table>
      <Table.Header><Table.Row>{["Agent", "Status", "Packet", "Last push", "Waiting on", "Tokens"].map((heading) =>
        <Table.Head key={heading} className={`column-${heading.toLowerCase().replaceAll(" ", "-")}`}>{heading}</Table.Head>)}</Table.Row></Table.Header>
      <Table.Body>{items.map((row) => <Table.Row key={row.agent.name} data-agent={row.agent.name}
        data-agent-repo={revealedFork?.agent === row.agent.name ? revealedFork.repoName : row.fork?.repoName} tabIndex={-1}>
        <Table.Cell>
          <span className="agent-status-name"><Saddlecloth identity={row.identity} />
            <Tooltip content={row.agent.name} render={<span className="truncated-name" />}>{row.agent.name}</Tooltip>
          </span>
          <div className="caption muted"><Fork value={revealedFork?.agent === row.agent.name ? revealedFork.repoName : row.fork?.repoName} /></div>
          {!row.agent.createdAt && <Badge variant="secondary">Legacy</Badge>}
        </Table.Cell>
        <Table.Cell><AgentStatusBadge row={row} />{row.status?.quietSince !== undefined &&
          <p className="caption muted">No push since {clockTime(row.status.quietSince)} ({Math.max(0, Math.floor((now - row.status.quietSince) / 60_000))} min)</p>}
        </Table.Cell>
        <Table.Cell>{row.status ? <>
          <button type="button" className="claim-link" onClick={() => openPacket(row.status!.claim.packet)}>{row.status.claim.packet}</button>
          {row.claims.length > 1 && <Tooltip content={row.claims.slice(1).map((entry) => entry.claim.packet).join(", ")}
            render={<span className="caption muted" />}>+{row.claims.length - 1} more</Tooltip>}
        </> : "—"}</Table.Cell>
        <Table.Cell><LastPush row={row} now={now} /></Table.Cell>
        <Table.Cell>{row.status ? <>
          {row.status.waiting === "owner" ? owner ? "You" : "the owner" : row.status.waiting === "checks" ? "Checks" : row.agent.name}
          {row.status.caption && (owner || row.status.waiting === "agent") && <p className="caption muted">{row.status.caption}</p>}
        </> : "—"}</Table.Cell>
        <Table.Cell className="column-tokens"><UsageFigures usage={agentUsageToday(state, row.agent.name)} agent={row.agent.name} brand={brand} /></Table.Cell>
      </Table.Row>)}</Table.Body>
    </Table>
  </div>;
  return <section id="lanes" ref={section}>
    <h2 id="agents-heading" tabIndex={-1}>Agents</h2>
    <p className="caption muted">Cumulative usage from the latest reports received today, per packet and fork. These snapshots do not measure tokens consumed today.</p>
    {live.length > 0 && table(live)}
    {idle.length > 0 && <>
      <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls="idle-agents" onClick={() => setExpanded(!expanded)}>Idle agents ({idle.length})</Button>
      {expanded && <div id="idle-agents">{table(idle)}</div>}
    </>}
    {!rows.length && <Empty size="sm" title="No enrolled agents." />}
  </section>;
}

/** Reduced FH-078 card: caller identity and public /state only, never inferred next actions. */
export function ResumeCard({ state, activity, agent }: { state: ProjectState; activity: Activity[]; agent?: string }) {
  const now = useNow();
  if (!agent) return null;
  const row = agentStatusRows(state, activity, now).find((entry) => entry.agent.name === agent);
  if (!row) return null;
  // The card names one assignment and fork; never borrow another fork's last push.
  const lastPush = row.status ? packetPushes(activity, row.status.claim.repoName, state.project.defaultBranch,
    timestamp(row.status.claim.createdAt) ?? 0, now).toSorted((a, b) =>
    (timestamp(b.recordedAt) ?? 0) - (timestamp(a.recordedAt) ?? 0) || b.sequence - a.sequence)[0] : undefined;
  const packet = state.packets.find((entry) => entry.id === row.status?.claim.packet);
  const missingPush = (timestamp(row.status?.claim.createdAt) ?? -Infinity) > oldestLoadedActivity(activity)
    ? "No push yet" as const : "Not in loaded activity" as const;
  return <LayerCard className="p-4 resume-card">
    <h3>Resume where you left off</h3>
    {row.status ? <dl>
      <dt>Packet</dt><dd><code>{row.status.claim.packet}</code>{packet && ` · ${packet.title}`}</dd>
      <dt>Fork</dt><dd><Fork value={row.status.claim.repoName} /></dd>
      <dt>Last push</dt><dd><LastPush row={{ ...row, lastPush, missingPush }} now={now} /></dd>
      <dt>Status</dt><dd><AgentStatusBadge row={row} /></dd>
    </dl> : <p>No live claim.</p>}
  </LayerCard>;
}
