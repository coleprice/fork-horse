import { WriteHint } from "./freshness.tsx";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { Packet, ProjectState } from "./contracts.ts";
import { canArchive } from "./model.ts";
import { relativeTime } from "./time.ts";
import { ApiError } from "./transport.ts";

export function ArchivedBadge({ at }: { at: string }) {
  return (
    <Tooltip
      content={`Archived · ${relativeTime(at)}`}
      render={<span tabIndex={0} aria-label={`Archived · ${relativeTime(at)}`} />}
    >
      <Badge variant="secondary">Archived</Badge>
    </Tooltip>
  );
}

/** One deliberate panel action. Reads after conflicts never retry the write. */
export function ArchiveControl({
  packet,
  state,
  owner,
  busy,
  disabledReason,
  archive,
  unarchive,
  missing,
}: {
  packet: Packet;
  state: ProjectState;
  owner: boolean;
  busy: boolean;
  disabledReason?: string;
  archive?: (id: string) => Promise<boolean>;
  unarchive?: (id: string) => Promise<boolean>;
  missing(message: string): void;
}) {
  const [error, setError] = useState<string>();
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && !busy) {
      button.current?.focus();
      restoreFocus.current = false;
    }
  }, [packet.archived, busy]);
  const kind = packet.archived ? "unarchive" : "archive";
  const label = packet.archived ? "Unarchive" : "Archive";
  const write = packet.archived ? unarchive : archive;
  const offered = owner && write && (packet.archived || canArchive(state, packet.id));
  return (
    <>
      {offered && (
        <WriteHint reason={disabledReason}><Button
          ref={button}
          variant="secondary"
          size="sm"
          data-action={kind}
          aria-label={`${label} ${packet.id}`}
          disabled={busy}
          onClick={async () => {
            if (busy || pending.current) return;
            pending.current = true;
            setError(undefined);
            restoreFocus.current = true;
            try {
              await write!(packet.id);
            } catch (failure) {
              if (failure instanceof ApiError && failure.status === 404) {
                missing("This packet doesn't exist anymore.");
              } else {
                setError(
                  failure instanceof ApiError && failure.status === 409 && kind === "archive"
                    ? `${packet.id} has work in flight, so it can't be archived yet.`
                    : `Couldn't ${kind} ${packet.id}. Try again.`,
                );
              }
            } finally {
              pending.current = false;
              // Also restore after an idempotent response; the replacement is already drawn.
              button.current?.focus();
            }
          }}
        >
          {label}
        </Button></WriteHint>
      )}
      {error && (
        <p className="receipt-error-line caption" role="alert">
          <Warning size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}
