import { judgePromotion } from "./judge.ts";
import { FirstRunEmpty, overviewFirstRun } from "./empty.tsx";
import { UsageFigures } from "./usage.tsx";
import { agentUsageToday, usagePromotionCaption, usageValues } from "./usage.ts";
import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Empty,
  LayerCard,
  Select,
  Switch,
  Table,
  Tabs,
  Toasty,
  Tooltip,
  TooltipProvider,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { ArrowLeft, ArrowLineUp, Pulse, Warning, X } from "@phosphor-icons/react";
import {
  checkCount,
  duration,
  ReceiptAnnouncements,
  ReceiptBadge,
  ReceiptCell,
  ReceiptDetails,
} from "./receipts.tsx";
import {
  isArchived,
  workPackets,
  blockerGatesReview,
  promotionReceipt,
  promotionAvailable,
  recentReceipts,
  receiptGateCaption,
  reviewGate,
  reviewState,
  reviewQueue,
  type ViewModel,
} from "./model.ts";
import { ArchiveControl, ArchivedBadge } from "./archive.tsx";
import { CollisionBanner, CollisionRows, ResolveCollisionDialog } from "./collisions.tsx";
import { RaceView } from "./race.tsx";
import { ReviewView } from "./review.tsx";
import { ForkGraph } from "./fork-graph.tsx";
import { NeedsYou } from "./needs-you.tsx";
import type { OwnerNeed } from "./needs-you-model.ts";
import type { ReviewDetail, ReviewDiff, Activity, OwnerReceipt, ProjectState, Review } from "./contracts.ts";
import { relativeTime as relative } from "./time.ts";

