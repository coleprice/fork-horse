import { useState, useEffect, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Empty,
  LayerCard,
  Table,
  Tabs,
  Tooltip,
  TooltipProvider,
} from "@cloudflare/kumo";
import { Pulse, X } from "@phosphor-icons/react";
import { reviewGate, type ViewModel } from "./model.ts";
import type { Review } from "./contracts.ts";

export type Section = "overview" | "work" | "review" | "agents";
export interface ViewActions {
  section: Section;
  setSection(section: Section): void;
  owner: boolean;
  selectProject(id: string): Promise<void>;
  agent?: string;
  ask?: () => Promise<void>;
  action(kind: "approve" | "promote", review: string): Promise<void>;
}
const short = (value: string) => <code title={value}>{value.slice(0, 7)}</code>;
const empty = (title: string) => <Empty size="sm" title={title} />;
function relative(value: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "Time unavailable";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return `${Math.floor(elapsed / 86_400_000)} days ago`;
}
function Status({
  label,
  tone = "info",
}: {
  label: string;
  tone?: "info" | "brand" | "success" | "warning" | "danger";
}) {
  // Kumo 2.14 only supplies four dot variants. Override its dot with the host status token.
  return (
    <Badge appearance="dot" variant="neutral" className={`status-dot status-${tone}`}>
      {label}
    </Badge>
  );
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
function ReviewActions({
  review,
  view,
  actions,
  primary,
}: {
  review: Review;
  view: ViewModel;
  actions: ViewActions;
  primary: boolean;
}) {
  const [confirmation, setConfirmation] = useState<{
    sha: string;
    digest: string | null;
    branch: string;
  }>();
  const matchesConfirmation =
    !!confirmation &&
    review.sha === confirmation.sha &&
    review.receiptDigest === confirmation.digest &&
    view.state!.project.defaultBranch === confirmation.branch;
  const gate = reviewGate(review, view.state!);
  const title = actions.owner
    ? gate.reason
    : "Approve and Promote are unavailable for this agent connection.";
  return (
    <div className="actions">
      <Button
        size="sm"
        data-action="approve"
        data-review={review.id}
        title={title}
        disabled={!actions.owner || !gate.approve || view.busy}
        onClick={() => void actions.action("approve", review.id)}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant={primary ? "primary" : "secondary"}
        data-action="promote"
        data-review={review.id}
        title={title}
        disabled={!actions.owner || !gate.promote || view.busy}
        onClick={() =>
          setConfirmation({
            sha: review.sha,
            digest: review.receiptDigest,
            branch: view.state!.project.defaultBranch,
          })
        }
      >
        Promote
      </Button>
      <Tooltip
        render={<span tabIndex={0} />}
        content="Returning a review is not supported by this connection."
      >
        <Button size="sm" disabled>
          Return to agent
        </Button>
      </Tooltip>
      <Dialog.Root
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <Dialog className="p-6">
          <Dialog.Title>Promote to {confirmation?.branch}</Dialog.Title>
          <Dialog.Description>
            Promote {review.packet} from {review.repoName} at the exact head below. The server
            checks the head and receipt again.
          </Dialog.Description>
          <ClipboardText text={confirmation?.sha ?? review.sha} size="sm" />
          {!matchesConfirmation && (
            <Banner
              variant="alert"
              size="sm"
              description="Fork moved since you reviewed it. Close and review again."
            />
          )}
          <div className="actions">
            <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
            <Button
              variant="primary"
              data-action="confirm-promote"
              disabled={!actions.owner || !matchesConfirmation || !gate.promote || view.busy}
              onClick={() => {
                if (!matchesConfirmation || !gate.promote) return;
                setConfirmation(undefined);
                void actions.action("promote", review.id);
              }}
            >
              Promote to {confirmation?.branch}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
export function DashboardView({ view, actions }: { view: ViewModel; actions: ViewActions }) {
  const [panel, setPanel] = useState(() => {
    try {
      const saved = globalThis.localStorage?.getItem("dashboard-activity");
      if (saved !== null && saved !== undefined) return saved === "open";
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
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string>();
  const state = view.state;
  const blockers = state?.blockers.filter((entry) => !entry.resolved) ?? [];
  const reviews = state?.reviews.filter((entry) => entry.status !== "promoted") ?? [];
  const activeClaims = state?.claims.filter((entry) => entry.active) ?? [];
  const selected = state?.packets.find((entry) => entry.id === packetId);
  function toggle(value: boolean) {
    setPanel(value);
    try {
      globalThis.localStorage?.setItem("dashboard-activity", value ? "open" : "closed");
    } catch {
      /* Keep the in-frame preference. */
    }
  }
  function showPacket(id: string) {
    setPacketId(id);
    toggle(true);
  }
  const ask = actions.ask && (
    <Button
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
    <div hidden={actions.section !== id} id={`view-${id}`} role="tabpanel" aria-label={id}>
      {content}
    </div>
  );
  const hasCommits =
    !!state?.forks.some((fork) => fork.head) || !!view.activity.length || !!state?.ledger.length;
  const panelContent = (
    <>
      <div className="section-heading">
        <h2>{selected ? "Packet details" : "Activity"}</h2>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Close activity"
          onClick={() => toggle(false)}
        >
          <X size={16} />
        </Button>
      </div>
      {selected ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setPacketId(undefined)}>
            Back to activity
          </Button>
          <h3>
            {selected.id} · {selected.title}
          </h3>
          <p>{selected.goal}</p>
          <h3>Paths</h3>
          {selected.paths.map((path) => (
            <p key={path}>
              <code>{path}</code>
            </p>
          ))}
          <h3>Acceptance checks</h3>
          <ul>
            {selected.acceptance.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </>
      ) : (
        <section id="activity">
          {view.activity.toReversed().map((entry) => (
            <article key={entry.sequence} className="activity">
              <p>
                <strong>{entry.agent ?? "Canonical"}</strong> · {short(entry.after)}
              </p>
              <p className="caption">
                <code>{entry.changedPaths[0] ?? "No changed paths recorded"}</code>
                {entry.changedPaths.length > 1 && ` +${entry.changedPaths.length - 1} more`}
              </p>
              {entry.ref !== `refs/heads/${state?.project.defaultBranch}` && (
                <p className="caption">
                  <code>{entry.ref}</code>
                </p>
              )}
              <time className="caption muted" dateTime={entry.recordedAt}>
                {relative(entry.recordedAt)}
              </time>
            </article>
          ))}
          {!view.activity.length && empty("No recorded pushes.")}
          <Tooltip
            render={<span tabIndex={0} />}
            content="This snapshot connection supplies only recent activity."
          >
            <Button disabled size="sm">
              Load older
            </Button>
          </Tooltip>
        </section>
      )}
    </>
  );
  return (
    <TooltipProvider>
      <div className={`app-shell ${panel ? "panel-open" : ""}`}>
        <main className="main-pane">
          <header className="page-header">
            <div>
              <h1 className="page-title">{view.project || view.brand.name}</h1>
              <p className="page-description">
                Agents work in their own forks. You review and promote.
              </p>
            </div>
            <div className="actions">
              {ask}
              <Tooltip
                content={panel ? "Hide activity" : "Show activity"}
                render={
                  <Button
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
                      Work{" "}
                      <Badge variant="secondary">{blockers.length + activeClaims.length}</Badge>
                    </span>
                  ),
                },
                {
                  className: "text-[13px]",
                  value: "review",
                  label: (
                    <span className="tab-label">
                      Review <Badge variant="secondary">{reviews.length}</Badge>
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
            <div className="project-controls">
              <div>
                <label htmlFor="project">Project</label>
                <select
                  id="project"
                  disabled={!actions.owner || view.busy}
                  value={view.project}
                  onChange={(event) => void actions.selectProject(event.target.value)}
                >
                  {view.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label}
                    </option>
                  ))}
                </select>
              </div>
              <form id="open-project" hidden={!actions.owner}>
                <label htmlFor="project-id">Open project by ID</label>
                <div className="actions">
                  <input
                    id="project-id"
                    name="project"
                    placeholder="project-id"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={48}
                    required
                    autoComplete="off"
                  />
                  <Button type="submit" disabled={view.busy}>
                    Open
                  </Button>
                </div>
              </form>
              <Button data-action="refresh" disabled={view.busy}>
                {view.busy ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
            <div role="status" aria-live="polite">
              {view.notice && <Banner size="sm" description={view.notice} />}
              {view.busy && <p>Loading the latest project snapshot…</p>}
              {askError && <p>{askError}</p>}
            </div>
            {view.error && <Banner variant="error" role="alert" description={view.error} />}
            {!state ? (
              empty(
                view.project
                  ? "No snapshot loaded. Refresh to try again."
                  : "Select a configured project or open one by ID.",
              )
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
                        <h2>{state.project.repoName}</h2>
                        <Badge variant="secondary">Events pending</Badge>
                      </div>
                      <p>
                        Default branch <code>{state.project.defaultBranch}</code>
                      </p>
                      <p>
                        Canonical head:{" "}
                        {state.canonicalHead
                          ? short(state.canonicalHead)
                          : hasCommits
                            ? "Head unavailable"
                            : "No commits yet"}
                      </p>
                      {state.project.remote ? (
                        <ClipboardText text={state.project.remote} size="sm" />
                      ) : (
                        <p className="muted">Remote unavailable in this snapshot</p>
                      )}
                      <p className="muted">
                        Last promotion:{" "}
                        {state.ledger.length ? (
                          <>
                            {short(state.ledger.at(-1)!.sha)} ·{" "}
                            {relative(state.ledger.at(-1)!.promotedAt)}
                          </>
                        ) : (
                          "No recorded promotions"
                        )}
                      </p>
                    </LayerCard>
                    <section className="metrics" aria-label="Project summary">
                      {[
                        ["Open packets", state.packets.length],
                        ["Active claims", activeClaims.length],
                        ["In review", reviews.length],
                        ["Blockers", blockers.length],
                      ].map(([label, count]) => (
                        <LayerCard key={label} className="p-4">
                          <span className="caption">{label}</span>
                          <h3>
                            {count}
                            {label === "Blockers" && blockers.length > 0 && (
                              <Status label="Blocked" tone="warning" />
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
                    <section id="blockers">
                      {blockers.map((blocker) => (
                        <Banner
                          key={blocker.id}
                          variant="alert"
                          title={`${blocker.packet} · ${blocker.agent}`}
                          description={blocker.reason}
                          action={
                            <Button size="sm" onClick={() => showPacket(blocker.packet)}>
                              View packet
                            </Button>
                          }
                        />
                      ))}
                    </section>
                    <section id="packets">
                      <h2>Packets and claims</h2>
                      {state.packets.length ? (
                        <DataTable
                          headings={["Packet", "State", "Claimed by", "Fork", "Paths", "Updated"]}
                        >
                          {state.packets.map((packet) => {
                            const claims = activeClaims.filter(
                              (claim) => claim.packet === packet.id,
                            );
                            const blocked = blockers.some(
                              (blocker) => blocker.packet === packet.id,
                            );
                            return (
                              <Table.Row
                                key={packet.id}
                                className={selected?.id === packet.id ? "selected-row" : ""}
                                onClick={() => showPacket(packet.id)}
                              >
                                <Table.Cell>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => showPacket(packet.id)}
                                  >
                                    {packet.id}
                                  </Button>
                                  <p>{packet.title}</p>
                                </Table.Cell>
                                <Table.Cell>
                                  <Status
                                    label={
                                      blocked ? "Blocked" : claims.length ? "In progress" : "Ready"
                                    }
                                    tone={blocked ? "warning" : claims.length ? "brand" : "info"}
                                  />
                                </Table.Cell>
                                <Table.Cell>
                                  {claims.map((claim) => claim.agent).join(", ") || "Unclaimed"}
                                </Table.Cell>
                                <Table.Cell>
                                  {claims.map((claim) => (
                                    <code key={claim.repoName}>{claim.repoName}</code>
                                  ))}
                                </Table.Cell>
                                <Table.Cell>
                                  <code>{packet.paths[0]}</code>
                                  {packet.paths.length > 1 && ` +${packet.paths.length - 1}`}
                                </Table.Cell>
                                <Table.Cell>Unavailable</Table.Cell>
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
                            "Receipts",
                            "Requested",
                            "Actions",
                          ]}
                        >
                          {reviews.map((review, index) => (
                            <Table.Row key={review.id} className="review-card">
                              <Table.Cell>
                                {review.packet}
                                <p>
                                  <Status
                                    label={review.status === "stale" ? "Fork moved" : "In review"}
                                    tone={review.status === "stale" ? "warning" : "info"}
                                  />
                                </p>
                              </Table.Cell>
                              <Table.Cell>
                                {review.agent}
                                <p>
                                  <code>{review.repoName}</code>
                                </p>
                              </Table.Cell>
                              <Table.Cell>
                                {short(review.sha)}
                                <details>
                                  <summary>Exact identifiers</summary>
                                  <ClipboardText text={review.sha} size="sm" />
                                  <ClipboardText
                                    text={review.receiptDigest ?? "Receipt pending"}
                                    size="sm"
                                  />
                                </details>
                              </Table.Cell>
                              <Table.Cell>
                                {review.receipt ? (
                                  <Status
                                    label={review.receipt.status === "passed" ? "Passed" : "Failed"}
                                    tone={review.receipt.status === "passed" ? "success" : "danger"}
                                  />
                                ) : (
                                  "Receipt details unavailable"
                                )}
                                <p>{reviewGate(review, state).reason}</p>
                              </Table.Cell>
                              <Table.Cell>
                                {review.requestedAt ? relative(review.requestedAt) : "Unavailable"}
                              </Table.Cell>
                              <Table.Cell>
                                <ReviewActions
                                  review={review}
                                  view={view}
                                  actions={actions}
                                  primary={
                                    index ===
                                    reviews.findIndex((item) => reviewGate(item, state).promote)
                                  }
                                />
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </DataTable>
                      ) : (
                        empty("The review queue is clear.")
                      )}
                    </section>
                    <section id="receipts">
                      <h2>Receipts</h2>
                      {state.reviews.map((review) => (
                        <LayerCard key={review.id} className="p-4 receipt">
                          <strong>{review.packet}</strong> {short(review.sha)}
                          <p>
                            {review.receiptDigest ? (
                              <>Digest {short(review.receiptDigest)}</>
                            ) : (
                              "Waiting for check runner receipt"
                            )}
                          </p>
                          {review.receipt ? (
                            <>
                              <Status
                                label={review.receipt.status === "passed" ? "Passed" : "Failed"}
                                tone={review.receipt.status === "passed" ? "success" : "danger"}
                              />
                              {review.receipt.commands.map((command) => (
                                <p key={command}>
                                  <code>{command}</code>
                                </p>
                              ))}
                            </>
                          ) : (
                            <Badge variant="secondary">Details pending</Badge>
                          )}
                          <p className="caption">
                            Duration and runner unavailable in this snapshot
                          </p>
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
                        {state.agents.map((agent) => {
                          const forks = state.forks.filter((fork) => fork.agent === agent.name);
                          const recent = view.activity
                            .filter((event) => event.agent === agent.name)
                            .at(-1);
                          return (
                            <Table.Row key={agent.name}>
                              <Table.Cell>{agent.name}</Table.Cell>
                              <Table.Cell>
                                {forks.map((fork) => (
                                  <p key={fork.repoName}>
                                    <code>{fork.repoName}</code>
                                  </p>
                                ))}
                              </Table.Cell>
                              <Table.Cell>
                                {forks.map((fork) => (
                                  <p key={fork.repoName}>{short(fork.head)}</p>
                                ))}
                              </Table.Cell>
                              <Table.Cell>
                                {recent ? relative(recent.recordedAt) : "No recent pushes"}
                              </Table.Cell>
                              <Table.Cell>
                                {activeClaims
                                  .filter((claim) => claim.agent === agent.name)
                                  .map((claim) => (
                                    <Button
                                      key={claim.packet}
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => showPacket(claim.packet)}
                                    >
                                      {claim.packet}
                                    </Button>
                                  ))}
                              </Table.Cell>
                              <Table.Cell>
                                <Badge variant="secondary">Events pending</Badge>
                              </Table.Cell>
                            </Table.Row>
                          );
                        })}
                      </DataTable>
                    ) : (
                      empty("No enrolled agents.")
                    )}
                  </section>,
                )}
              </>
            )}
            <footer>
              {view.fixture
                ? "Fixture evidence only · no live deployment"
                : actions.owner
                  ? "Owner actions are authorized by the host"
                  : "Agent connection · owner actions unavailable"}
              <span>
                {view.updatedAt ? `Snapshot loaded ${view.updatedAt}` : "No snapshot loaded"}
              </span>
            </footer>
          </div>
        </main>
        {narrow ? (
          <Dialog.Root open={panel} onOpenChange={toggle}>
            <Dialog
              className="activity-drawer"
              container={typeof document !== "undefined" ? document.body : undefined}
            >
              <Dialog.Title className="sr-only">
                {selected ? "Packet details" : "Activity"}
              </Dialog.Title>
              <div id="activity-panel">{panelContent}</div>
            </Dialog>
          </Dialog.Root>
        ) : (
          panel && (
            <aside
              id="activity-panel"
              className="activity-panel"
              aria-label={selected ? "Packet details" : "Activity"}
            >
              {panelContent}
            </aside>
          )
        )}
      </div>
    </TooltipProvider>
  );
}
