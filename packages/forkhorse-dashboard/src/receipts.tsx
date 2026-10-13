import { useEffect, useRef, useState } from "react";
import { Badge, Button, ClipboardText } from "@cloudflare/kumo";
import { relativeTime } from "./time.ts";
import type { OwnerReceipt, ReceiptStatus, ReceiptSummary, Review } from "./contracts.ts";

export function checkCount(count: number): string {
  return `${count} ${count === 1 ? "check" : "checks"}`;
}

export function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "";
  const seconds = Math.round(value / 1000);
  if (seconds >= 3600) {
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${Math.floor(seconds / 3600)} hr${minutes ? ` ${minutes} min` : ""}`;
  }
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
}
export function receiptWord(status: ReceiptStatus, recheck = false) {
  switch (status) {
    case "running":
      return { label: recheck ? "Re-checking" : "Checks running", tone: "info" };
    case "passed":
      return { label: "Passed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "timed-out":
      return { label: "Timed out", tone: "warning" };
    case "infrastructure-error":
      return { label: "Couldn't run", tone: "warning" };
  }
}
export function ReceiptBadge({
  status,
  recheck = false,
}: {
  status: ReceiptStatus;
  recheck?: boolean;
}) {
  const { label, tone } = receiptWord(status, recheck);
  return (
    <Badge appearance="dot" variant="neutral" className={`status-dot status-${tone}`}>
      {label}
    </Badge>
  );
}
export function ReceiptCell({
  receipt,
  required,
  open,
}: {
  receipt?: ReceiptSummary | null;
  required: boolean;
  open(): void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (receipt?.status !== "running" || receipt.trigger === "before-promote") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [receipt?.status, receipt?.trigger, receipt?.startedAt]);
  if (!receipt)
    return <span className="caption muted">{required ? "Not started" : "No receipt"}</span>;
  const failed = receipt.checks.filter((check) => check.outcome === "failed");
  const timedOut = receipt.checks.find((check) => check.outcome === "timed-out");
  let caption;
  switch (receipt.status) {
    case "running":
      caption =
        receipt.trigger === "before-promote" && required
          ? "Before promote"
          : now - Date.parse(receipt.startedAt) >= 3_600_000
            ? `Started ${relativeTime(receipt.startedAt, now, "hour")}`
            : `Started ${duration(Math.max(0, now - Date.parse(receipt.startedAt)))} ago`;
      break;
    case "passed":
      caption = `${checkCount(receipt.checks.length)}${duration(receipt.durationMs) ? ` · ${duration(receipt.durationMs)}` : ""}`;
      break;
    case "failed":
      caption = (
        <>
          {failed.length} of {receipt.checks.length} failed
          {failed[0] && (
            <>
              {" "}
              · <code>{failed[0].name}</code>
            </>
          )}
        </>
      );
      break;
    case "timed-out":
      caption = (
        <>
          Stopped
          {timedOut && duration(timedOut.durationMs) && <> after {duration(timedOut.durationMs)}</>}
          {timedOut && (
            <>
              {" "}
              · <code>{timedOut.name}</code>
            </>
          )}
        </>
      );
      break;
    case "infrastructure-error":
      caption = "The checks didn't start.";
      break;
  }
  return (
    <button
      type="button"
      className="receipt-cell"
      onClick={open}
      aria-label={`View receipt: ${receiptWord(receipt.status, required && receipt.trigger === "before-promote").label}`}
    >
      <ReceiptBadge
        status={receipt.status}
        recheck={required && receipt.trigger === "before-promote"}
      />
      <span className="caption muted">{caption}</span>
    </button>
  );
}

export function ReceiptDetails({
  review,
  project,
  owner,
  load,
}: {
  review: Review;
  project: string;
  owner: boolean;
  load?: (review: string) => Promise<OwnerReceipt>;
}) {
  const [logs, setLogs] = useState<string>();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const epoch = useRef(0);
  const receipt = review.receipt;
  useEffect(() => {
    epoch.current++;
    setLogs(undefined);
    setError(undefined);
    setAll(false);
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [project, review.id, review.sha, receipt?.digest, receipt?.startedAt, owner]);
  const lines = logs?.split("\n") ?? [];
  return (
    <section className="receipt-details" aria-label="Receipt details">
      <h3>Receipt</h3>
      <p>
        <code>{review.packet}</code> · <code>{review.sha.slice(0, 7)}</code>
      </p>
      {receipt ? (
        <>
          <ReceiptBadge status={receipt.status} recheck={receipt.trigger === "before-promote"} />
          {receipt.checks.map((check) => (
            <div className="receipt-check" key={check.name}>
              <p>
                <code>{check.name}</code> · {check.tier}
              </p>
              <ReceiptBadge status={check.outcome} />{" "}
              <span className="caption tabular">{duration(check.durationMs)}</span>
            </div>
          ))}
          {receipt.digest && (
            <div className="receipt-digest">
              <p className="caption muted">Digest</p>
              <ClipboardText
                text={receipt.digest.slice(0, 7)}
                textToCopy={receipt.digest}
                className="font-mono"
                size="sm"
              />
            </div>
          )}
          {owner && load && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="receipt-log-toggle"
              onClick={async () => {
                if (logs !== undefined) {
                  epoch.current++;
                  setLogs(undefined);
                  setAll(false);
                  return;
                }
                const current = ++epoch.current;
                setBusy(true);
                setError(undefined);
                setLogs(undefined);
                try {
                  const stored = await load(review.id);
                  if (current !== epoch.current) return;
                  if (stored.receipt.commit !== review.sha || stored.digest !== receipt.digest)
                    throw new Error("Receipt changed. Refresh and view logs again.");
                  setLogs(
                    stored.receipt.checks
                      .flatMap((check) => [
                        `${check.check.name} · stdout`,
                        check.logs.stdout,
                        `${check.check.name} · stderr`,
                        check.logs.stderr,
                        ...(check.logs.truncated ? ["Logs were bounded by the runner."] : []),
                      ])
                      .join("\n"),
                  );
                } catch (failure) {
                  if (current !== epoch.current) return;
                  setError(
                    failure instanceof Error ? failure.message : "Unable to load logs. Try again.",
                  );
                } finally {
                  if (current === epoch.current) setBusy(false);
                }
              }}
            >
              {logs === undefined ? "View logs" : "Hide logs"}
            </Button>
          )}
          {busy && (
            <p role="status" className="caption">
              Loading receipt logs…
            </p>
          )}
          {error && (
            <p role="alert" className="caption">
              {error}
            </p>
          )}
          {logs !== undefined && (
            <>
              <pre className="receipt-logs caption" tabIndex={0} aria-label="Receipt logs">
                {(all ? lines : lines.slice(-200)).join("\n")}
              </pre>
              {!all && lines.length > 200 && (
                <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                  Show all
                </Button>
              )}
            </>
          )}
        </>
      ) : (
        <p className="caption muted">No receipt</p>
      )}
    </section>
  );
}

/** Announce observed completion once; don't narrate every elapsed-time update. */
export function ReceiptAnnouncements({ project, reviews }: { project: string; reviews: Review[] }) {
  const previous = useRef(new Map<string, ReceiptStatus>());
  const seen = useRef(new Set<string>());
  const scope = useRef(project);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (scope.current !== project) {
      scope.current = project;
      previous.current.clear();
      seen.current.clear();
      setMessage("");
    }
    const completed: string[] = [];
    for (const review of reviews) {
      const receipt = review.receipt;
      if (!receipt) continue;
      const key = `${review.id}:${receipt.digest ?? receipt.startedAt}:${receipt.status}`;
      if (
        previous.current.get(review.id) === "running" &&
        receipt.status !== "running" &&
        !seen.current.has(key)
      ) {
        completed.push(
          `${receipt.status === "passed" ? "Checks passed" : receiptWord(receipt.status).label} for ${review.packet}`,
        );
        seen.current.add(key);
      }
      previous.current.set(review.id, receipt.status);
    }
    if (completed.length) setMessage(completed.join(". "));
  }, [project, reviews]);
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {message}
    </div>
  );
}
