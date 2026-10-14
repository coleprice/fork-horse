import { Badge, ClipboardText, Empty, Table, Tooltip } from "@cloudflare/kumo";
import brand from "../../../brand.json" with { type: "json" };
import type { ProjectState, Race } from "./contracts.ts";
import { ArchivedBadge } from "./archive.tsx";
import { agentIdentities, Saddlecloth } from "./lane.tsx";
import { duration } from "./receipts.tsx";
import { photoFinish, raceEntrants, raceSplit, raceStart, timestamp } from "./race-model.ts";

/** Only recorded starts/finishes determine order; empty open races follow started ones. */
export function orderedRaces(races: Race[]): Race[] {
  return races.toSorted((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    const at = a.status === "open" ? raceStart(a) : timestamp(a.finishedAt);
    const bt = b.status === "open" ? raceStart(b) : timestamp(b.finishedAt);
    return (bt ?? -Infinity) - (at ?? -Infinity) || a.packet.localeCompare(b.packet);
  });
}
export const openRaceCount = (races: Race[]) =>
  races.filter((race) => race.status === "open" && race.entrants.length > 0).length;

const postTime = (start: number) => new Date(start).toLocaleTimeString(undefined, {
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/** FH-081 read-only list. Advice is never a promotion or a recorded winner. */
export function Races({ state, owner, openRace }: {
  state: ProjectState;
  owner: boolean;
  openRace(id: string): void;
}) {
  const races = orderedRaces(state.races ?? []);
  const identities = agentIdentities(state.agents);
  const runner = (name: string) => <span className="race-list-runner">
    <Saddlecloth identity={identities.get(name)} />
    <span className="race-list-name">{name}</span>
  </span>;
  const command = `${brand.slug} packet create packet.yaml --config "$CLI_CONFIG"`;
  return <section id="races">
    <h2 id="races-heading">Races</h2>
    <p className="caption muted">Races are started by the owner (CLI or owner API).</p>
    {!races.length ? <div data-first-run="races">
      <Empty size="sm" title="No races yet"
        description={`A race lets up to three agents work the same packet in their own forks. The first approved promote wins.${owner ? "" : " The owner starts races."}`}
        contents={owner ? <div>
          <p className="caption muted">Add <code>mode: race</code> to the packet file.</p>
          <div className="first-run-command"><code>{command}</code>
            <ClipboardText text="" textToCopy={command} size="sm" className="first-run-copy" />
          </div>
        </div> : undefined} />
    </div> : <div className="table-scroll table-races">
      <Table aria-labelledby="races-heading">
        <Table.Header><Table.Row>
          {["Race", "Status", "Entrants", "Winner", "Judge's pick", "Started"].map((heading, index) =>
            <Table.Head key={heading} className={`race-list-column-${index}`}>{heading}</Table.Head>)}
        </Table.Row></Table.Header>
        <Table.Body>{races.map((race) => {
          const packet = state.packets.find((entry) => entry.id === race.packet);
          const title = packet?.title || race.packet;
          const start = raceStart(race);
          const finished = timestamp(race.finishedAt);
          const pick = race.judge ? race.verdict?.ranking[0] : undefined;
          const judge = !race.judge ? "—" : pick ? <>
            {runner(pick)}<span className="caption muted">Judge {race.judge}</span>
          </> : <span className="caption muted">{race.judge} · no advice yet</span>;
          const started = start === undefined ? "—" : <>
            <Tooltip content={new Date(start).toLocaleString()} render={<time dateTime={new Date(start).toISOString()} />}>
              {postTime(start)}
            </Tooltip>
            {race.status === "finished" && finished !== undefined && finished >= start &&
              <span className="caption muted">Finished {duration(finished - start)} later</span>}
          </>;
          return <Table.Row key={race.packet} data-race-packet={race.packet}>
            <Table.Cell>
              <a className="packet-link race-list-link" href={`#race/${encodeURIComponent(race.packet)}`}
                aria-label={`Open race ${title}`} onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  openRace(race.packet);
                }}>{title}</a>
              <code className="caption muted truncated-code">{race.packet}</code>
              {packet?.archived && <ArchivedBadge at={packet.archived.at} />}
              <div className="caption muted folded">
                <span>Judge's pick: {pick ?? (race.judge ? `${race.judge} · no advice yet` : "—")}</span>
                <span>Started {started}</span>
              </div>
            </Table.Cell>
            <Table.Cell>{race.status === "open" && !race.entrants.length
              ? <Badge variant="secondary">No entrants yet</Badge>
              : <Badge appearance="dot" variant="neutral" className={`status-dot status-${race.status === "finished" ? "success" : "brand"}`}>
                {race.status === "finished" ? "Finished" : "Racing"}
              </Badge>}
              {photoFinish(race) >= 2 && <span className="caption muted">photo finish</span>}
            </Table.Cell>
            <Table.Cell>{raceEntrants(race).slice(0, 3).map((entrant) =>
              <div key={entrant.repoName} className="race-list-entrant">{runner(entrant.agent)}
                {entrant.closedAt && <span className="caption muted">closed</span>}
              </div>)}{!race.entrants.length && "—"}</Table.Cell>
            <Table.Cell>{race.status !== "finished" ? "—" : race.winner ? <>
              {runner(race.winner)}
              {raceSplit(race.finishedAt, start) && <span className="caption muted">won in {raceSplit(race.finishedAt, start)}</span>}
            </> : "No winner recorded"}</Table.Cell>
            <Table.Cell className="race-list-column-4">{judge}</Table.Cell>
            <Table.Cell className="race-list-column-5 tabular">{started}</Table.Cell>
          </Table.Row>;
        })}</Table.Body>
      </Table>
    </div>}
  </section>;
}
