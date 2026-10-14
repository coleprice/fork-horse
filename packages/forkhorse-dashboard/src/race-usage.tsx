import { assertDetail } from "./review.tsx";
import { useEffect, useState, type ReactNode } from "react";
import type { Brand, ProjectState, Race, ReviewDetail } from "./contracts.ts";
import { entrantChecks, raceEntrants, raceStart, raceSplit } from "./race-model.ts";
import { oldestLoadedActivity, packetPushes, timestamp } from "./fork-graph-model.ts";
import { BudgetUsage } from "./usage.tsx";
import { totalTokens } from "./usage.ts";
import { agentIdentities, Saddlecloth, type AgentIdentity } from "./lane.tsx";

const elapsed = (start: number | undefined, end?: string | null) => {
  const at = Date.parse(end ?? "");
  return start !== undefined && Number.isFinite(start) && Number.isFinite(at) && at >= start
    ? at - start
    : undefined;
};
const best = (values: (number | undefined)[], index: number) =>
  values.length > 1 &&
  values.every((value) => value !== undefined) &&
  new Set(values).size > 1 &&
  values[index] === Math.min(...(values as number[]));

function CompareCell({ agent, identity, children }: { agent: string; identity?: AgentIdentity; children: ReactNode }) {
  return <td>
    <span className="compare-entrant" aria-hidden="true"><Saddlecloth identity={identity} /><span title={agent}>{agent}</span></span>
    <span className="compare-value">{children}</span>
  </td>;
}

/** Facts below the accepted FH-055 track, using its claim order and recorded race clock. */
export function RaceCompare({
  race: rawRace,
  state,
  brand,
  getReview,
  advice,
}: {
  race: Race;
  state: ProjectState;
  brand: Brand;
  advice?: ReactNode;
  getReview?: (id: string) => Promise<ReviewDetail>;
}) {
  const race = { ...rawRace, entrants: raceEntrants(rawRace) };
  const reviews = race.entrants.map((entrant) =>
    state.reviews
      .filter(
        (r) =>
          r.packet === race.packet && r.repoName === entrant.repoName && r.agent === entrant.agent,
      )
      .toSorted((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""))
      .at(0),
  );
  const keys = JSON.stringify(reviews.map((r) => (r ? [r.id, r.sha] : null)));
  const [details, setDetails] = useState<Record<string, ReviewDetail>>({});
  useEffect(() => {
    let active = true;
    setDetails({});
    if (getReview)
      void Promise.allSettled(
        reviews
          .filter((r) => !!r)
          .map(async (review) => {
            const detail = await getReview(review.id);
            assertDetail(detail, review.id);
            if (
              active &&
              detail.review.id === review.id &&
              detail.review.sha === review.sha &&
              Number.isSafeInteger(detail.changes.fileCount)
            )
              setDetails((loaded) => ({ ...loaded, [review.id]: detail }));
          }),
      );
    return () => {
      active = false;
    };
    // Exact review identities trigger reads; host action objects need not be stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, getReview]);
  const start = raceStart(race);
  const activity = state.recentActivity ?? [];
  const oldestLoaded = oldestLoadedActivity(activity);
  const pushesAvailable = oldestLoaded !== Infinity && race.entrants.every((entrant) => {
    const claimed = timestamp(entrant.claimedAt);
    return claimed !== undefined && oldestLoaded <= claimed;
  });
  const now = Date.now();
  const approved = race.entrants.map((e) => elapsed(start, e.approvedAt));
  const promoted = race.entrants.map((e) => elapsed(start, e.promotedAt));
  const changes = reviews.map((r) => (r ? details[r.id]?.changes.fileCount : undefined));
  const tokenValues = (source: "reported" | "metered") =>
    race.entrants.map((e) => (e.usage?.[source] ? totalTokens(e.usage[source]!) : undefined));
  const tokens = (index: number, compare = true) => {
    const e = race.entrants[index];
    return (
      <>
        <BudgetUsage
          usage={e.usage}
          budget={race.tokenBudget}
          status={e.budget}
          agent={e.agent}
          brand={brand}
        />
        {compare &&
          (["reported", "metered"] as const).map(
            (source) =>
              best(tokenValues(source), index) && (
                <span className="caption muted" key={source}>
                  fewest ({source})
                </span>
              ),
          )}
      </>
    );
  };
  const identities = agentIdentities(state.agents);
  return (
    <section className="race-usage" aria-labelledby="race-compare-title">
      <h3 id="race-compare-title">Compare</h3>
      {advice}
      <p className="caption muted">
        Times since the first entrant claimed. Files come from the latest review detail.
        {pushesAvailable && " Push counts cover each entrant's race interval in loaded activity."}
      </p>
      <div className="table-scroll">
        <table className="race-compare">
          <thead>
            <tr>
              <th scope="col">Fact</th>
              {race.entrants.map((e) => (
                <th scope="col" key={e.repoName}>
                  {e.agent}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Time to Approved", approved, "approvedAt"],
                ["Time to Promoted", promoted, "promotedAt"],
              ] as const
            ).map(([label, values, key]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {values.map((_value, i) => (
                  <CompareCell key={race.entrants[i].repoName} agent={race.entrants[i].agent} identity={identities.get(race.entrants[i].agent)}>
                    {raceSplit(race.entrants[i][key], start) || "Not yet"}
                    {best([...values], i) && <span className="caption muted">fastest</span>}
                  </CompareCell>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Checks passed</th>
              {race.entrants.map((e) => (
                <CompareCell key={e.repoName} agent={e.agent} identity={identities.get(e.agent)}>{entrantChecks(state, race, e)}</CompareCell>
              ))}
            </tr>
            <tr>
              <th scope="row">Files changed</th>
              {changes.map((value, i) => (
                <CompareCell key={race.entrants[i].repoName} agent={race.entrants[i].agent} identity={identities.get(race.entrants[i].agent)}>
                  {value ?? (reviews[i] ? "Unavailable" : "No review yet")}
                  {best(changes, i) && <span className="caption muted">fewest</span>}
                </CompareCell>
              ))}
            </tr>
            {pushesAvailable && <tr>
              <th scope="row">Recorded pushes</th>
              {race.entrants.map((e) => (
                <CompareCell key={e.repoName} agent={e.agent} identity={identities.get(e.agent)}>
                  {packetPushes(
                    activity, e.repoName, state.project.defaultBranch,
                    timestamp(e.claimedAt) ?? Infinity,
                    timestamp(e.closedAt) ?? timestamp(race.finishedAt) ?? now,
                  ).length}
                </CompareCell>
              ))}
            </tr>}
            <tr>
              <th scope="row">Tokens</th>
              {race.entrants.map((e, i) => (
                <CompareCell key={e.repoName} agent={e.agent} identity={identities.get(e.agent)}>{tokens(i)}</CompareCell>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
