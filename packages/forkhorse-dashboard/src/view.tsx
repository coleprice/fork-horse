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
  Table,
  Tabs,
  Toasty,
  Tooltip,
  TooltipProvider,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { ArrowLeft, ArrowLineUp, Pulse, X } from "@phosphor-icons/react";
import { reviewGate, type ViewModel } from "./model.ts";
import type { Activity, ProjectState, Review } from "./contracts.ts";

export type Section = "overview" | "work" | "review" | "agents";
export interface ViewActions {
  section: Section;
  setSection(section: Section): void;
  owner: boolean;
  selectProject(id: string): Promise<void>;
  retry?: () => Promise<void>;
  agent?: string;
  ask?: () => Promise<void>;
  action(kind: "approve" | "promote", review: string): Promise<void>;
}
const short = (value: string) => <code title={value}>{value.slice(0, 7)}</code>;
const empty = (title: string) => <Empty size="sm" title={title} />;
function relative(value: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return `${Math.floor(elapsed / 86_400_000)} days ago`;
}
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
  if (state.blockers.some((b) => b.packet === id && !b.resolved))
    return { label: "Blocked", tone: "warning" };
  const reviews = state.reviews.filter((r) => r.packet === id);
  if (reviews.some((r) => r.status === "promoted")) return { label: "Promoted", tone: "success" };
  if (reviews.some((r) => r.status === "approved")) return { label: "Approved", tone: "success" };
  if (reviews.some((r) => r.status === "stale")) return { label: "Fork moved", tone: "warning" };
  if (reviews.some((r) => r.status === "pending")) return { label: "In review", tone: "info" };
  if (state.claims.some((c) => c.packet === id && c.active))
    return { label: "In progress", tone: "brand" };
  return { label: "Ready", tone: "info" };
}
function DataTable({ headings, children }: { headings: string[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <Table>
        <Table.Header>
          <Table.Row>
            {headings.map((text) => (
              <Table.Head key={text}>{text}</Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>{children}</Table.Body>
      </Table>
    </div>
  );
}
function Notice({ message }: { message?: string }) {
  const toasts = useKumoToastManager();
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (message && message !== previous.current) toasts.add({ title: message, variant: "success" });
    previous.current = message;
  }, [message, toasts]);
  return null;
}
function ReviewActions({
  review,
  view,
  actions,
}: {
  review: Review;
  view: ViewModel;
  actions: ViewActions;
}) {
  const [confirmation, setConfirmation] = useState<{
    sha: string;
    base?: string;
    digest: string | null;
    branch: string;
  }>();
  const matches =
    !!confirmation &&
    review.sha === confirmation.sha &&
    review.base === confirmation.base &&
    review.receiptDigest === confirmation.digest &&
    view.state!.project.defaultBranch === confirmation.branch;
  const gate = reviewGate(review, view.state!);
  if (!actions.owner) return null;
  return (
    <>
      {gate.approve && (
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
      {gate.promote && (
        <Button
          size="sm"
          variant="secondary"
          data-action="promote"
          data-review={review.id}
          disabled={view.busy}
          onClick={() =>
            setConfirmation({
              sha: review.sha,
              base: review.base,
              digest: review.receiptDigest,
              branch: view.state!.project.defaultBranch,
            })
          }
        >
          <ArrowLineUp size={16} />
          Promote
        </Button>
      )}
      <Dialog.Root
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
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
          {(!matches || !gate.promote) && (
            <Banner
              variant="alert"
              size="sm"
              description="Review changed. Close and review again."
            />
          )}
          <div className="dialog-actions">
            <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
            <Button
              variant="primary"
              data-action="confirm-promote"
              disabled={!matches || !gate.promote || view.busy}
              onClick={() => {
                if (!matches || !gate.promote) return;
                setConfirmation(undefined);
                void actions.action("promote", review.id);
              }}
            >
              Promote to {confirmation?.branch}
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
      const saved = globalThis.localStorage?.getItem("dashboard-activity");
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
  const [packetId, setPacketId] = useState<string>();
  const [reviewId, setReviewId] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string>();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const state = view.state;
  const blockers = state?.blockers.filter((b) => !b.resolved) ?? [];
  const reviews = state?.reviews.filter((r) => r.status !== "promoted") ?? [];
  const claims = state?.claims.filter((c) => c.active) ?? [];
  const selected = state?.packets.find((p) => p.id === packetId);
  const selectedReview = state?.reviews.find((r) => r.id === reviewId);
  function toggle(value: boolean) {
    setPanel(value);
    if (!value && narrow) window.setTimeout(() => toggleRef.current?.focus(), 0);
    try {
      globalThis.localStorage?.setItem("dashboard-activity", value ? "open" : "closed");
    } catch {
      /* Keep the in-frame preference. */
    }
  }
  function showPacket(id: string) {
    setPacketId(id);
    setReviewId(undefined);
    toggle(true);
  }
  function back() {
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
      {selected || selectedReview ? (
        <>
          <h3>{selected?.title ?? selectedReview?.packet}</h3>
          {selected && (
            <>
              <p className="caption muted">{selected.id}</p>
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
          {!view.activity.length && empty("No recorded pushes.")}
          {view.activity.length === 100 && (
            <p className="caption muted">Showing the latest 100 events.</p>
          )}
        </section>
      )}
    </>
  );
  return (
    <>
      <Notice message={view.notice} />
      <div className={`app-shell ${panel ? "panel-open" : ""}`}>
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
                        {reviews.length > 0 && <Badge variant="secondary">{reviews.length}</Badge>}
                      </span>
                    ),
                  },
                  { className: "text-[13px]", value: "agents", label: "Agents" },
                ]}
              />
            </div>
            <div className="content">
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
                  description="Local synthetic snapshots only. No live deployment or account connection."
                />
              )}
              {(view.busy || askError) && (
                <div role="status" aria-live="polite">
                  {view.busy && <p>Loading the latest project snapshot…</p>}
                  {askError && <p>{askError}</p>}
                </div>
              )}
              {view.error && (
                <Banner
                  variant="error"
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
              {!state ? (
                !view.busy &&
                !view.error &&
                empty(view.project ? "No snapshot loaded." : "Select a configured project.")
              ) : (
                <>
                  {state.reconcilerAlerts.map((alert, index) => (
                    <Banner
                      key={index}
                      variant="error"
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
                        <p className="muted">
                          {state.ledger.length ? (
                            <>
                              Last promotion: {short(state.ledger.at(-1)!.sha)} ·{" "}
                              {relative(state.ledger.at(-1)!.promotedAt)}
                            </>
                          ) : (
                            "No promotions yet"
                          )}
                        </p>
                      </LayerCard>
                      <section className="metrics" aria-label="Project summary">
                        {[
                          ["Open packets", state.packets.length],
                          ["Active claims", claims.length],
                          ["In review", reviews.length],
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
                          </LayerCard>
                        ))}
                      </section>
                      {!state.packets.length && (
                        <Empty
                          title="No packets yet"
                          description="Ask an agent to claim work, or create a packet with the owner CLI."
                          contents={ask}
                        />
                      )}
                    </>,
                  )}
                  {section(
                    "work",
                    <>
                      {!!blockers.length && (
                        <section id="blockers" className="blockers">
                          {blockers.map((b) => (
                            <Banner
                              key={b.id}
                              variant="alert"
                              description={
                                b.sha && b.claimingAgent ? (
                                  <span className="collision-copy">
                                    {b.pushingAgent ?? b.agent} pushed {short(b.sha)} to{" "}
                                    <Paths paths={b.paths} />, which {b.claimingAgent} has claimed
                                    for {b.packet}.
                                  </span>
                                ) : (
                                  b.reason
                                )
                              }
                              action={
                                <Button size="sm" onClick={() => showPacket(b.packet)}>
                                  View packet
                                </Button>
                              }
                            />
                          ))}
                        </section>
                      )}
                      <section id="packets">
                        <h2>Packets and claims</h2>
                        {state.packets.length ? (
                          <DataTable
                            headings={["Packet", "State", "Claimed by", "Fork", "Paths", "Claimed"]}
                          >
                            {state.packets.map((p) => {
                              const live = claims.filter((c) => c.packet === p.id);
                              return (
                                <Table.Row
                                  key={p.id}
                                  className={selected?.id === p.id ? "selected-row" : ""}
                                  onClick={() => showPacket(p.id)}
                                >
                                  <Table.Cell>
                                    <button
                                      className="packet-link"
                                      title={p.title}
                                      onClick={() => showPacket(p.id)}
                                    >
                                      {p.title}
                                    </button>
                                    <div className="caption muted">{p.id}</div>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Status {...packetStatus(p.id, state)} />
                                  </Table.Cell>
                                  <Table.Cell>
                                    {live.map((c) => c.agent).join(", ") || "Unclaimed"}
                                  </Table.Cell>
                                  <Table.Cell>
                                    {live.map((c) => (
                                      <TruncatedCode key={c.repoName} value={c.repoName} />
                                    ))}
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Paths paths={p.paths} />
                                  </Table.Cell>
                                  <Table.Cell>
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
                          empty("No packets created.")
                        )}
                      </section>
                    </>,
                  )}
                  {section(
                    "review",
                    <>
                      <section id="reviews">
                        <h2>Review queue</h2>
                        {reviews.length ? (
                          <DataTable
                            headings={[
                              "Packet",
                              "Agent",
                              "Fork head",
                              "State",
                              "Receipts",
                              "Requested",
                              ...(actions.owner ? ["Actions"] : []),
                            ]}
                          >
                            {reviews.map((r) => {
                              const stale =
                                r.status === "stale" ||
                                state.forks.find((f) => f.repoName === r.repoName)?.head !== r.sha;
                              return (
                                <Table.Row key={r.id} className="review-card">
                                  <Table.Cell>
                                    <button
                                      className="claim-link"
                                      onClick={() => {
                                        setReviewId(r.id);
                                        setPacketId(undefined);
                                        toggle(true);
                                      }}
                                    >
                                      {r.packet}
                                    </button>
                                  </Table.Cell>
                                  <Table.Cell>
                                    {r.agent}
                                    <div className="caption muted">
                                      <TruncatedCode value={r.repoName} />
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell>{short(r.sha)}</Table.Cell>
                                  <Table.Cell>
                                    <Status
                                      label={
                                        stale
                                          ? "Fork moved"
                                          : r.status === "approved"
                                            ? "Approved"
                                            : "In review"
                                      }
                                      tone={
                                        stale
                                          ? "warning"
                                          : r.status === "approved"
                                            ? "success"
                                            : "info"
                                      }
                                    />
                                    {stale && (
                                      <div className="caption muted state-reason">
                                        The agent must request review again.
                                      </div>
                                    )}
                                  </Table.Cell>
                                  <Table.Cell>
                                    {r.receipt && (
                                      <Status
                                        label={`${r.receipt.status === "passed" ? "Passed" : "Failed"} ${r.receipt.commands.length}`}
                                        tone={r.receipt.status === "passed" ? "success" : "danger"}
                                      />
                                    )}
                                    <div className="caption">
                                      {r.receiptDigest ? (
                                        <code>Receipt {r.receiptDigest.slice(0, 7)}</code>
                                      ) : (
                                        "No receipt"
                                      )}
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell>
                                    {r.requestedAt && (
                                      <span className="caption muted">
                                        {relative(r.requestedAt)}
                                      </span>
                                    )}
                                  </Table.Cell>
                                  {actions.owner && (
                                    <Table.Cell>
                                      <ReviewActions review={r} view={view} actions={actions} />
                                    </Table.Cell>
                                  )}
                                </Table.Row>
                              );
                            })}
                          </DataTable>
                        ) : (
                          empty("No reviews waiting for owner action.")
                        )}
                      </section>
                      <section id="receipts">
                        {state.reviews.some((r) => r.receipt) && <h2>Receipts</h2>}
                        {state.reviews
                          .filter((r) => r.receipt)
                          .map((r) => (
                            <LayerCard key={r.id} className="p-4 receipt">
                              <strong>{r.packet}</strong> {short(r.sha)}{" "}
                              <Status
                                label={r.receipt!.status === "passed" ? "Passed" : "Failed"}
                                tone={r.receipt!.status === "passed" ? "success" : "danger"}
                              />
                              {r.receipt!.commands.map((c) => (
                                <p key={c}>
                                  <code>{c}</code>
                                </p>
                              ))}
                            </LayerCard>
                          ))}
                      </section>
                    </>,
                  )}
                  {section(
                    "agents",
                    <section id="lanes">
                      <h2>Agents</h2>
                      {state.agents.length ? (
                        <DataTable
                          headings={["Agent", "Fork", "Head", "Last push", "Claim", "Events"]}
                        >
                          {state.agents.flatMap((agent) => {
                            const forks = state.forks.filter((f) => f.agent === agent.name);
                            return (forks.length ? forks : [undefined]).map((fork) => {
                              const recent = view.activity.findLast((e) =>
                                fork ? e.repoName === fork.repoName : e.agent === agent.name,
                              );
                              return (
                                <Table.Row key={`${agent.name}-${fork?.repoName ?? "none"}`}>
                                  <Table.Cell>{agent.name}</Table.Cell>
                                  <Table.Cell>
                                    {fork && <TruncatedCode value={fork.repoName} />}
                                  </Table.Cell>
                                  <Table.Cell>{fork && short(fork.head)}</Table.Cell>
                                  <Table.Cell>
                                    {recent ? (
                                      <div className="last-push">
                                        {short(recent.after)}
                                        <Paths paths={recent.changedPaths} event={recent} />
                                        <time className="caption muted">
                                          {relative(recent.recordedAt)}
                                        </time>
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
                                </Table.Row>
                              );
                            });
                          })}
                        </DataTable>
                      ) : (
                        empty("No enrolled agents.")
                      )}
                    </section>,
                  )}
                </>
              )}
            </div>
          </div>
        </main>
        {narrow ? (
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
        )}
      </div>
    </>
  );
}
