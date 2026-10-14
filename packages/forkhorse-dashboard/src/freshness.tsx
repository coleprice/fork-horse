import type { ReactNode } from "react";
import { Button, Tooltip } from "@cloudflare/kumo";
import type { ViewModel } from "./model.ts";
import { relativeTime } from "./time.ts";

export function snapshotAge(view: ViewModel, now = Date.now()): string {
  const age = view.updatedAt && relativeTime(view.updatedAt, now);
  return age === "Just now" ? "just now" : age || "an unknown time";
}

export function staleReason(view: ViewModel): string | undefined {
  return view.stale ? `Refresh first. This data is from ${snapshotAge(view)}.` : undefined;
}

/** Disabled controls still have a focusable tooltip target, including in open dialogs. */
export function WriteHint({ reason, children }: { reason?: string; children: ReactNode }) {
  return reason ? (
    <Tooltip content={reason} render={<span className="write-hint" tabIndex={0} />}>
      {children}
    </Tooltip>
  ) : <>{children}</>;
}

export function FreshnessStamp({ view, retry }: { view: ViewModel; retry?: () => Promise<void> }) {
  if (!view.state || !view.updatedAt) return null;
  const time = <Tooltip content={new Date(view.updatedAt).toLocaleString()} render={<time dateTime={view.updatedAt} />}>
    {snapshotAge(view)}
  </Tooltip>;
  // A retry of a failed read stays stale, with its time visible, until it succeeds.
  return <div className="freshness-stamp caption muted" data-freshness="stamp">
    {view.stale ? <>
      <span role="status">Couldn't refresh. Showing data from {time}.</span>
      {retry && <Button variant="ghost" size="sm" disabled={view.refreshing || view.busy}
        onClick={() => void retry()}>Try again</Button>}
    </> : view.refreshing ? <Tooltip content={`Updated ${snapshotAge(view)} · ${new Date(view.updatedAt).toLocaleString()}`} render={<span />}>
      Refreshing…
    </Tooltip> : <span>Updated {time}</span>}
  </div>;
}
