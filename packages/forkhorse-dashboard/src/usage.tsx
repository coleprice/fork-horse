import { Badge, Tooltip } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import type { Brand, TokenBudgetState, Usage, UsageSources } from "./contracts.ts";
import { relativeTime } from "./time.ts";
import { tokenNumber, totalTokens, usageTooltip, usageValues } from "./usage.ts";

function SourceFigure({
  value, agent, brand, split = false, compact = false, focusable = true, budget, children,
}: {
  value: Usage;
  agent: string;
  brand: Brand;
  split?: boolean;
  compact?: boolean;
  focusable?: boolean;
  budget?: number | null;
  children?: ReactNode;
}) {
  const fullDetails = `${totalTokens(value).toLocaleString("en-US")} tokens: ${value.inputTokens.toLocaleString("en-US")} in · ${value.outputTokens.toLocaleString("en-US")} out · ${value.source}${value.model ? ` · ${value.model} (reported)` : ""} · as of ${relativeTime(value.at)}. ${usageTooltip(value, agent, brand)}`;
  return (
    <span className={`usage-source caption tabular${compact ? " usage-compact" : ""}`}>
      <Tooltip content={compact ? fullDetails : usageTooltip(value, agent, brand)} render={<span className={`usage-figure${split ? " usage-split" : ""}`} tabIndex={compact ? (focusable ? 0 : -1) : undefined} aria-label={compact ? fullDetails : undefined} />}>
        {compact ? `${tokenNumber(totalTokens(value))} ${value.source}` : (
          <>
            {split ? <>
              <span>{tokenNumber(value.inputTokens)} in ·</span>{" "}
              <span>{tokenNumber(value.outputTokens)} out ·</span>{" "}
              <span>{value.source} by {agent}</span>
            </> : <>
              {budget != null ? `${tokenNumber(totalTokens(value))} / ${tokenNumber(budget)} tokens` : `${tokenNumber(totalTokens(value))} tokens`}
              {` · ${value.source}`}
            </>}
          </>
        )}
      </Tooltip>
      {!compact && <>
        {children}
        <span className="usage-freshness caption muted">as of {relativeTime(value.at)}</span>
        {split && value.model && <span className="usage-model caption muted">{value.model} (reported)</span>}
      </>}
    </span>
  );
}
export function UsageFigures({
  usage, agent, brand, split = false, compact = false, focusable = true,
}: {
  usage?: UsageSources;
  agent: string;
  brand: Brand;
  split?: boolean;
  compact?: boolean;
  focusable?: boolean;
}) {
  const values = usageValues(usage);
  if (!values.length) return <span className="caption text-color-kumo-subtle usage-missing">Not reported</span>;
  return (
    <span className="usage-figures">
      {values.map((value) => <SourceFigure key={value.source} value={value} agent={agent} brand={brand} split={split} compact={compact} focusable={focusable} />)}
    </span>
  );
}
export function BudgetUsage({
  usage, budget, status, agent, brand,
}: {
  usage?: UsageSources;
  budget?: number | null;
  status?: TokenBudgetState;
  agent: string;
  brand: Brand;
}) {
  if (budget == null) return <UsageFigures usage={usage} agent={agent} brand={brand} />;
  // Core chooses metered first and owns the boundary state; never combine the sources.
  const value = usage?.metered ?? usage?.reported;
  const unchecked = !value || status === "unchecked" || status === undefined;
  const warning = (
    <Tooltip content={value ? "Budget status unavailable." : `${agent} hasn't reported usage.`} render={<span />}>
      <Badge appearance="dot" variant="neutral" className="caption status-dot status-warning">Budget unchecked</Badge>
    </Tooltip>
  );
  const label = status === "over" ? "Over budget" : status === "near" ? "Near budget" : "Within budget";
  return (
    <div className="budget-usage">
      {!value ? <><UsageFigures usage={usage} agent={agent} brand={brand} />{warning}</> :
        usageValues(usage).map((source) => (
          <SourceFigure key={source.source} value={source} budget={budget} agent={agent} brand={brand}>
            {source === value && (unchecked ? warning :
              <span className={`token-budget token-budget-${status}`}>
                <meter min={0} max={budget} value={totalTokens(value)} aria-label={`${label} (${value.source})`}
                  aria-valuetext={`${totalTokens(value).toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} tokens (${value.source})`} />
                <span className="caption token-budget-state">{status !== "within" && <span aria-hidden="true">● </span>}{label}</span>
              </span>
            )}
          </SourceFigure>
        ))}
    </div>
  );
}
