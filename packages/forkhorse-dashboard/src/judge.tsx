import { useId, useLayoutEffect, useRef, useState } from "react";
import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { Scales } from "@phosphor-icons/react";
import type { Race, Review, ProjectState } from "./contracts.ts";
import type { ViewModel } from "./model.ts";
import { ReviewActions, type ViewActions } from "./view.tsx";
import { agentIdentities, Saddlecloth } from "./lane.tsx";
import { adviceForReview, judgePromotion, pushedAfterAdvice, rankingWord } from "./judge.ts";
import { relativeTime } from "./time.ts";

export function JudgePickBadge({ race, agent }: { race: Race; agent: string }) {
  return race.judge && race.verdict?.ranking[0] === agent ?
    <Badge variant="secondary" className="judge-pick"><Scales size={12} aria-hidden="true" />Judge's pick</Badge> : null;
}
export function ReviewAdvice({ state, review }: { state?: ProjectState; review: Review }) {
  const advice = state && adviceForReview(state, review);
  return advice ? <p className="caption muted review-advice">Judge's advice: {advice.index === 0 ? "pick" :
    `${rankingWord(advice.index)} of ${advice.race.verdict!.ranking.length}`} · {relativeTime(advice.at)}</p> : null;
}
export function JudgeAdvice({ race, view, actions }: { race: Race; view: ViewModel; actions: ViewActions }) {
  return race.judge ? <AdviceContents key={JSON.stringify(race.verdict)} race={race} view={view} actions={actions} /> : null;
}
function AdviceContents({ race, view, actions }: { race: Race; view: ViewModel; actions: ViewActions }) {
  const [expanded, setExpanded] = useState(false);
  const rationaleId = useId();
  const state = { ...view.state!, recentActivity: view.activity };
  const advice = race.verdict;
  const identities = agentIdentities(state.agents);
  const pick = judgePromotion(state, race);
  const [long, setLong] = useState(!!advice && (advice.rationale.split("\n").length > 5 || advice.rationale.length > 400));
  const rationale = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = rationale.current;
    const window = element?.ownerDocument.defaultView;
    if (!element || !window) return;
    const measure = () => {
      const line = parseFloat(window.getComputedStyle(element).lineHeight);
      // DOM-only fixtures have no layout; the initial estimate remains their fallback.
      if (element.clientHeight > 0 && Number.isFinite(line)) setLong(element.scrollHeight > line * 5 + 1);
    };
    measure();
    const observer = window.ResizeObserver && new window.ResizeObserver(measure);
    observer?.observe(element.parentElement!);
    return () => observer?.disconnect();
  }, [advice?.rationale]);
  return <section className="judge-advice" aria-label="Judge's advice">
    <h4 className="label"><Scales size={16} aria-hidden="true" />Judge's advice</h4>
    {!advice ? <p className="caption muted">{race.judge} {race.status === "finished" ?
      "didn't send advice before the finish." : "hasn't sent advice yet."}</p> : <>
      <div className="judge-forecast" aria-hidden="true">{advice.ranking.map((agent, index) =>
        <span key={agent}>{index > 0 && <span className="muted">›</span>}<Saddlecloth identity={identities.get(agent)} /></span>)}</div>
      <p className="caption muted judge-from">From {race.judge} · <Tooltip content={advice.at}
        render={<time dateTime={advice.at} tabIndex={0} />} >{relativeTime(advice.at)}</Tooltip>
        {race.status === "finished" && " · before the finish"}</p>
      <span className="sr-only">Judge's ranking: {advice.ranking.join(", then ")}.</span>
      <ol className="judge-ranking" aria-label="Judge's ranking">{advice.ranking.map((agent, index) => {
        const entrant = race.entrants.find((e) => e.agent === agent);
        const later = entrant && pushedAfterAdvice(state, race, entrant);
        return <li key={agent}>
          <div><span className="caption muted">{rankingWord(index)}</span><Saddlecloth identity={identities.get(agent)} /><strong>{agent}</strong></div>
          {later && <p className="caption muted">{agent} pushed after this advice</p>}
          {entrant?.closedAt && !entrant.promotedAt && entrant.closedBy !== "race-finished" && <p className="caption muted">left the race</p>}
        </li>;
      })}</ol>
      <blockquote className="judge-rationale"><p ref={rationale} id={rationaleId} className={long && !expanded ? "judge-clamped" : undefined}>{advice.rationale}</p>
        <footer className="caption muted">{race.judge}</footer></blockquote>
      {long && <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={rationaleId}
        onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show all"}</Button>}
      <p className="caption muted">{race.status === "finished" ?
        race.winner ? race.winner === pick.pick ? `Winner: ${race.winner} (the judge's pick).` :
          `Winner: ${race.winner}. The judge picked ${pick.pick}.` : "This race finished without a recorded winner." :
        actions.owner ? "This is advice. Only the owner can promote, and the first promote wins the race." : "This is advice. The owner promotes."}</p>
      {actions.owner && race.status === "open" && <div className="judge-action">
        {pick.review && <ReviewActions review={pick.review} view={view} actions={actions}
          openReceipt={() => actions.openReceipt ? actions.openReceipt(pick.review!.id) : actions.openReview(pick.review!.id)}
          advice={{ judge: race.judge!, pick: pick.pick!, at: advice.at }} />}
        {pick.available ? <span className="caption muted">{pick.pick}</span> : <p className="caption muted">{pick.reason}</p>}
      </div>}
    </>}
  </section>;
}
