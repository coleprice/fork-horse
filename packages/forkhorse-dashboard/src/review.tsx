import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Banner, Button, ClipboardText, Dialog, Tooltip, Textarea } from "@cloudflare/kumo";
import { ArrowUUpLeft, Warning } from "@phosphor-icons/react";
import type { Review, ReviewDetail, ReviewDiff } from "./contracts.ts";
import { reviewView, type ViewModel } from "./model.ts";
import { type ViewActions, ReviewActions, Paths } from "./view.tsx";
import { ApiError } from "./transport.ts";
import { checkCount, duration, ReceiptBadge } from "./receipts.tsx";
import { relativeTime } from "./time.ts";

function Dot({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return (
    <Badge appearance="dot" variant="neutral" className={`status-dot status-${tone}`}>
      {children}
    </Badge>
  );
}
export function checksWord(review: Review): string {
  switch (review.receipt?.status) {
    case "passed":
      return "Checks passed";
    case "failed":
      return "Checks failed";
    case "running":
      return "Checks running";
    case "timed-out":
      return "Timed out";
    case "infrastructure-error":
      return "Couldn't run";
    default:
      return "No receipt";
  }
}
function checkTone(review: Review) {
  switch (review.receipt?.status) {
    case "passed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "timed-out":
    case "infrastructure-error":
      return "warning";
    default:
      return "neutral";
  }
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Refuse malformed/unbounded detail instead of substituting packet or push-history evidence. */
export function assertDetail(value: ReviewDetail, id: string): void {
  const c = value?.changes;
  const r = value?.review;
  if (
    !r ||
    r.id !== id ||
    typeof r.sha !== "string" ||
    typeof r.base !== "string" ||
    !value.packet ||
    value.packet.id !== r.packet ||
    typeof value.packet.title !== "string" ||
    typeof value.packet.goal !== "string" ||
    !strings(value.packet.acceptance) ||
    !strings(value.packet.paths) ||
    !c ||
    c.head !== r.sha ||
    c.base !== r.base ||
    typeof c.truncated !== "boolean" ||
    !Array.isArray(c.files) ||
    c.files.length > 200 ||
    !Number.isSafeInteger(c.fileCount) ||
    c.fileCount < c.files.length ||
    !c.files.every(
      (f) => typeof f.path === "string" && ["added", "modified", "deleted"].includes(f.status),
    ) ||
    !Array.isArray(value.commits) ||
    value.commits.length > 50 ||
    typeof value.commitsTruncated !== "boolean" ||
    !value.commits.every(
      (commit) =>
        typeof commit.sha === "string" &&
        typeof commit.subject === "string" &&
        typeof commit.authorName === "string" &&
        (commit.packetTrailer === null || typeof commit.packetTrailer === "string") &&
        (commit.agentTrailer === null || typeof commit.agentTrailer === "string"),
    ) ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every(
      (b) =>
        typeof b.id === "string" &&
        typeof b.pushingAgent === "string" &&
        typeof b.claimingAgent === "string" &&
        strings(b.paths),
    ) ||
    (r.returned != null &&
      (typeof r.returned.reason !== "string" ||
        r.returned.reason.length < 1 ||
        r.returned.reason.length > 2000 ||
        typeof r.returned.at !== "string")) ||
    (r.approval !== null && (!r.approval || typeof r.approval.sha !== "string")) ||
    (value.promotion !== null &&
      (!value.promotion ||
        typeof value.promotion.before !== "string" ||
        typeof value.promotion.after !== "string" ||
        typeof value.promotion.recordedAt !== "string" ||
        (value.promotion.receiptDigest !== null &&
          typeof value.promotion.receiptDigest !== "string")))
  ) {
    throw new Error("Review detail unavailable. Check the host adapter.");
  }
}
function FileDiff({
  file,
  id,
  actions,
  revision,
}: {
  file: ReviewDetail["changes"]["files"][number];
  id: string;
  actions: ViewActions;
  revision: string;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<ReviewDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || diff || error) return;
    let active = true;
    if (!actions.getDiff) {
      setError("Diff unavailable. Check the host adapter.");
      return;
    }
    void actions
      .getDiff(id, file.path)
      .then((result) => {
        if (
          result.path !== file.path ||
          result.status !== file.status ||
          typeof result.binary !== "boolean" ||
          typeof result.truncated !== "boolean" ||
          typeof result.patch !== "string" ||
          new TextEncoder().encode(result.patch).length > 65536
        )
          throw new Error("Invalid diff response");
        if (active) setDiff(result);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof ApiError && e.status === 404
              ? "This file isn't part of this review's changes."
              : "Couldn't load this diff.",
          );
      });
    return () => {
      active = false;
    };
    // Identity/revision is keyed by the parent. A rerender must not duplicate a read.
  }, [open, id, file.path, revision]);
  return (
    <div className="review-file">
      <button
        type="button"
        className="review-file-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="caption file-status">
          {file.status[0].toUpperCase() + file.status.slice(1)}
        </span>
        <Tooltip content={file.path} render={<code className="review-file-path" />}>
          {file.path}
        </Tooltip>
      </button>
      {open && (
        <div className="review-diff caption" role="region" aria-label={`Diff for ${file.path}`}>
          {error ? (
            <p>{error}</p>
          ) : !diff ? (
            <p>Loading diff…</p>
          ) : diff.binary ? (
            <p>Binary file, not shown.</p>
          ) : (
            <pre>
              {diff.patch.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={`diff-line ${line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-added" : line.startsWith("-") && !line.startsWith("---") ? "diff-removed" : ""}`}
                >
                  {line.startsWith("-") && !line.startsWith("---") ? `−${line.slice(1)}` : line}
                </span>
              ))}
            </pre>
          )}
          {diff?.truncated && <p>Patch truncated at 64 KB.</p>}
        </div>
      )}
    </div>
  );
}

