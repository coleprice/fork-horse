import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Badge, Banner, Button, Dialog, Textarea, Tooltip } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { BlockerView, WireBlocker } from "./contracts.ts";
import { blockedLabel, blockerPacket, collisionHistory } from "./model.ts";
import { relativeTime } from "./time.ts";
import { ApiError } from "./transport.ts";

export function CollisionSentence({ blocker: b }: { blocker: BlockerView }) {
  return (
    <span className="collision-copy">
      {b.pushingAgent ?? b.agent} pushed <code title={b.sha}>{b.sha?.slice(0, 7)}</code> to{" "}
      <span className="path-summary">
        {b.paths[0] && (
          <Tooltip content={b.paths[0]} render={<code className="truncated-code" />}>
            {b.paths[0]}
          </Tooltip>
        )}
        <span className="path-more">{b.paths.length > 1 && <>+{b.paths.length - 1}</>},</span>
      </span>{" "}
      which {b.claimingAgent} has claimed for {b.packet}.
    </span>
  );
}

export function MarkResolved({
  blocker,
  owner,
  open,
  disabled,
}: {
  blocker: BlockerView;
  owner: boolean;
  open?: (blocker: BlockerView) => void;
  disabled?: boolean;
}) {
  if (!owner || !open || blocker.resolved) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      aria-label={`Mark resolved: collision on ${blocker.packet}`}
      onClick={() => open(blocker)}
    >
      Mark resolved
    </Button>
  );
}

export function CollisionBanner({
  blocker,
  owner,
  open,
  showPacket,
  disabled,
}: {
  blocker: BlockerView;
  owner: boolean;
  open?: (blocker: BlockerView) => void;
  showPacket(id: string): void;
  disabled?: boolean;
}) {
  return (
    <Banner
      className="collision-banner"
      variant="alert"
      description={
        <>
          <CollisionSentence blocker={blocker} /> {blockedLabel(blocker)} is blocked until it's
          resolved.
        </>
      }
      action={
        <div className="actions">
          <Button size="sm" onClick={() => showPacket(blockerPacket(blocker))}>
            View packet
          </Button>
          <MarkResolved blocker={blocker} owner={owner} open={open} disabled={disabled} />
        </div>
      }
    />
  );
}

export function CollisionRows({
  blockers,
  owner,
  open,
  disabled,
  highlighted,
  reviewLink,
}: {
  blockers: BlockerView[];
  owner: boolean;
  open?: (blocker: BlockerView) => void;
  disabled?: boolean;
  highlighted?: string;
  reviewLink?(blocker: BlockerView): ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted)
      root.current?.querySelector<HTMLButtonElement>(".collision-highlight button")?.focus();
  }, [highlighted]);
  const ordered = collisionHistory(blockers);
  const newestResolved = ordered.find((b) => b.resolved);
  const focused = ordered.find((b) => b.id === highlighted);
  return (
    <div ref={root} className="collision-history">
      {(focused ? [focused, ...ordered.filter((b) => b !== focused)] : ordered).map((b) => {
        const resolution = b.resolution;
        return (
          <article
            key={b.id}
            className={`collision-row ${b.id === highlighted ? "collision-highlight" : ""}`}
            data-collision={b.id}
          >
            <p className="caption">
              <CollisionSentence blocker={b} />
            </p>
            <p className="caption muted">
              <Badge
                appearance="dot"
                variant="neutral"
                className={`status-dot status-${b.resolved ? "success" : "warning"}`}
              >
                {b.resolved ? "Resolved" : "Open"}
              </Badge>
              {" · "}
              {b.resolved && resolution ? (
                <>
                  {relativeTime(resolution.at)} ·{" "}
                  {resolution.by === "owner"
                    ? owner
                      ? "by you"
                      : "by the owner"
                    : resolution.by === "promote"
                      ? "when a claim ended in a promote"
                      : "when a claim was released"}
                </>
              ) : b.at ? (
                <>since {relativeTime(b.at)}</>
              ) : (
                <>
                  pushed <code>{b.sha?.slice(0, 7)}</code>
                </>
              )}
            </p>
            {resolution?.by === "owner" && resolution.reason !== undefined && (
              <p className="caption plain-text">“{resolution.reason}”</p>
            )}
            {b.id === newestResolved?.id && reviewLink?.(b)}
            <MarkResolved blocker={b} owner={owner} open={open} disabled={disabled} />
          </article>
        );
      })}
    </div>
  );
}

