import { assertDetail } from "./review.tsx";
import { useEffect, useState } from "react";
import type { Brand, ProjectState, Race, ReviewDetail } from "./contracts.ts";
import { LaneRunner } from "./lane.tsx";
import { BudgetUsage } from "./usage.tsx";
import { totalTokens } from "./usage.ts";

const elapsed = (start: number, end?: string | null) => {
  const at = Date.parse(end ?? "");
  return Number.isFinite(start) && Number.isFinite(at) && at >= start ? at - start : undefined;
};
const time = (ms?: number) =>
  ms === undefined ? "Not yet" : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
const best = (values: (number | undefined)[], index: number) =>
  values.length > 1 &&
  values.every((value) => value !== undefined) &&
  values[index] === Math.min(...(values as number[]));

/** Read-only FH-062 composition seam for the FH-055 track, without ranking or owner writes. */
export function RaceUsage({
  race,
  state,
  brand,
  getReview,
}: {
  race: Race;
  state: ProjectState;
  brand: Brand;
  getReview?: (id: string) => Promise<ReviewDetail>;
}) {
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
  const start = Math.min(...race.entrants.map((e) => Date.parse(e.claimedAt)));
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
  return (
    <section className="race-usage" aria-label={`Race ${race.packet} usage`}>
      <h2>Race · {race.packet}</h2>
      <div className="table-scroll">
        <table className="race-token-lanes">
          <thead>
            <tr>
              <th scope="col">Entrant</th>
              <th scope="col">Tokens</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {race.entrants.map((e, i) => (
              <tr key={e.repoName}>
                <th scope="row">
                  <LaneRunner entrant={e} state={state} />
                </th>
                <td>{tokens(i, false)}</td>
                <td>{e.promotedAt ? "Promoted" : e.closedAt ? "Closed" : "Racing"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Compare</h3>
      <p className="caption muted">
        Times since the first entrant claimed. Push counts cover loaded activity only. Files come
        from the latest review detail.
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
                ["Time to Approved", approved],
                ["Time to Promoted", promoted],
              ] as const
            ).map(([label, values]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {values.map((value, i) => (
                  <td key={race.entrants[i].repoName}>
                    {time(value)}
                    {best([...values], i) && <span className="caption muted">fastest</span>}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Checks passed</th>
              {reviews.map((r, i) => (
                <td key={race.entrants[i].repoName}>
                  {r?.receipt
                    ? `${r.receipt.checks.filter((c) => c.outcome === "passed").length} of ${r.receipt.checks.length}`
                    : "No receipt"}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Files changed</th>
              {changes.map((value, i) => (
                <td key={race.entrants[i].repoName}>
                  {value ?? "Unavailable"}
                  {best(changes, i) && <span className="caption muted">fewest</span>}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Recorded pushes</th>
              {race.entrants.map((e) => (
                <td key={e.repoName}>
                  {
                    (state.recentActivity ?? []).filter(
                      (a) =>
                        a.repoName === e.repoName &&
                        a.agent === e.agent &&
                        a.ref === `refs/heads/${state.project.defaultBranch}` &&
                        !/^0+$/.test(a.after) &&
                        Date.parse(a.recordedAt) >= Date.parse(e.claimedAt) &&
                        (!e.closedAt || Date.parse(a.recordedAt) <= Date.parse(e.closedAt)),
                    ).length
                  }{" "}
                  <span className="caption muted">in loaded history</span>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Tokens</th>
              {race.entrants.map((e, i) => (
                <td key={e.repoName}>{tokens(i)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