function ReturnAction({
  review,
  view,
  actions,
  stale,
}: {
  review: Review;
  view: ViewModel;
  actions: ViewActions;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const canReturn =
    actions.owner &&
    actions.returnReview &&
    !stale &&
    !review.returned &&
    review.returned !== undefined &&
    review.status !== "promoted";
  // Leave an in-flight conflict dialog mounted when the refreshed review became promoted.
  if (!canReturn && !open) return null;
  return (
    <>
      {canReturn && (
        <Button
          variant="secondary"
          size="sm"
          data-action="return"
          disabled={view.busy}
          onClick={() => {
            setReason("");
            setError(undefined);
            setOpen(true);
          }}
        >
          <ArrowUUpLeft size={16} weight="bold" />
          Return to agent
        </Button>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!sending) setOpen(value);
        }}
      >
        <Dialog className="p-6 return-dialog">
          <Dialog.Title>Return to agent</Dialog.Title>
          <Dialog.Description>
            {review.agent} sees your reason and can push a fix. A returned review can't be approved
            or promoted.
          </Dialog.Description>
          <label htmlFor="return-reason">What needs to change?</label>
          <Textarea
            ref={textarea}
            id="return-reason"
            required
            minLength={1}
            maxLength={2000}
            value={reason}
            aria-describedby="return-counter"
            disabled={sending}
            onChange={(e) => setReason(e.target.value)}
          />
          <p id="return-counter" className="caption muted" aria-live="polite">
            {reason.length} / 2000
          </p>
          {error && (
            <p role="alert" className="receipt-error-line">
              <Warning size={20} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
          <div className="dialog-actions">
            <Button variant="secondary" disabled={sending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-action="confirm-return"
              disabled={sending || !canReturn || reason.length < 1 || reason.length > 2000}
              onClick={async () => {
                if (sending || !actions.returnReview) return;
                setSending(true);
                setError(undefined);
                try {
                  if (await actions.returnReview(review.id, reason)) setOpen(false);
                  else setError("Review changed. Close and review again.");
                } catch (e) {
                  setError(
                    e instanceof ApiError && e.status === 409
                      ? "This review was promoted, so it can't be returned."
                      : "Couldn't return this review. Refresh and review again.",
                  );
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? "Returning…" : "Return to agent"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

export function ReviewView({
  id,
  view,
  actions,
  openReceipt,
}: {
  id: string;
  view: ViewModel;
  actions: ViewActions;
  openReceipt(id: string): void;
}) {
  const [detail, setDetail] = useState<ReviewDetail>();
  const [error, setError] = useState<"error" | "not-found" | "unavailable">();
  const [attempt, setAttempt] = useState(0);
  const [ledger, setLedger] = useState(false);
  const snapshot = view.state;
  useEffect(() => {
    let active = true;
    setError(undefined);
    if (!actions.getReview) {
      setError("unavailable");
      return;
    }
    void actions
      .getReview(id)
      .then((value) => {
        assertDetail(value, id);
        if (active) setDetail(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof ApiError && e.status === 404 ? "not-found" : "error");
      });
    return () => {
      active = false;
    };
  }, [id, snapshot, attempt]);
  const raw = detail?.review;
  const publicReview = raw && reviewView(raw, snapshot?.project.settings?.requireReceipt);
  const current = snapshot?.reviews.find((r) => r.id === id);
  const review =
    publicReview && current
      ? {
          ...publicReview,
          returned: current.returned ?? publicReview.returned,
          status:
            current.sha !== publicReview.sha || publicReview.status === "stale"
              ? ("stale" as const)
              : current.status,
          approval: current.approval === undefined ? publicReview.approval : current.approval,
        }
      : publicReview;
  const stale =
    review &&
    (review.status === "stale" ||
      snapshot?.forks.find((f) => f.repoName === review.repoName)?.head !== review.sha);
  // Re-use queue gates against the detail's exact public review; never authorize from fixtures/history.
  const detailView =
    review && snapshot
      ? {
          ...view,
          state: { ...snapshot, reviews: snapshot.reviews.map((r) => (r.id === id ? review : r)) },
        }
      : view;
  const back = (
    <Button variant="ghost" size="sm" onClick={() => actions.openReview()}>
      ← Review queue
    </Button>
  );
  if (error)
    return (
      <section className="review-detail">
        {back}
        <h2>Review</h2>
        <p>
          {error === "not-found"
            ? "This review doesn't exist anymore."
            : error === "unavailable"
              ? "Review detail unavailable. Check the host adapter."
              : "Couldn't load this review."}
        </p>
        {error === "error" && (
          <Button variant="secondary" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </Button>
        )}
      </section>
    );
  if (!detail || !review)
    return (
      <section className="review-detail">
        {back}
        <div className="review-skeleton" aria-hidden="true" />
        <p className="caption muted" role="status">
          Loading review…
        </p>
      </section>
    );
  const approval = !!review.approval;
  const receipt = review.receipt;
  const word = checksWord(review);
  const promotion = detail.promotion;
  return (
    <article className="review-detail">
      {back}
      <header className="review-header">
        <div>
          <h2>{detail.packet.title}</h2>
          <p className="caption muted">
            <code>{detail.packet.id}</code> · by {review.agent} · <code>{review.repoName}</code>
            {review.requestedAt && ` · requested ${relativeTime(review.requestedAt)}`}
          </p>
        </div>
        {snapshot && (
          <div className="actions review-actions">
            {current && !stale && !review.returned && (
              <ReviewActions
                review={review}
                view={detailView}
                actions={actions}
                openReceipt={() => openReceipt(id)}
              />
            )}
            <ReturnAction review={review} view={detailView} actions={actions} stale={!!stale} />
          </div>
        )}
      </header>
      {stale && (
        <Banner
          variant="alert"
          icon={<Warning size={20} />}
          description="The fork moved after this review was requested. The agent must request review again."
        />
      )}
      <div className="review-milestones">
        <div className="review-milestone">
          <p className="caption muted">Checks</p>
          <Dot tone={checkTone(review)}>{word}</Dot>
          {receipt ? (
            <button
              type="button"
              className="review-evidence caption"
              aria-label={`${word}. Open the receipt.`}
              onClick={() => openReceipt(id)}
            >
              {checkCount(receipt.checks.length)}
              {duration(receipt.durationMs) && ` · ${duration(receipt.durationMs)}`}
              {receipt.digest && (
                <>
                  {" "}
                  · <code>{receipt.digest.slice(0, 7)}</code>
                </>
              )}
            </button>
          ) : (
            <p className="caption muted">Receipt unavailable.</p>
          )}
          {snapshot?.project.settings?.requireReceipt === false && receipt?.status === "failed" && (
            <p className="caption muted">Advisory: this didn't block approval.</p>
          )}
        </div>
        <div className="review-milestone">
          <p className="caption muted">Approval</p>
          <Dot tone={review.returned ? "danger" : approval ? "success" : "neutral"}>
            {review.returned ? "Returned to agent" : approval ? "Approved" : "Not approved yet"}
          </Dot>
          {review.returned ? (
            <button
              type="button"
              className="review-evidence caption"
              aria-label="Returned to agent. Read the full reason."
              onClick={() => {
                document.getElementById("return-reason-full")?.scrollIntoView();
                document.getElementById("return-reason-full")?.focus();
              }}
            >
              {review.returned.reason.split(/\r?\n/)[0]}
            </button>
          ) : review.approval ? (
            <button
              type="button"
              className="review-evidence caption"
              aria-label="Approved. Inspect the approved commit."
              onClick={() => document.getElementById("approved-commit")?.focus()}
            >
              at <code>{review.approval.sha.slice(0, 7)}</code>
            </button>
          ) : (
            <p className="caption muted">No approval recorded.</p>
          )}
        </div>
        <div className="review-milestone">
          <p className="caption muted">Main</p>
          <Dot tone={promotion || review.status === "promoted" ? "success" : "neutral"}>
            {promotion || review.status === "promoted" ? "Promoted to main" : "Not promoted yet"}
          </Dot>
          {promotion ? (
            <button
              type="button"
              className="review-evidence caption"
              aria-label="Promoted to main. Inspect the ledger entry."
              onClick={() => setLedger(true)}
            >
              <code>
                {promotion.before.slice(0, 7)} → {promotion.after.slice(0, 7)}
              </code>{" "}
              · {relativeTime(promotion.recordedAt)}
              {promotion.receiptDigest && (
                <>
                  {" "}
                  · receipt <code>{promotion.receiptDigest.slice(0, 7)}</code>
                </>
              )}
            </button>
          ) : (
            <p className="caption muted">
              {review.status === "promoted"
                ? "Promotion evidence unavailable."
                : "No promotion recorded."}
            </p>
          )}
        </div>
      </div>
      {review.returned && (
        <blockquote id="return-reason-full" tabIndex={-1} className="returned-reason">
          <p className="plain-text">{review.returned.reason}</p>
          <p className="caption muted">Returned {relativeTime(review.returned.at)}</p>
        </blockquote>
      )}
      {approval && (
        <div id="approved-commit" tabIndex={-1}>
          <p className="caption muted">Approved commit</p>
          <ClipboardText text={review.approval!.sha} size="sm" />
        </div>
      )}
      {promotion && (
        <Dialog.Root open={ledger} onOpenChange={setLedger}>
          <Dialog className="p-6">
            <Dialog.Title>Promotion ledger</Dialog.Title>
            <Dialog.Description>Recorded {relativeTime(promotion.recordedAt)}</Dialog.Description>
            <p className="caption muted">Before</p>
            <ClipboardText text={promotion.before} size="sm" />
            <p className="caption muted">After</p>
            <ClipboardText text={promotion.after} size="sm" />
            {promotion.receiptDigest && (
              <>
                <p className="caption muted">Receipt</p>
                <ClipboardText text={promotion.receiptDigest} size="sm" />
              </>
            )}
            <Button variant="secondary" onClick={() => setLedger(false)}>
              Close
            </Button>
          </Dialog>
        </Dialog.Root>
      )}
      {detail.blockers.length > 0 && (
        <section>
          <h2>Blockers</h2>
          {detail.blockers.map((b) => (
            <Banner
              key={b.id}
              variant="alert"
              icon={<Warning size={20} />}
              title={`${b.packet} · ${b.pushingAgent}`}
              description={
                <>
                  Push from {b.pushingAgent} overlaps {b.claimingAgent}'s live claim.{" "}
                  <Paths paths={b.paths} />
                </>
              }
            />
          ))}
        </section>
      )}
      <section>
        <h2>Request</h2>
        <p className="caption muted">Goal</p>
        <p className="plain-text">{detail.packet.goal}</p>
        <p className="caption muted">Acceptance</p>
        <ul className="review-acceptance">
          {detail.packet.acceptance.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        <p className="caption muted">Claimed paths</p>
        <Paths paths={detail.packet.paths} />
      </section>
      <section>
        <h2>Changes</h2>
        <p className="caption muted">
          {detail.changes.fileCount} {detail.changes.fileCount === 1 ? "file" : "files"} changed
        </p>
        {detail.changes.files.map((file) => (
          <FileDiff
            key={`${detail.changes.base}:${detail.changes.head}:${file.status}:${file.path}`}
            file={file}
            revision={detail.changes.head}
            id={id}
            actions={actions}
          />
        ))}
        {detail.changes.truncated && (
          <p className="caption muted">Showing 200 of {detail.changes.fileCount} files.</p>
        )}
      </section>
      <section>
        <h2>Commits</h2>
        {detail.commits.map((commit) => (
          <div key={commit.sha} className="review-commit">
            <p>{commit.subject}</p>
            <div className="caption muted">
              <ClipboardText text={commit.sha.slice(0, 7)} textToCopy={commit.sha} size="sm" /> ·{" "}
              {commit.authorName} ·{" "}
              {commit.packetTrailer && (
                <Badge variant="secondary">Packet {commit.packetTrailer}</Badge>
              )}{" "}
              {commit.agentTrailer && (
                <Badge variant="secondary">Agent {commit.agentTrailer}</Badge>
              )}
              {!commit.packetTrailer && !commit.agentTrailer && (
                <span>No {view.brand.name} trailers</span>
              )}
            </div>
          </div>
        ))}
        {detail.commitsTruncated && <p className="caption muted">Showing the latest 50 commits.</p>}
      </section>
      <section>
        <h2>Receipt</h2>
        <Dot tone={checkTone(review)}>{word}</Dot>
        {receipt?.checks.map((check, i) => (
          <div className="receipt-check" key={i}>
            <code>{check.name}</code> · {check.tier} · <ReceiptBadge status={check.outcome} />
            {duration(check.durationMs) && ` · ${duration(check.durationMs)}`}
          </div>
        ))}
        {receipt && (
          <Button variant="ghost" size="sm" onClick={() => openReceipt(id)}>
            Open receipt
          </Button>
        )}
      </section>
    </article>
  );
}