/** Kumo Dialog supplies focus trapping and Escape cancellation; errors never render raw API copy. */
export function ResolveCollisionDialog({
  blocker,
  resolve,
  close,
}: {
  blocker: BlockerView;
  resolve(id: string, reason: string): Promise<WireBlocker>;
  close(resolved?: boolean): void;
}) {
  const id = useId();
  const firstReason = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    firstReason.current?.focus();
  }, []);
  useEffect(() => {
    if (missing) closeButton.current?.focus();
  }, [missing]);
  const submit = async () => {
    if (sending || missing || reason.trim().length < 1 || reason.length > 200) return;
    setSending(true);
    setError(undefined);
    try {
      await resolve(blocker.id, reason);
      close(true);
    } catch (e) {
      const notFound = e instanceof ApiError && e.status === 404;
      setMissing(notFound);
      setError(
        notFound
          ? "This collision doesn't exist anymore."
          : "Couldn't mark it resolved. Try again.",
      );
    } finally {
      setSending(false);
    }
  };
  const quickReasons = [
    "Coordinated: both changes can land.",
    `${blocker.pushingAgent ?? blocker.agent} will rebase on ${blocker.claimingAgent}'s work before promoting.`,
    `${blocker.claimingAgent} no longer needs these paths.`,
  ];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !sending) close();
      }}
    >
      <Dialog size="lg" className="p-6 return-dialog collision-dialog">
        <Dialog.Title>Mark this collision resolved?</Dialog.Title>
        <Dialog.Description render={<div />}>
          <CollisionSentence blocker={blocker} />
          <div className="collision-evidence caption">
            {blocker.paths.slice(0, 5).map((path) => (
              <p key={path}>
                <code>{path}</code>
              </p>
            ))}
            {blocker.paths.length > 5 && (
              <Tooltip content={blocker.paths.join("\n")} render={<span tabIndex={0} />}>
                +{blocker.paths.length - 5} more
              </Tooltip>
            )}
          </div>
          <p>
            Marking it resolved unblocks {blockedLabel(blocker)}: its reviews can be approved and
            promoted again. Nothing in either fork changes.
          </p>
        </Dialog.Description>
        <div role="group" aria-label="Quick reasons" className="collision-quick-reasons">
          {quickReasons.map((value, index) => (
            <Button
              key={value}
              ref={index === 0 ? firstReason : undefined}
              autoFocus={index === 0}
              variant="secondary"
              size="sm"
              disabled={sending || missing}
              onClick={() => {
                setReason(value);
                textarea.current?.focus();
              }}
            >
              {value}
            </Button>
          ))}
        </div>
        <label htmlFor={`${id}-reason`}>How was it resolved?</label>
        <Textarea
          ref={textarea}
          id={`${id}-reason`}
          required
          minLength={1}
          maxLength={200}
          aria-describedby={`${id}-counter`}
          value={reason}
          disabled={sending}
          readOnly={missing}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <p id={`${id}-counter`} className="caption muted" aria-live="polite">
          {reason.length} / 200
        </p>
        {error && (
          <p role="alert" className="receipt-error-line">
            <Warning size={20} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <div className="dialog-actions">
          <Button ref={closeButton} variant="secondary" disabled={sending} onClick={() => close()}>
            {missing ? "Close" : "Cancel"}
          </Button>
          {!missing && (
            <Button
              variant="primary"
              data-action="confirm-resolve"
              disabled={sending || reason.trim().length < 1 || reason.length > 200}
              onClick={() => void submit()}
            >
              Mark resolved
            </Button>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
