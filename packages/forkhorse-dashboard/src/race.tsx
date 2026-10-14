import { JudgeAdvice, JudgePickBadge } from "./judge.tsx";
import { ArchivedBadge } from "./archive.tsx";
import { RaceCompare } from "./race-usage.tsx";
import { BudgetUsage, UsageFigures } from "./usage.tsx";
import { LaneRunner, laneSilkStyle, LaneMarker, LaneConnector } from "./lane.tsx";
import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, type CSSProperties } from "react";
import type { Brand, ProjectState, Race, RaceEntrant } from "./contracts.ts";
import type { ViewModel } from "./model.ts";
import type { ViewActions } from "./view.tsx";
import { duration, receiptWord } from "./receipts.tsx";
import { oldestLoadedActivity, packetPushes } from "./fork-graph-model.ts";
import {
  entrantResult,
  entrantChecks,
  entrantReviews,
  ordinal,
  photoFinish,
  raceEntrants,
  raceMilestones,
  raceSplit,
  raceStart,
  raceTimeText,
  rejectionDelta,
  timestamp,
} from "./race-model.ts";

function Place({ entrant }: { entrant: RaceEntrant }) {
  return (
    entrant.place !== null && (
      <Badge
        variant={entrant.place === 1 ? "neutral" : "secondary"}
        appearance={entrant.place === 1 ? "dot" : undefined}
        className={entrant.place === 1 ? "race-place status-dot status-success" : "race-place"}
      >
        {ordinal(entrant.place)}
      </Badge>
    )
  );
}
function Lane({
  entrant,
  race,
  state,
  brand,
  owner,
  ledger,
}: {
  entrant: RaceEntrant;
  race: Race;
  state: ProjectState;
  brand: Brand;
  owner: boolean;
  ledger?: ProjectState["ledger"][number];
}) {
  const start = raceStart(race);
  const reviews = entrantReviews(state, race, entrant);
  const receipt = reviews.at(-1)?.receipt;
  const failed =
    receipt && ["failed", "timed-out", "infrastructure-error"].includes(receipt.status);
  const failureAt = failed ? receipt.finishedAt : null;
  const priorFailures = reviews.flatMap((review) =>
    review.receipt && review.receipt.status !== "passed" && review.receipt.status !== "running"
      ? [review.receipt]
      : [],
  );
  const tooltip = [
    ...priorFailures.flatMap((r) =>
      r.checks
        .filter((check) => check.outcome !== "passed")
        .map(
          (check) =>
            `${check.name} · ${receiptWord(check.outcome).label.toLowerCase()}${duration(check.durationMs) ? ` · ${duration(check.durationMs)}` : ""}`,
        ),
    ),
    ...(receipt?.status === "passed" && priorFailures.length && entrant.receiptPassedAt
      ? [`retried, passed at +${raceSplit(entrant.receiptPassedAt, start)}`]
      : []),
  ].join("; ");
  let previous = -1;
  return (
    <tr style={laneSilkStyle(state, entrant.agent)} data-race-agent={entrant.agent}>
      <th scope="row">
        <LaneRunner entrant={entrant} state={state} />
      </th>
      {raceMilestones.map((milestone, index) => {
        const at = entrant[milestone.key];
        const reached = timestamp(at) !== undefined;
        const gap = reached && previous >= 0 ? index - previous : 0;
        if (reached) previous = index;
        const hurdle = milestone.key === "receiptPassedAt";
        const failure = hurdle && failed;
        const promoted = milestone.key === "promotedAt" && reached;
        const label = failure ? receiptWord(receipt!.status).label : milestone.label;
        const eventAt = failure ? failureAt : at;
        const split = raceSplit(eventAt, start);
        const description =
          reached || failure
            ? `${failure ? `Checks ${label.toLowerCase()}` : label}${raceTimeText(eventAt, start) ? `, ${raceTimeText(eventAt, start)}` : ""}`
            : "Not yet";
        const marker = (
          <LaneMarker
            kind={
              failure
                ? "failed"
                : promoted
                  ? "promoted"
                  : hurdle && reached && receipt?.status === "passed"
                    ? "passed"
                    : reached
                      ? milestone.key === "claimedAt"
                        ? "claim"
                        : milestone.key === "firstPushAt"
                          ? "push"
                          : milestone.key === "reviewRequestedAt"
                            ? "review"
                            : milestone.key === "approvedAt"
                              ? "approved"
                              : "reached"
                      : "unreached"
            }
          />
        );
        return (
          <td
            key={milestone.key}
            className={`race-step ${milestone.key === "promotedAt" ? "race-finish" : ""}`}
            data-milestone={milestone.key}
            style={{ "--race-gap": gap } as CSSProperties}
          >
            <span className="race-phone-label" aria-hidden="true">
              {milestone.label}
            </span>
            <span className="sr-only">{description}</span>
            <LaneConnector reached={gap > 0} />
            <span className="race-mark-box">
            {hurdle && tooltip ? (
              <Tooltip
                content={tooltip}
                render={
                  <button
                    type="button"
                    className="race-hurdle-button"
                    aria-label={`${description}. ${tooltip}`}
                  />
                }
              >
                {marker}
              </Tooltip>
            ) : (
              marker
            )}
            </span>
            <span className="race-split caption" aria-hidden="true">
              {split && <time dateTime={eventAt!}>+{split}</time>}
              {failure && <span>{label}</span>}
            </span>
          </td>
        );
      })}
      <td className="race-tokens" data-label="Tokens">
        <span className="race-phone-label" aria-hidden="true">Tokens</span>
        <BudgetUsage usage={entrant.usage} budget={race.tokenBudget} status={entrant.budget} agent={entrant.agent} brand={brand} />
      </td>
      <td className="race-result">
        <Place entrant={entrant} />
        <JudgePickBadge race={race} agent={entrant.agent} />
        <strong>{entrantResult(entrant, owner)}</strong>
        {entrant.promotedAt && (
          <span className="caption">
            {raceSplit(entrant.promotedAt, start)}
            {ledger && (
              <>
                {" "}
                · <code title={ledger.sha}>{ledger.sha.slice(0, 7)}</code>
              </>
            )}
          </span>
        )}
        {entrant.closedAt && !entrant.promotedAt && (
          <span className="caption muted">Closed +{raceSplit(entrant.closedAt, start)}</span>
        )}
        {entrant.promotedAt && ledger?.before && (
          <span className="caption muted">
            Promoted to main{" "}
            <code>
              {ledger.before.slice(0, 7)} → {ledger.sha.slice(0, 7)}
            </code>
          </span>
        )}
      </td>
    </tr>
  );
}
export function RaceView({
  packet,
  view,
  actions,
}: {
  packet: string;
  view: ViewModel;
  actions: ViewActions;
}) {
  const state = view.state;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Focus after the triggering click completes, including tooltip focus restoration.
    const frame = requestAnimationFrame(() => title.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [packet, !!state]);
  const back = (
    <Button variant="ghost" size="sm" onClick={() => actions.openRace?.()}>
      ← Work
    </Button>
  );
  if (view.error && !view.stale)
    return (
      <section className="race-page">
        {back}
        <p role="alert">Couldn't load this race.</p>
        <Button variant="secondary" onClick={() => void actions.retry?.()}>
          Try again
        </Button>
      </section>
    );
  if (!state)
    return (
      <section className="race-page">
        {back}
        <p className="caption muted" role="status">
          Loading race…
        </p>
      </section>
    );
  const work = state.packets.find((entry) => entry.id === packet);
  const race = state.races?.find((entry) => entry.packet === packet);
  if (!race)
    return (
      <section className="race-page">
        {back}
        <p>
          {work && work.mode !== "race"
            ? "This packet isn't a race."
            : "This race doesn't exist anymore."}
        </p>
      </section>
    );
  const entrants = raceEntrants(race),
    start = raceStart(race),
    photo = photoFinish(race);
  // Match only an explicit ledger reference; never use response array position.
  const ledger =
    race.ledgerEntryId === undefined || race.ledgerEntryId === null
      ? undefined
      : state.ledger.find((entry) => entry.id === race.ledgerEntryId);
  const placed = entrants
    .filter((entry) => entry.place !== null)
    .toSorted((a, b) => a.place! - b.place!);
  const oldestLoaded = oldestLoadedActivity(view.activity);
  const pushesAvailable = oldestLoaded !== Infinity && entrants.every((entrant) => {
    const claimed = timestamp(entrant.claimedAt);
    return claimed !== undefined && oldestLoaded <= claimed;
  });
  const now = Date.now();
  return (
    <article className="race-page" aria-labelledby="race-title">
      <div className="race-navigation flex items-center gap-3">
        {back}
        {work && actions.showPacket && <Button variant="ghost" size="sm"
          onClick={() => actions.showPacket!(packet)}>Packet details</Button>}
      </div>
      <header className="race-header">
        <div>
          <h2 ref={title} tabIndex={-1} id="race-title" className="heading-1">
            {work?.title ?? packet}{" "}
            {work?.archived && <ArchivedBadge at={work.archived.at} />}
          </h2>
          <p className="race-flag">
            ⚑ {race.status === "finished" ? "Finished" : "Racing"}
            {photo >= 2 && " · photo finish"}
          </p>
          <p className="caption muted">
            <code>{packet}</code> · Race · {entrants.length}{" "}
            {entrants.length === 1 ? "entrant" : "entrants"}
            {race.judge && <> · Judge {race.judge}</>}
            {start !== undefined && (
              <>
                {" "}
                · Started{" "}
                {new Date(start).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </>
            )}
            {race.finishedAt && start !== undefined && (
              <> · Finished {duration(timestamp(race.finishedAt)! - start)} later</>
            )}
            {placed.map((entrant) => (
              <span key={entrant.repoName}>
                {" "}
                · {ordinal(entrant.place!)} {entrant.agent}
              </span>
            ))}
          </p>
        </div>
        {start !== undefined && (
          <div className="race-clock">
            <span className="caption muted">Post time</span>
            <strong>
              {new Date(start).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </strong>
            {race.finishedAt && race.winner && (
              <>
                <span className="caption muted">Won in</span>
                <strong>{raceSplit(race.finishedAt, start)}</strong>
              </>
            )}
          </div>
        )}
      </header>
      {photo >= 2 && (
        <p className="race-photo-caption">
          <Badge variant="secondary">Photo finish</Badge> {photo} entrants were approved; the first
          promote to <code>main</code> won. The others' reviews closed when the race finished.
        </p>
      )}
      <table className={`race-track ${entrants.length ? "" : "race-track-empty"}`}>
        <caption className="sr-only">Race progress for {packet}</caption>
        <thead>
          <tr>
            <th scope="col">Runner</th>
            {raceMilestones.map((step) => (
              <th
                key={step.key}
                scope="col"
                className={step.key === "promotedAt" ? "race-finish" : ""}
              >
                {step.label}
              </th>
            ))}
            <th scope="col" className="race-tokens-heading">Tokens</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {entrants.map((entrant) => (
            <Lane
              key={entrant.repoName}
              entrant={entrant}
              race={race}
              state={state}
              brand={view.brand}
              owner={actions.owner}
              ledger={ledger}
            />
          ))}
        </tbody>
      </table>
      {(!!entrants.length || !!race.judge) && <RaceCompare race={race} state={{ ...state, recentActivity: view.activity }} brand={view.brand} getReview={actions.getReview} advice={<JudgeAdvice race={race} view={view} actions={actions} />} />}
      {!entrants.length && (
        <p className="race-empty">No entrants yet. Agents join by claiming {packet}.</p>
      )}
      {!!entrants.length && (
        <section className="race-results" aria-labelledby="race-results-title">
          <h3 id="race-results-title">Results</h3>
          <table>
            <caption className="sr-only">Recorded results for {packet}</caption>
            <thead>
              <tr>
                <th scope="col">Pos</th>
                <th scope="col">Runner</th>
                <th scope="col">Time to promote</th>
                {pushesAvailable && <th scope="col">Pushes</th>}
                <th scope="col">Checks passed</th>
                <th scope="col">Tokens</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {[...placed, ...entrants.filter((entry) => entry.place === null)].map((entrant) => {
                const pushes = packetPushes(
                  view.activity, entrant.repoName, state.project.defaultBranch,
                  timestamp(entrant.claimedAt) ?? Infinity,
                  timestamp(entrant.closedAt) ?? timestamp(race.finishedAt) ?? now,
                ).length;
                return (
                  <tr key={entrant.repoName} style={laneSilkStyle(state, entrant.agent)}>
                    <td data-label="Pos">
                      {entrant.place !== null ? ordinal(entrant.place) : "—"}
                    </td>
                    <th scope="row">
                      <LaneRunner entrant={entrant} state={state} />
                    </th>
                    <td data-label="Time to promote">
                      {entrant.promotedAt ? raceSplit(entrant.promotedAt, start) : "—"}
                    </td>
                    {pushesAvailable && <td data-label="Pushes">{pushes}</td>}
                    <td data-label="Checks passed">
                      {entrantChecks(state, race, entrant)}
                    </td>
                    <td data-label="Tokens"><UsageFigures usage={entrant.usage} agent={entrant.agent} brand={view.brand} /></td>
                    <td data-label="Result">{entrantResult(entrant, actions.owner)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pushesAvailable && <p className="caption muted">Pushes from loaded activity.</p>}
        </section>
      )}
      {photo >= 2 && (
        <section className="race-photo" aria-labelledby="race-photo-title">
          <div>
            <h3 id="race-photo-title">Photo finish</h3>
            <p>
              Promote is compare-and-swap, so exactly one can move <code>main</code>.
            </p>
            <p className="caption muted">The others' reviews closed when the race finished.</p>
          </div>
          <div className="race-photo-events">
            {entrants
              .filter((entrant) => entrant.promotedAt)
              .map((entrant) => (
                <p key={entrant.repoName}>
                  <strong>{entrant.agent}</strong> promoted
                  {ledger?.before && (
                    <>
                      {" "}
                      · <code>main</code>{" "}
                      <code>
                        {ledger.before.slice(0, 7)} → {ledger.sha.slice(0, 7)}
                      </code>
                    </>
                  )}{" "}
                  · {raceSplit(entrant.promotedAt, start)}
                </p>
              ))}
            {entrants
              .filter((entrant) => entrant.promoteRejected)
              .map((entrant) => (
                <div key={entrant.repoName}>
                  <p>
                    <strong>{entrant.agent}</strong> tried to promote · expected{" "}
                    <code>{entrant.promoteRejected!.expected.slice(0, 7)}</code>, found{" "}
                    <code>{entrant.promoteRejected!.found.slice(0, 7)}</code>
                    {rejectionDelta(entrant.promoteRejected!.at, race.finishedAt) && (
                      <> · {rejectionDelta(entrant.promoteRejected!.at, race.finishedAt)}</>
                    )}
                  </p>
                  <Badge variant="neutral" appearance="dot" className="status-dot status-warning">
                    Main moved
                  </Badge>
                </div>
              ))}
          </div>
        </section>
      )}
    </article>
  );
}