export type Section = "overview" | "work" | "review" | "agents";
export interface ViewActions {
  resolveBlocker?(id: string, reason: string): Promise<import("./contracts.ts").WireBlocker>;
  openCollision?(blocker: import("./contracts.ts").BlockerView): void;
  showPacket?(id: string): void;
  raceId?: string;
  openRace?(id?: string): void;
  reviewId?: string;
  openReview(id?: string): void;
  openReceipt?(id: string): void;
  getReview?(id: string): Promise<ReviewDetail>;
  getDiff?(id: string, path: string): Promise<ReviewDiff>;
  returnReview?(id: string, reason: string): Promise<boolean>;
  archivePacket?(id: string): Promise<boolean>;
  unarchivePacket?(id: string): Promise<boolean>;
  section: Section;
  setSection(section: Section): void;
  owner: boolean;
  selectProject(id: string): Promise<void>;
  retry?: () => Promise<void>;
  reconnect?: () => Promise<void>;
  agent?: string;
  ask?: () => Promise<void>;
  action(kind: "approve" | "promote", review: string): Promise<boolean | void>;
  getReceipt?(review: string): Promise<OwnerReceipt>;
  setSettings?(required: boolean): Promise<void>;
}
const short = (value: string) => <code title={value}>{value.slice(0, 7)}</code>;
const empty = (title: string) => <Empty size="sm" title={title} />;
type Tone = "info" | "brand" | "success" | "warning" | "danger";
function Status({ label, tone = "info" }: { label: string; tone?: Tone }) {
  // Kumo's neutral dot text meets the host contrast requirement; the dot uses a status token.
  return (
    <Badge appearance="dot" variant="neutral" className={`status-dot status-${tone}`}>
      {label}
    </Badge>
  );
}
function Events({ value }: { value?: "pending" | "active" }) {
  return value === "active" ? (
    <Status label="Active" tone="success" />
  ) : value === "pending" ? (
    <Badge variant="secondary">Events pending</Badge>
  ) : null;
}
function TruncatedCode({ value }: { value: string }) {
  return (
    <Tooltip content={value} render={<code className="truncated-code" />}>
      {value}
    </Tooltip>
  );
}
export function Paths({ paths, event }: { paths: string[]; event?: Activity }) {
  const total = event?.changedPathCount ?? paths.length;
  if (event && /^0+$/.test(event.after))
    return (
      <span className="path-summary">
        Deleted <code>{event.ref.replace(/^refs\/heads\//, "")}</code>
      </span>
    );
  if (event && /^0+$/.test(event.before) && total > 1)
    return <span className="path-summary">First push · {total.toLocaleString()} files</span>;
  return (
    <span className="path-summary">
      {paths[0] ? <TruncatedCode value={paths[0]} /> : <span>No changed paths</span>}
      {total > 1 && <span className="path-more">+{(total - 1).toLocaleString()} more</span>}
    </span>
  );
}
export function PathDetails({
  paths,
  total = paths.length,
  partial = false,
}: {
  paths: string[];
  total?: number;
  partial?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="path-details">
      {(expanded ? paths : paths.slice(0, 20)).map((path, index) => (
        <p className="caption" key={`${index}-${path}`}>
          <code>{path}</code>
        </p>
      ))}
      {!expanded && paths.length > 20 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show all {(partial ? paths.length : total).toLocaleString()} paths
        </Button>
      )}
      {partial && (
        <p className="caption muted">
          Showing {paths.length.toLocaleString()} of {total.toLocaleString()} paths.
        </p>
      )}
    </div>
  );
}
export function packetStatus(id: string, state: ProjectState): { label: string; tone: Tone } {
  const race = state.races?.find((entry) => entry.packet === id);
  if (race?.status === "finished") return { label: "Promoted", tone: "success" };
  if (race?.status === "open" && race.entrants.length > 0) return { label: "Racing", tone: "brand" };

  if (state.blockers.some((b) => b.pushingPacket === id && !b.resolved))
    return { label: "Blocked", tone: "warning" };
  const reviews = state.reviews.filter((r) => r.packet === id);
  if (reviews.some((r) => r.status === "promoted")) return { label: "Promoted", tone: "success" };
  if (reviews.some((r) => r.status === "approved" && reviewState(r, state).kind === "current"))
    return { label: "Approved", tone: "success" };
  const outdated = reviews.map((r) => reviewState(r, state)).find((cause) => cause.banner);
  if (outdated) return { label: outdated.label, tone: "warning" };
  if (reviews.some((r) => r.status === "pending")) return { label: "In review", tone: "info" };
  if (state.claims.some((c) => c.packet === id && c.active))
    return { label: "In progress", tone: "brand" };
  return { label: "Ready", tone: "info" };
}
function DataTable({
  headings,
  children,
  kind,
}: {
  headings: string[];
  children: ReactNode;
  kind: string;
}) {
  return (
    <div className={`table-scroll table-${kind}`}>
      <Table>
        <Table.Header>
          <Table.Row>
            {headings.map((text) => (
              <Table.Head
                key={text}
                className={`column-${text.toLowerCase().replaceAll(" ", "-")}`}
              >
                {text}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>{children}</Table.Body>
      </Table>
    </div>
  );
}
function Notice({ message, sha, review, openReview }: {
  message?: string; sha?: string; review?: string; openReview?(id: string): void;
}) {
  const toasts = useKumoToastManager();
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (message && message !== previous.current)
      toasts.add({
        title: sha ? (
          <>
            Approved <code>{sha}</code>
          </>
        ) : (
          message
        ),
        variant: "success",
        ...(review && openReview ? { timeout: 10000, actions: [{ children: "Open review", onClick: () => openReview(review) }] } : {}),
      });
    previous.current = message;
  }, [message, sha, review, openReview, toasts]);
  return null;
}
export function ReviewActions({
  review,
  view,
  actions,
  openReceipt,
  advice,
}: {
  review: Review;
  view: ViewModel;
  actions: ViewActions;
  openReceipt(): void;
  advice?: { judge: string; pick: string; at: string };
}) {
  const [confirmation, setConfirmation] = useState<{
    sha: string;
    base?: string;
    digest: string | null;
    branch: string;
    adviceAt?: string;
  }>();
  const [promoting, setPromoting] = useState(false);
  const [failure, setFailure] = useState(false);
  const required = view.state!.project.settings?.requireReceipt === true;
  const matches =
    !!confirmation &&
    review.sha === confirmation.sha &&
    review.base === confirmation.base &&
    review.receiptDigest === confirmation.digest &&
    view.state!.project.defaultBranch === confirmation.branch &&
    (!advice || confirmation.adviceAt === advice.at);
  const gate = reviewGate(review, view.state!, actions.owner);
  const race = view.state!.races?.find((entry) => entry.packet === review.packet && entry.status === "open");
  const advised = race && advice ? judgePromotion({ ...view.state!, recentActivity: view.activity }, race) : undefined;
  const canPromote = promotionAvailable(review, view.state!, actions.owner) &&
    (!advice || (advised?.available && advised.review?.id === review.id && race?.verdict?.at === advice.at));
  const otherEntrants = race?.entrants.filter((entrant) => entrant.repoName !== review.repoName && !entrant.closedAt).map((entrant) => entrant.agent) ?? [];
  const rechecking =
    required && review.receipt?.status === "running" && review.receipt.trigger === "before-promote";
  const usageCaption = usagePromotionCaption(review, view.state!);
  if (!actions.owner) return usageCaption ? <p className="caption muted usage-promotion-caption">{usageCaption}</p> : null;
  return (
    <>
      {!advice && usageCaption && <p className="caption muted usage-promotion-caption">{usageCaption}</p>}
      {!advice && gate.approve && (
        <Button
          size="sm"
          variant="secondary"
          data-action="approve"
          data-review={review.id}
          disabled={view.busy}
          onClick={() => void actions.action("approve", review.id)}
        >
          Approve
        </Button>
      )}
      {canPromote && !promoting && !rechecking && (
        <Button
          size="sm"
          variant="secondary"
          data-action={advice ? "promote-judge-pick" : "promote"}
          aria-label={advice ? `Promote ${advice.pick}, the judge's pick` : undefined}
          data-review={review.id}
          disabled={view.busy}
          onClick={() => (
            setFailure(false),
            setConfirmation({
              sha: review.sha,
              base: review.base,
              digest: review.receiptDigest,
              branch: view.state!.project.defaultBranch,
              adviceAt: advice?.at,
            })
          )}
        >
          <ArrowLineUp size={16} />
          {advice ? "Promote judge's pick" : "Promote"}
        </Button>
      )}
      <Dialog.Root
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !promoting) setConfirmation(undefined);
        }}
      >
        <Dialog className="p-6 promotion-dialog">
          <Dialog.Title>Promote to {confirmation?.branch}</Dialog.Title>
          <Dialog.Description>
            {confirmation?.branch} moves{" "}
            {confirmation?.base ? <>{short(confirmation.base)} → </> : null}
            {confirmation ? short(confirmation.sha) : null}. Promote {review.packet} from{" "}
            {review.repoName}.
          </Dialog.Description>
          {confirmation?.base && (
            <div>
              <p className="caption muted">Base</p>
              <ClipboardText text={confirmation.base} size="sm" />
            </div>
          )}
          <div>
            <p className="caption muted">Head</p>
            <ClipboardText text={confirmation?.sha ?? review.sha} size="sm" />
          </div>
          {confirmation?.digest && (
            <div>
              <p className="caption muted">Receipt</p>
              <ClipboardText text={confirmation.digest} size="sm" />
            </div>
          )}
          {required && !failure && (
            <p className="caption muted">
              Checks run again on {short(confirmation?.sha ?? review.sha)} before{" "}
              {confirmation?.branch} moves.
            </p>
          )}
          {!required && review.receipt?.status === "failed" && (
            <p className="caption muted">
              The latest checks failed; receipts are advisory in this project.
            </p>
          )}
          {failure && (
            <div role="alert" className="receipt-failure">
              <p className="receipt-error-line">
                <Warning size={20} aria-hidden="true" />{" "}
                <span>Checks failed on the re-run. Nothing was promoted.</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="receipt-link"
                onClick={() => {
                  setConfirmation(undefined);
                  openReceipt();
                }}
              >
                View receipt
              </Button>
            </div>
          )}
          {!promoting && !failure && (!matches || !canPromote) && (
            <Banner
              variant="alert"
              size="sm"
              description="Review changed. Close and review again."
            />
          )}
          {advice && <p className="caption judge-promote-caption">{advice.judge} picked {advice.pick}. This is advice; promoting is your call.</p>}
          {race && <p className="caption race-promote-warning">Promoting this finishes the race.{otherEntrants.length > 0 && <> {otherEntrants.join(" and ")} will be closed and placed.</>}</p>}
          <div className="dialog-actions">
            <Button disabled={promoting} onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-action="confirm-promote"
              disabled={!matches || !canPromote || view.busy || promoting || failure}
              aria-busy={promoting}
              onClick={async () => {
                if (!matches || !canPromote || promoting) return;
                setPromoting(true);
                try {
                  if (await actions.action("promote", review.id)) setConfirmation(undefined);
                } catch {
                  // Only the transport's exact required-receipt 409 reaches this branch.
                  if (required) setFailure(true);
                } finally {
                  setPromoting(false);
                }
              }}
            >
              {promoting ? (
                required ? (
                  "Re-checking…"
                ) : (
                  "Promoting…"
                )
              ) : (
                <>Promote to {confirmation?.branch}</>
              )}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
export function DashboardView(props: { view: ViewModel; actions: ViewActions }) {
  return (
    <TooltipProvider>
      <Toasty>
        <DashboardContent {...props} />
      </Toasty>
    </TooltipProvider>
  );
}
function DashboardContent({ view, actions }: { view: ViewModel; actions: ViewActions }) {
  const [panel, setPanel] = useState(() => {
    try {
      const saved = window.sessionStorage?.getItem("dashboard-activity");
      if (saved != null) return saved === "open";
    } catch {
      /* Opaque frames may deny storage. */
    }
    return typeof window !== "undefined" && window.innerWidth >= 1280;
  });
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveAnnouncement, setArchiveAnnouncement] = useState("");
  const [packetError, setPacketError] = useState<string>();
  const collisionHeading = useRef<HTMLHeadingElement>(null);
  const collisionOrigin = useRef<HTMLElement | null>(null);
  const [highlightedCollision, setHighlightedCollision] = useState<string>();
  const [collision, setCollision] = useState<import("./contracts.ts").BlockerView>();
  useEffect(() => { setCollision(undefined); setHighlightedCollision(undefined); }, [view.project]);
  const [packetId, setPacketId] = useState<string>();
  useEffect(() => {
    setShowArchived(false);
    setArchiveAnnouncement("");
    setPacketId(undefined);
    setPacketError(undefined);
  }, [view.project]);
  const [reviewId, setReviewId] = useState<string>();
  const [receiptPanel, setReceiptPanel] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string>();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const state = view.state;
  const overviewEmpty = state ? overviewFirstRun(state) : undefined;
  const blockers = state?.blockers.filter(
    (b) => !b.resolved && !isArchived(state, b.packet) &&
      !(b.pushingPacket && isArchived(state, b.pushingPacket)),
  ) ?? [];
  const packets = state ? workPackets(state, showArchived) : [];
  const archivedCount = state?.packets.filter((p) => p.archived).length ?? 0;
  const reviews = state ? reviewQueue(state) : [];
  const reviewCount = reviews.filter(
    (r) => !r.returned && (r.status === "pending" || r.status === "approved"),
  ).length;
  const history = state ? recentReceipts(state) : [];
  const lastPromotion = state?.ledger.at(-1);
  const lastReceipt = state && lastPromotion ? promotionReceipt(state, lastPromotion) : undefined;
  const claims = state?.claims.filter((c) => c.active && !isArchived(state, c.packet)) ?? [];
  const selected = state?.packets.find((p) => p.id === packetId);
  const selectedReview = state?.reviews.find((r) => r.id === reviewId);
  function toggle(value: boolean) {
    setPanel(value);
    if (!value && narrow) window.setTimeout(() => toggleRef.current?.focus(), 0);
    try {
      window.sessionStorage?.setItem("dashboard-activity", value ? "open" : "closed");
    } catch {
      /* Keep the in-frame preference. */
    }
  }
  function showPacket(id: string, details = false) {
    setPacketError(undefined);
    const packet = state?.packets.find((entry) => entry.id === id);
    if (!details && !packet?.archived && packet?.mode === "race") {
      setPacketId(undefined);
      setReviewId(undefined);
      actions.openRace?.(id);
      return;
    }
    setReceiptPanel(false);
    if (details && actions.raceId) actions.openRace?.();
    setPacketId(id);
    setReviewId(undefined);
    toggle(true);
  }
  function openCollision(blocker: import("./contracts.ts").BlockerView) {
    collisionOrigin.current = document.activeElement === document.body ? null : document.activeElement as HTMLElement;
    setHighlightedCollision(blocker.id);
    showPacket(blocker.pushingPacket ?? blocker.packet);
    setCollision(blocker);
  }
  function closeCollision(resolved = false) {
    setCollision(undefined);
    if (resolved) setHighlightedCollision(undefined);
    window.setTimeout(() => {
      if (resolved) collisionHeading.current?.focus();
      else if (collisionOrigin.current?.isConnected) collisionOrigin.current.focus();
      else collisionHeading.current?.focus();
    }, 0);
  }
  function showReceipt(id: string) {
    setReceiptPanel(true);
    setReviewId(id);
    setPacketId(undefined);
    toggle(true);
  }
  function openNeed(target: OwnerNeed["target"]) {
    if ("review" in target) {
      if (actions.getReview) actions.openReview(target.review);
      else actions.setSection("review");
    } else if ("packet" in target) {
      actions.setSection("work");
      setHighlightedCollision(target.collision);
      showPacket(target.packet);
    } else if ("repo" in target) {
      actions.setSection("agents");
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLElement>("[data-agent-repo]")]
          .find((entry) => entry.dataset.agentRepo === target.repo);
        (row ?? document.getElementById("agents-heading"))?.focus();
        row?.scrollIntoView({ block: "nearest" });
      });
    } else {
      actions.setSection("overview");
      requestAnimationFrame(() => document.getElementById("last-promotion")?.focus());
    }
  }
  function back() {
    setReceiptPanel(false);
    setPacketId(undefined);
    setReviewId(undefined);
  }
  const ask = actions.ask && (
    <Button
      variant="secondary"
      data-action="ask"
      disabled={asking}
      onClick={async () => {
        setAsking(true);
        setAskError(undefined);
        try {
          await actions.ask!();
        } catch {
          setAskError("Unable to open the agent prompt. Try again.");
        } finally {
          setAsking(false);
        }
      }}
    >
      Ask an agent
    </Button>
  );
  const section = (id: Section, content: ReactNode) => (
    <div
      hidden={actions.section !== id}
      id={`view-${id}`}
      className="view-stack"
      role="tabpanel"
      aria-label={id}
    >
      {content}
    </div>
  );
  const panelContent = (
    <>
      <div className="section-heading panel-heading">
        {selected || selectedReview ? (
          <Button variant="ghost" size="sm" onClick={back}>
            <ArrowLeft size={16} />
            Back to activity
          </Button>
        ) : (
          <h2>Activity</h2>
        )}
        <Tooltip
          content="Close activity"
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Close activity"
              onClick={() => toggle(false)}
            />
          }
        >
          <X size={16} />
        </Tooltip>
      </div>
      {selectedReview && receiptPanel ? (
        <ReceiptDetails
          key={`${view.project}:${selectedReview.id}`}
          review={selectedReview}
          project={view.project}
          owner={actions.owner}
          load={actions.getReceipt}
        />
      ) : selected || selectedReview ? (
        <>
          <div className="section-heading archive-heading">
            <h3>
              {selected?.title ?? selectedReview?.packet}{" "}
              {selected?.archived && <ArchivedBadge at={selected.archived.at} />}
            </h3>
            {selected && state && (
              <ArchiveControl
                key={`${view.project}:${selected.id}`}
                packet={selected}
                state={state}
                owner={actions.owner}
                busy={view.busy}
                archive={actions.archivePacket}
                unarchive={actions.unarchivePacket}
                missing={(message) => {
                  setPacketId(undefined);
                  setPacketError(message);
                }}
              />
            )}
          </div>
          {selected && (
            <>
              <p className="caption muted">{selected.id}</p>
              {selected.archived && (
                <p className="caption muted">
                  Archived · {relative(selected.archived.at)} by {actions.owner ? "you" : "the owner"}
                </p>
              )}
              <p>{selected.goal}</p>
            </>
          )}
          {selectedReview && (
            <>
              <p>{selectedReview.agent}</p>
              <p className="caption">
                <code>{selectedReview.repoName}</code>
              </p>
              <ClipboardText text={selectedReview.sha} size="sm" />
              {selectedReview.receiptDigest && (
                <ClipboardText text={selectedReview.receiptDigest} size="sm" />
              )}
            </>
          )}
          <h3>Paths</h3>
          {(() => {
            const event =
              selectedReview &&
              view.activity.findLast(
                (e) => e.repoName === selectedReview.repoName && e.after === selectedReview.sha,
              );
            return (
              <>
                {event && (
                  <div className="caption">
                    <Paths paths={event.changedPaths} event={event} />
                  </div>
                )}
                <PathDetails
                  key={selectedReview?.id ?? selected!.id}
                  paths={
                    event
                      ? event.changedPaths
                      : (selected?.paths ??
                        state?.packets.find((p) => p.id === selectedReview?.packet)?.paths ??
                        [])
                  }
                  total={event ? event.changedPathCount : undefined}
                  partial={event ? event.changedPathsTruncated : false}
                />
              </>
            );
          })()}
          {selected && state && (() => {
            const collisions = state.blockers.filter((b) => b.packet === selected.id || b.pushingPacket === selected.id);
            return collisions.length > 0 && <section aria-label="Collisions">
              <h3 ref={collisionHeading} tabIndex={-1} className="collision-heading">Collisions</h3>
              <CollisionRows blockers={collisions} owner={actions.owner} highlighted={highlightedCollision}
                reviewLink={actions.getReview ? (b) => {
                  const review = state.reviews.find((r) => blockerGatesReview(b, r) &&
                    reviewState(r, state).kind === "current" && r.status !== "stale" &&
                    state.forks.some((f) => f.repoName === r.repoName && f.head === r.sha));
                  return review && <button className="claim-link caption" onClick={() => actions.openReview(review.id)}>Open review</button>;
                } : undefined}
                open={actions.resolveBlocker ? openCollision : undefined} disabled={view.busy} />
            </section>;
          })()}
          {selected && (
            <>
              <h3>Acceptance checks</h3>
              <ul>
                {selected.acceptance.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <section id="activity">
          {view.activity.toReversed().map((entry) => (
            <article key={entry.sequence} className="activity">
              <p>
                <strong>{entry.agent ?? <code>{entry.repoName}</code>}</strong> ·{" "}
                {short(entry.after)}
              </p>
              <div className="caption">
                <Paths paths={entry.changedPaths} event={entry} />
              </div>
              {entry.ref !== `refs/heads/${state?.project.defaultBranch}` && (
                <p className="caption">
                  <code>{entry.ref.replace(/^refs\/heads\//, "")}</code>
                </p>
              )}
              <time className="caption muted" dateTime={entry.recordedAt}>
                {relative(entry.recordedAt)}
              </time>
            </article>
          ))}
          {!view.activity.length && state && !view.busy && !view.error && (
            <p className="caption muted">No pushes yet.</p>
          )}
          {view.activity.length === 100 && (
            <p className="caption muted">Showing the latest 100 events.</p>
          )}
        </section>
      )}
    </>
  );
  return (
    <>
      {actions.owner && actions.resolveBlocker && collision &&
        <ResolveCollisionDialog key={`${view.project}:${collision.id}`} blocker={collision}
          resolve={actions.resolveBlocker} close={closeCollision} />}
      <Notice message={view.notice} sha={view.noticeSha} review={actions.getReview ? view.noticeReview : undefined} openReview={actions.openReview} />
      <ReceiptAnnouncements project={view.project} reviews={state?.reviews ?? []} />
      <div className={`app-shell ${panel && !actions.raceId ? "panel-open" : ""} ${actions.raceId ? "race-shell" : ""}`}>
        <main className="main-pane">
          <div className="main-container">
            <header className="page-header">
              <div>
                <h1 className="page-title">{view.project || view.brand.name}</h1>
                <p className="page-description">
                  Agents work in their own forks. You review and promote.
                </p>
              </div>
              <div className="actions">
                {actions.owner && view.projects.length > 0 && (
                  <Select
                    size="sm"
                    aria-label="Project"
                    value={view.project}
                    disabled={view.busy}
                    items={view.projects.map((p) => ({ value: p.id, label: p.label }))}
                    onValueChange={(value) => {
                      if (value) void actions.selectProject(value);
                    }}
                  />
                )}
                {ask}
                {!actions.raceId && (
                <Tooltip
                  content={panel ? "Hide activity" : "Show activity"}
                  render={
                    <Button
                      ref={toggleRef}
                      variant="ghost"
                      shape="square"
                      data-action="toggle-activity"
                      aria-label={panel ? "Hide activity" : "Show activity"}
                      aria-expanded={panel}
                      aria-controls="activity-panel"
                      onClick={() => toggle(!panel)}
                    />
                  }
                >
                  <Pulse size={16} weight="bold" />
                </Tooltip>
                )}
              </div>
            </header>
            <div className="tab-gutter">
              <Tabs
                variant="underline"
                value={actions.section}
                onValueChange={(value) => actions.setSection(value as Section)}
                tabs={[
                  { className: "text-[13px]", value: "overview", label: "Overview" },
                  {
                    className: "text-[13px]",
                    value: "work",
                    label: (
                      <span className="tab-label">
                        Work
                        {blockers.length + claims.length > 0 && (
                          <Badge variant="secondary">{blockers.length + claims.length}</Badge>
                        )}
                      </span>
                    ),
                  },
                  {
                    className: "text-[13px]",
                    value: "review",
                    label: (
                      <span className="tab-label">
                        Review
                        {reviewCount > 0 && <Badge variant="secondary">{reviewCount}</Badge>}
                      </span>
                    ),
                  },
                  { className: "text-[13px]", value: "agents", label: "Agents" },
                ]}
              />
            </div>
            <div className="content">
              {view.livePaused && (
                <Banner
                  variant="alert"
                  size="sm"
                  className="live-paused"
                  icon={<Warning size={16} />}
                  role="status"
                  description={`Live updates paused. Showing data from ${view.updatedAt ?? "the last snapshot"}.`}
                  action={
                    actions.reconnect && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void actions.reconnect!()}
                      >
                        Reconnect
                      </Button>
                    )
                  }
                />
              )}
              {!actions.owner && (
                <Banner
                  variant="secondary"
                  size="sm"
                  className="agent-notice"
                  description={`You're connected as ${actions.agent ? `agent ${actions.agent}` : "an agent"}. Promote and approve stay with the owner; your pushes need approval on your fork.`}
                />
              )}
              {view.fixture && (
                <Banner
                  variant="secondary"
                  size="sm"
                  className="fixture-banner"
                  title="FIXTURE · OFFLINE"
                  description="Local synthetic snapshots only. No account connection."
                />
              )}
              {(view.busy || askError) && (
                <div role="status" aria-live="polite">
                  {view.busy && !actions.raceId && <p>Loading the latest project snapshot…</p>}
                  {askError && <p>{askError}</p>}
                </div>
              )}
              {packetError && <Banner variant="error" role="alert" description={packetError} />}
              {view.error && !actions.raceId && (
                <Banner
                  variant="error"
                  className="text-kumo-default"
                  icon={<Warning size={20} />}
                  role="alert"
                  description={view.error}
                  action={
                    actions.retry && (
                      <Button size="sm" onClick={() => void actions.retry!()}>
                        Try again
                      </Button>
                    )
                  }
                />
              )}
              {actions.raceId ? <RaceView key={`${view.project}:${actions.raceId}`} packet={actions.raceId} view={view} actions={{ ...actions, showPacket: (id) => showPacket(id, true), openReceipt: (id) => { actions.openRace?.(); showReceipt(id); } }} /> : !state ? (
                !view.busy &&
                !view.error &&
                (!view.project && !view.projects.length
                  ? <FirstRunEmpty kind="projects" owner={actions.owner} />
                  : empty(view.project ? "No snapshot loaded." : "Select a configured project."))
              ) : (
                <>
                  {state.promotionPending && (
                    <Banner variant="error" className="text-kumo-default" icon={<Warning size={20} />}
                      title="Canonical reconciliation alert"
                      description={<>Promotion outcome pending owner inspection. {short(state.promotionPending.after)}</>} />
                  )}
                  {state.reconcilerAlerts.map((alert, index) => (
                    <Banner
                      key={index}
                      variant="error"
                      className="text-kumo-default"
                      icon={<Warning size={20} />}
                      title="Canonical reconciliation alert"
                      description={
                        <>
                          {alert.message} {short(alert.sha)}
                        </>
                      }
                    />
                  ))}
                  {section(
                    "overview",
                    <>
                      {overviewEmpty ? (
                        <section aria-label="Forks">
                          <FirstRunEmpty kind={overviewEmpty} owner={actions.owner} />
                        </section>
                      ) : <ForkGraph brand={view.brand} key={view.project} state={state} owner={actions.owner}
                        openReview={actions.openReview} openPacket={showPacket} openReceipt={showReceipt} />}
                      {actions.owner && <NeedsYou key={view.project} state={state} brand={view.brand} open={openNeed} />}
                      <LayerCard className="p-4 project-card">
                        <div className="section-heading">
                          <h2>
                            <code>{state.project.repoName}</code>
                          </h2>
                          <Events value={state.project.events} />
                        </div>
                        <p>
                          Default branch <code>{state.project.defaultBranch}</code>
                        </p>
                        {state.canonicalHead && <p>Canonical head: {short(state.canonicalHead)}</p>}
                        {state.project.remote && (
                          <ClipboardText text={state.project.remote} size="sm" />
                        )}
                        <p className="muted" id="last-promotion" tabIndex={-1}>
                          {state.ledger.length ? (
                            <>
                              Last promotion:{" "}
                              <code className="last-promotion-sha" title={lastPromotion!.sha}>
                                {lastPromotion!.sha.slice(0, 7)}
                              </code>{" "}
                              · {relative(lastPromotion!.promotedAt)}
                              {lastReceipt?.receipt && (
                                <>
                                  {" · "}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="promotion-receipt"
                                    aria-label={`View receipt for ${lastReceipt.packet}`}
                                    onClick={() => showReceipt(lastReceipt.id)}
                                  >
                                    <ReceiptBadge status={lastReceipt.receipt.status} />
                                  </Button>
                                </>
                              )}
                            </>
                          ) : (
                            "No promotions yet"
                          )}
                        </p>
                        <h3>Settings</h3>
                        {state.project.settings ? (
                          actions.owner && actions.setSettings ? (
                            <>
                              <Switch
                                label="Require passing receipts"
                                checked={state.project.settings.requireReceipt}
                                disabled={view.busy}
                                onCheckedChange={(checked) => void actions.setSettings!(checked)}
                              />
                              <p className="caption muted">Approve waits for a passing receipt.</p>
                            </>
                          ) : (
                            <p>
                              Require passing receipts:{" "}
                              {state.project.settings.requireReceipt ? "On" : "Off"}
                            </p>
                          )
                        ) : (
                          <p className="caption muted">Receipt settings unavailable.</p>
                        )}
                      </LayerCard>
                      <section className="metrics" aria-label="Project summary">
                        {[
                          ["Open packets", workPackets(state).length],
                          ["Active claims", claims.length],
                          ["In review", reviewCount],
                          ["Blockers", blockers.length],
                        ].map(([label, count]) => (
                          <LayerCard key={label} className="p-4">
                            <span className="caption">{label}</span>
                            <h3 className="metric-value">
                              {count}
                              {label === "Blockers" && blockers.length > 0 && (
                                <span className="warning-dot" aria-label="Open blockers" />
                              )}
                            </h3>
                            {label === "In review" &&
                              reviews.some((r) => r.receipt?.status === "running") && (
                                <p className="caption muted">
                                  {reviews.filter((r) => r.receipt?.status === "running").length}{" "}
                                  checking
                                </p>
                              )}
                          </LayerCard>
                        ))}
                      </section>
                    </>,
                  )}
                  {section(
                    "work",
                    <>
                      {!!blockers.length && (
                        <section id="blockers" className="blockers">
                          {blockers.map((b) => (
                            <CollisionBanner key={b.id} blocker={b} owner={actions.owner}
                              open={actions.resolveBlocker ? openCollision : undefined}
                              showPacket={showPacket} disabled={view.busy} />
                          ))}
                        </section>
                      )}
                      <section id="packets">
                        <h2>Packets and claims</h2>
                        {packets.length ? (
                          <DataTable
                            kind="work"
                            headings={["Packet", "State", "Claimed by", "Fork", "Paths", "Claimed"]}
                          >
                            {packets.map((p) => {
                              const live = claims.filter((c) => c.packet === p.id);
                              const race = state.races?.find((entry) => entry.packet === p.id);
                              return (
                                <Table.Row
                                  key={p.id}
                                  data-packet-id={p.id}
                                  className={selected?.id === p.id ? "selected-row" : ""}
                                  onClick={(event) => {
                                    if (!(event.target as HTMLElement).closest("button, a")) showPacket(p.id);
                                  }}
                                >
                                  <Table.Cell>
                                    <span className="packet-label">
                                    <button
                                      className="packet-link"
                                      title={p.title}
                                      onClick={() => showPacket(p.id)}
                                    >
                                      {p.title}
                                    </button>{p.mode === "race" && <Badge variant="secondary" className="packet-race-badge">Race</Badge>}
                                    </span>
                                    <div className="caption muted">{p.id}</div>
                                  </Table.Cell>
                                  <Table.Cell>
                                    {p.archived ? <ArchivedBadge at={p.archived.at} /> : <Status {...packetStatus(p.id, state)} />}
                                    {!p.archived && race?.status === "finished" && race.winner && <div className="caption muted">Won by {race.winner}</div>}
                                    <div className="caption muted folded">
                                      {live
                                        .filter((c) => c.createdAt)
                                        .map((c) => (
                                          <span key={c.agent}>
                                            Claimed {relative(c.createdAt!)}
                                          </span>
                                        ))}
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Tooltip
                                      content={p.mode === "race" ? race?.entrants.map((entrant) => entrant.agent).join(", ") || "No entrants yet" : live.map((c) => c.agent).join(", ") || "Unclaimed"}
                                      render={<span className="truncated-name" />}
                                    >
                                      {p.mode === "race" ? (race?.entrants.length ? `${race.entrants.length} ${race.entrants.length === 1 ? "entrant" : "entrants"}` : "No entrants yet") : live.map((c) => c.agent).join(", ") || "Unclaimed"}
                                    </Tooltip>
                                    <div className="caption muted folded">
                                      {live.map((c) => (
                                        <TruncatedCode key={c.repoName} value={c.repoName} />
                                      ))}
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell className="column-fork">
                                    {live.map((c) => (
                                      <TruncatedCode key={c.repoName} value={c.repoName} />
                                    ))}
                                  </Table.Cell>
                                  <Table.Cell className="work-paths">
                                    <Paths paths={p.paths} />
                                  </Table.Cell>
                                  <Table.Cell className="column-claimed">
                                    {live
                                      .filter((c) => c.createdAt)
                                      .map((c) => (
                                        <span className="caption muted" key={c.agent}>
                                          {relative(c.createdAt!)}
                                        </span>
                                      ))}
                                  </Table.Cell>
                                </Table.Row>
                              );
                            })}
                          </DataTable>
                        ) : (
                          archivedCount ? empty("No active packets.")
                            : <FirstRunEmpty kind="packets" owner={actions.owner} />
                        )}
                        {archivedCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            data-action="toggle-archived"
                            aria-pressed={showArchived}
                            onClick={() => {
                              setShowArchived(!showArchived);
                              setArchiveAnnouncement(showArchived
                                ? "Archived packets hidden" : `${archivedCount} archived packets shown`);
                            }}
                          >
                            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                          </Button>
                        )}
                        <span className="sr-only" role="status" aria-live="polite">
                          {archiveAnnouncement}
                        </span>
                      </section>
                    </>,
                  )}
                  {section(
                    "review",
                    actions.reviewId && actions.getReview ? <ReviewView key={`${view.project}:${actions.reviewId}`} id={actions.reviewId} view={view} actions={{ ...actions, openCollision: actions.resolveBlocker ? openCollision : undefined, showPacket }} openReceipt={showReceipt} /> : <>
                      <section id="reviews">
                        <h2>Review queue</h2>
                        {reviews.length ? (
                          <DataTable
                            kind="review"
                            headings={[
                              "Packet",
                              "Agent",
                              "Fork head",
                              "State",
                              "Receipts",
                              ...(reviews.some((queued) => usageValues(queued.usageAtReview).length) ? ["Tokens"] : []),
                              "Requested",
                              ...(actions.owner ? ["Actions"] : []),
                            ]}
                          >
                            {reviews.map((r) => {
                              const gate = reviewGate(r, state, actions.owner);
                              const receiptCaption = receiptGateCaption(r, state.project.settings?.requireReceipt === true);
                              // Usage refusals replace Promote in Actions, never repeat them in State.
                              const hasStateCaption = receiptCaption || (!gate.approve && !gate.promote && gate.reason);
                              const stateCaption = hasStateCaption
                                ? (gate.reason === usagePromotionCaption(r, state) ? receiptCaption : gate.reason || receiptCaption)
                                : "";
                              const cause = reviewState(r, state);
                              const stale = !!cause.banner;
                              return (
                                <Table.Row key={r.id} className="review-card" onClick={actions.getReview ? (event) => {
                                  if (!(event.target as HTMLElement).closest("button, a")) actions.openReview(r.id);
                                } : undefined}>
                                  <Table.Cell>
                                    <span className="packet-label">
                                    {actions.getReview ? <button
                                      className="claim-link"
                                      onClick={() => {
                                        actions.openReview(r.id);
                                      }}
                                    >
                                      {r.packet}
                                    </button> : <span>{r.packet}</span>}{state.packets.find((p) => p.id === r.packet)?.mode === "race" && <Badge variant="secondary" className="packet-race-badge">Race</Badge>}
                                    </span>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Tooltip
                                      content={r.agent}
                                      render={<span className="truncated-name" />}
                                    >
                                      {r.agent}
                                    </Tooltip>
                                    <div className="caption muted">
                                      <TruncatedCode value={r.repoName} />
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell>{short(r.sha)}</Table.Cell>
                                  <Table.Cell>
                                    <Status
                                      label={cause.label}
                                      tone={
                                        cause.kind === "returned" ? "danger" : stale ? "warning"
                                          : r.status === "approved" ? "success" : "info"
                                      }
                                    />
                                    <div className="caption muted folded">
                                      <ReceiptCell
                                        receipt={r.receipt}
                                        required={state.project.settings?.requireReceipt === true}
                                        open={() => showReceipt(r.id)}
                                      />
                                      {r.requestedAt && (
                                        <div>Requested {relative(r.requestedAt)}</div>
                                      )}
                                    </div>
                                    {r.returned && <p className="caption muted returned-preview">{r.returned.reason.split(/\r?\n/)[0]}</p>}
                                    {stale && (
                                      <div className="caption muted state-reason">
                                        {cause.caption}
                                      </div>
                                    )}
                                    {!stale && !r.returned &&
                                      stateCaption && (
                                        <div className="caption muted state-reason">
                                          {stateCaption}
                                          {actions.owner &&
                                            r.receipt?.status === "infrastructure-error" && (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                className="receipt-link"
                                                onClick={() => showReceipt(r.id)}
                                              >
                                                View receipt
                                              </Button>
                                            )}
                                        </div>
                                      )}
                                  </Table.Cell>
                                  <Table.Cell className="column-receipts">
                                    <ReceiptCell
                                      receipt={r.receipt}
                                      required={state.project.settings?.requireReceipt === true}
                                      open={() => showReceipt(r.id)}
                                    />
                                  </Table.Cell>
                                  {reviews.some((queued) => usageValues(queued.usageAtReview).length) && <Table.Cell className="column-tokens"><UsageFigures usage={r.usageAtReview} agent={r.agent} brand={view.brand} compact /></Table.Cell>}
                                  <Table.Cell className="column-requested">
                                    {r.requestedAt && (
                                      <span className="caption muted">
                                        {relative(r.requestedAt)}
                                      </span>
                                    )}
                                  </Table.Cell>
                                  {actions.owner && (
                                    <Table.Cell>
                                      <ReviewActions
                                        review={r}
                                        view={view}
                                        actions={actions}
                                        openReceipt={() => showReceipt(r.id)}
                                      />
                                    </Table.Cell>
                                  )}
                                </Table.Row>
                              );
                            })}
                          </DataTable>
                        ) : (
                          state.reviews.length ? empty("No reviews waiting for owner action.")
                            : <FirstRunEmpty kind="reviews" owner={actions.owner}
                              goToWork={() => actions.setSection("work")} />
                        )}
                      </section>
                      <section id="recent-receipts" aria-labelledby="recent-receipts-heading">
                        <h2 id="recent-receipts-heading">Recent receipts</h2>
                        {history.length ? (
                          <DataTable
                            kind="receipt-history"
                            headings={[
                              "Packet",
                              "Head",
                              "Outcome",
                              "Checks",
                              "Trigger",
                              "Finished",
                            ]}
                          >
                            {history.map((review) => (
                              <Table.Row
                                key={review.id}
                                className="receipt-history-row"
                                onClick={() => showReceipt(review.id)}
                              >
                                <Table.Cell>
                                  <button
                                    type="button"
                                    className="claim-link receipt-history-link"
                                    aria-label={`View receipt for ${review.packet} at ${review.sha.slice(0, 7)}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      showReceipt(review.id);
                                    }}
                                  >
                                    {review.packet}
                                  </button>
                                </Table.Cell>
                                <Table.Cell>{short(review.sha)}</Table.Cell>
                                <Table.Cell>
                                  <ReceiptBadge
                                    status={review.receipt.status}
                                    recheck={
                                      state.project.settings?.requireReceipt === true &&
                                      review.receipt.trigger === "before-promote"
                                    }
                                  />
                                </Table.Cell>
                                <Table.Cell className="caption muted tabular">
                                  {checkCount(review.receipt.checks.length)}
                                  {duration(review.receipt.durationMs) &&
                                    ` · ${duration(review.receipt.durationMs)}`}
                                </Table.Cell>
                                <Table.Cell className="caption muted">
                                  {review.receipt.trigger === "before-promote"
                                    ? "Before promote"
                                    : "On review"}
                                </Table.Cell>
                                <Table.Cell className="caption muted">
                                  {review.receipt.finishedAt && (
                                    <time dateTime={review.receipt.finishedAt}>
                                      {relative(review.receipt.finishedAt)}
                                    </time>
                                  )}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </DataTable>
                        ) : (
                          <p className="muted">No receipts yet.</p>
                        )}
                      </section>
                    </>,
                  )}
                  {section(
                    "agents",
                    <section id="lanes">
                      <h2 id="agents-heading" tabIndex={-1}>Agents</h2>
                      {state.agents.length > 0 && <p className="caption muted">Cumulative usage from the latest reports received today, per packet and fork. These snapshots do not measure tokens consumed today.</p>}
                      {state.agents.length ? (
                        <DataTable
                          kind="agents"
                          headings={["Agent", "Fork", "Last push", "Claim", "Events", "Tokens"]}
                        >
                          {state.agents.flatMap((agent) => {
                            const forks = state.forks.filter((f) => f.agent === agent.name);
                            return (forks.length ? forks : [undefined]).map((fork) => {
                              const recent = view.activity.findLast((e) =>
                                fork ? e.repoName === fork.repoName : e.agent === agent.name,
                              );
                              return (
                                <Table.Row key={`${agent.name}-${fork?.repoName ?? "none"}`} data-agent-repo={fork?.repoName} tabIndex={-1}>
                                  <Table.Cell>
                                    <Tooltip
                                      content={agent.name}
                                      render={<span className="truncated-name" />}
                                    >
                                      {agent.name}
                                    </Tooltip>
                                    <div className="caption muted folded">
                                      {fork && <TruncatedCode value={fork.repoName} />}
                                      <UsageFigures usage={agentUsageToday(state, agent.name)} agent={agent.name} brand={view.brand} />
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell className="column-fork">
                                    {fork && <TruncatedCode value={fork.repoName} />}
                                  </Table.Cell>
                                  <Table.Cell>
                                    {recent ? (
                                      <div className="last-push">
                                        <Paths paths={recent.changedPaths} event={recent} />
                                        <div className="caption muted">
                                          {short(recent.after)} ·{" "}
                                          <time dateTime={recent.recordedAt}>
                                            {relative(recent.recordedAt)}
                                          </time>
                                        </div>
                                      </div>
                                    ) : (
                                      "No recent pushes"
                                    )}
                                  </Table.Cell>
                                  <Table.Cell>
                                    {claims
                                      .filter(
                                        (c) =>
                                          c.agent === agent.name &&
                                          (!fork || c.repoName === fork.repoName),
                                      )
                                      .map((c) => (
                                        <button
                                          key={c.packet}
                                          className="claim-link"
                                          onClick={() => showPacket(c.packet)}
                                        >
                                          {c.packet}
                                        </button>
                                      ))}
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Events value={fork?.events} />
                                  </Table.Cell>
                                  <Table.Cell className="column-tokens"><UsageFigures usage={agentUsageToday(state, agent.name)} agent={agent.name} brand={view.brand} /></Table.Cell>
                                </Table.Row>
                              );
                            });
                          })}
                        </DataTable>
                      ) : (
                        <FirstRunEmpty kind="agents" owner={actions.owner} />
                      )}
                    </section>,
                  )}
                </>
              )}
            </div>
          </div>
        </main>
        {!actions.raceId && (narrow ? (
          <Dialog.Root open={panel} onOpenChange={toggle}>
            <Dialog
              className="activity-drawer"
              container={typeof document !== "undefined" ? document.body : undefined}
            >
              <Dialog.Title className="sr-only">
                {selected || selectedReview ? "Details" : "Activity"}
              </Dialog.Title>
              <div id="activity-panel">{panelContent}</div>
            </Dialog>
          </Dialog.Root>
        ) : (
          panel && (
            <aside
              id="activity-panel"
              className="activity-panel"
              aria-label={selected || selectedReview ? "Details" : "Activity"}
            >
              {panelContent}
            </aside>
          )
        ))}
      </div>
    </>
  );
}
