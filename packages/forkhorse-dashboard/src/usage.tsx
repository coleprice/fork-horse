import { Badge, Tooltip } from "@cloudflare/kumo";
import type { Brand, TokenBudgetState, UsageSources } from "./contracts.ts";
import { relativeTime } from "./time.ts";
import { tokenNumber, totalTokens, usageTooltip, usageValues } from "./usage.ts";

export function UsageFigures({
  usage,
  agent,
  brand,
  split = false,
}: {
  usage?: UsageSources;
  agent: string;
  brand: Brand;
  split?: boolean;
}) {
  const values = usageValues(usage);
  if (!values.length) return <span className="caption text-color-kumo-subtle">Not reported</span>;
  return (
    <span className="usage-figures">
      {values.map((value) => (
        <span className="usage-source caption tabular" key={value.source}>
          <Tooltip content={usageTooltip(value, agent, brand)} render={<span />}>
            {split
              ? `${tokenNumber(value.inputTokens)} in · ${tokenNumber(value.outputTokens)} out`
              : `${tokenNumber(totalTokens(value))} tokens`}{" "}
            · {value.source}
          </Tooltip>
          <span className="caption muted">
            {split && ` by ${agent}`} · as of {relativeTime(value.at)}
          </span>
          {split && value.model && (
            <span className="caption muted"> · {value.model} (reported)</span>
          )}
        </span>
      ))}
    </span>
  );
}
export function BudgetUsage({
  usage,
  budget,
  status,
  agent,
  brand,
}: {
  usage?: UsageSources;
  budget?: number | null;
  status?: TokenBudgetState;
  agent: string;
  brand: Brand;
}) {
  // Core chooses metered first and owns the boundary state; the gauge shows that same source.
  const value = usage?.metered ?? usage?.reported;
  const label =
    status === "over" ? "Over budget" : status === "near" ? "Near budget" : "Within budget";
  return (
    <div className="budget-usage">
      <UsageFigures usage={usage} agent={agent} brand={brand} />
      {!!budget &&
        (!value || status === "unchecked" || status === undefined ? (
          <Tooltip content={value ? "Budget status unavailable." : `${agent} hasn't reported usage.`} render={<span />}>
            <Badge appearance="dot" variant="neutral" className="caption status-dot status-warning">Budget unchecked</Badge>
          </Tooltip>
        ) : (
          <div className={`token-budget token-budget-${status ?? "unchecked"}`}>
            <meter
              min={0}
              max={budget}
              value={totalTokens(value)}
              aria-label={`${label} (${value.source})`}
              aria-valuetext={`${totalTokens(value).toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} tokens (${value.source})`}
            />
            <span className="caption tabular">
              {tokenNumber(totalTokens(value))} / {tokenNumber(budget)} · {value.source}
            </span>
            <span className="caption">● {label}</span>
          </div>
        ))}
    </div>
  );
}
