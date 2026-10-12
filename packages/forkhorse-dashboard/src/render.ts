import { reviewGate, type ViewModel } from "./model.ts";

/** All API/config text crosses this escape boundary before entering markup. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
const e = escapeHtml;
const sha = (value: string) => `<code title="${e(value)}">${e(value.slice(0, 10))}</code>`;
const empty = (text: string) => `<p class="empty">${e(text)}</p>`;
const paths = (values: string[]) =>
  values.map((path) => `<code class="path">${e(path)}</code>`).join("");
const badge = (text: string, tone = "neutral") => `<span class="badge ${tone}">${e(text)}</span>`;

export function renderDashboard(view: ViewModel): string {
  const state = view.state;
  const blockers = state?.blockers.filter((entry) => !entry.resolved) ?? [];
  const reviews = state?.reviews.filter((entry) => entry.status !== "promoted") ?? [];
  return `<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#overview"><span class="brand-mark" aria-hidden="true">↗</span><span>${e(view.brand.name)}<small>Owner workspace</small></span></a>
      <div class="sidebar-caption">WORKSPACE</div>
      <nav aria-label="Dashboard views">
        <a href="#overview">Overview <span>◈</span></a>
        <a href="#reviews">Review queue <span>${reviews.length}</span></a>
        <a href="#lanes">Agent lanes <span>${state?.agents.length ?? 0}</span></a>
        <a href="#packets">Packets & claims <span>${state?.packets.length ?? 0}</span></a>
        <a href="#blockers">Blockers <span>${blockers.length}</span></a>
        <a href="#receipts">Receipts <span>✓</span></a>
        <a href="#activity">Activity <span>↗</span></a>
      </nav>
      <p class="sidebar-note">${e(view.brand.tagline)}</p>
      <div class="session">${view.fixture ? "◌ Local fixture session" : "◌ Owner Access session"}</div>
    </aside>
    <main id="overview">
      <header class="topbar"><span>Workspace <span class="slash">/</span> Projects</span>${badge(view.fixture ? "FIXTURE · OFFLINE" : "OWNER SESSION", view.fixture ? "amber" : "neutral")}</header>
      <div class="content">
        <div class="page-heading"><div><p class="eyebrow">PROJECT CONTROL</p><h1>Work in motion.</h1><p class="subtitle">Follow agent work. Review the evidence. Move it forward.</p></div><button type="button" data-action="refresh" ${view.busy ? "disabled" : ""}>${view.busy ? "Refreshing…" : "↻ Refresh"}</button></div>
        ${view.fixture ? `<div class="fixture-banner">This workspace uses a local fixture API. Approvals and promotions change fixture data only.</div>` : ""}
        <section class="project-bar" aria-label="Projects"><div><label for="project">Project</label><select id="project" ${view.busy ? "disabled" : ""}>${view.projects.map((project) => `<option value="${e(project.id)}" ${project.id === view.project ? "selected" : ""}>${e(project.label)}</option>`).join("")}</select></div><form id="open-project"><label for="project-id">Open project by ID</label><div class="input-row"><input id="project-id" name="project" placeholder="project-id" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="48" required autocomplete="off"><button ${view.busy ? "disabled" : ""}>Open</button></div></form><div class="canonical"><span>CANONICAL HEAD</span>${state?.canonicalHead ? sha(state.canonicalHead) : "Not included in snapshot"}</div></section>
        <div role="status" aria-live="polite">${view.notice ? `<p class="notice">${e(view.notice)}</p>` : ""}${view.busy ? `<p class="loading">Loading the latest project snapshot…</p>` : ""}</div>
        ${view.error ? `<div class="error" role="alert">${e(view.error)}</div>` : ""}
        ${
          !state
            ? empty(
                view.project
                  ? "No snapshot loaded. Refresh to try again."
                  : "Select a configured project or open one by ID.",
              )
            : `
        <section class="metrics" aria-label="Project summary">
          <div><span>Agents</span><strong>${state.agents.length}</strong><small>${state.forks.length} registered forks</small></div>
          <div><span>Live claims</span><strong>${state.claims.filter((claim) => claim.active).length}</strong><small>Bound to a specific fork</small></div>
          <div><span>To review</span><strong>${reviews.length}</strong><small>Exact commits & receipts</small></div>
          <div class="${blockers.length ? "attention" : ""}"><span>Blockers</span><strong>${blockers.length}</strong><small>${blockers.length ? "Owner attention needed" : "No open path conflicts"}</small></div>
        </section>
        ${state.reconcilerAlerts.map((alert) => `<div class="error" role="alert"><strong>Canonical reconciliation alert</strong><p>${e(alert.message)} ${sha(alert.sha)}</p></div>`).join("")}
        <section id="reviews" class="panel"><div class="section-heading"><div><p class="eyebrow">OWNER DECISIONS</p><h2>Review queue</h2></div>${badge(`${reviews.length} open`)}</div>
        ${
          reviews.length
            ? reviews
                .map((review) => {
                  const gate = reviewGate(review, state);
                  const packet = state.packets.find((entry) => entry.id === review.packet);
                  return `<article class="review-card"><div class="review-title"><div><span class="kicker">${e(review.packet)} · ${e(review.agent)}</span><h3>${e(packet?.title ?? review.packet)}</h3></div>${badge(review.status, review.status === "stale" ? "amber" : review.status === "approved" ? "green" : "neutral")}</div><p>${e(packet?.goal ?? "Review the exact commit and its bound receipt before approving.")}</p><div class="review-evidence"><div><span>FORK</span><code>${e(review.repoName)}</code></div><div><span>COMMIT</span>${sha(review.sha)}</div><div><span>RECEIPT DIGEST</span>${review.receiptDigest ? sha(review.receiptDigest) : "Pending receipt"}</div></div><details class="identifiers"><summary>Exact commit & receipt identifiers</summary><p><code>${e(review.sha)}</code></p><p><code>${e(review.receiptDigest ?? "Receipt pending")}</code></p></details><div class="review-footer"><span>${e(gate.reason)}</span><div class="actions"><button type="button" data-action="approve" data-review="${e(review.id)}" ${!gate.approve || view.busy ? "disabled" : ""}>Approve</button><button class="primary" type="button" data-action="promote" data-review="${e(review.id)}" ${!gate.promote || view.busy ? "disabled" : ""}>Promote ↗</button></div></div></article>`;
                })
                .join("")
            : empty("The review queue is clear.")
        }</section>
        <section id="lanes" class="panel"><div class="section-heading"><div><p class="eyebrow">PARALLEL WORK</p><h2>Agent lanes</h2></div><span class="muted">Forks & recent pushes</span></div><div class="lane-grid">${
          state.agents
            .map((agent, index) => {
              const forks = state.forks.filter((fork) => fork.agent === agent.name);
              const recent = view.activity
                .filter((entry) => entry.agent === agent.name)
                .slice(-2)
                .toReversed();
              return `<article class="lane"><div class="lane-title"><span class="avatar">${e(agent.name.slice(0, 1).toUpperCase())}</span><div><h3>${e(agent.name)}</h3><span class="muted">Lane ${String(index + 1).padStart(2, "0")}</span></div></div>${forks.map((fork) => `<div class="fork"><span>${e(fork.repoName)}</span>${sha(fork.head)}</div>`).join("") || empty("No registered fork")}${recent.map((entry) => `<div class="push"><span class="dot"></span><div>${sha(entry.after)}<small>${e(entry.changedPaths.join(", "))}</small></div></div>`).join("") || empty("No recent pushes")}</article>`;
            })
            .join("") || empty("No enrolled agents.")
        }</div></section>
        <div class="two-columns"><section id="packets" class="panel"><div class="section-heading"><div><p class="eyebrow">SCOPED WORK</p><h2>Packets & claims</h2></div></div>${
          state.packets
            .map((packet) => {
              const claims = state.claims.filter(
                (claim) => claim.packet === packet.id && claim.active,
              );
              return `<article class="packet"><div class="review-title"><span class="kicker">${e(packet.id)}</span>${badge(claims.length ? "claimed" : "unclaimed", claims.length ? "green" : "neutral")}</div><h3>${e(packet.title)}</h3><p>${e(packet.goal)}</p><div class="paths">${paths(packet.paths)}</div>${claims.map((claim) => `<p class="claim"><strong>${e(claim.agent)}</strong> → <code>${e(claim.repoName)}</code></p>`).join("")}<details><summary>Acceptance checks</summary><ul>${packet.acceptance.map((check) => `<li>${e(check)}</li>`).join("")}</ul></details></article>`;
            })
            .join("") || empty("No packets created.")
        }</section>
        <section id="blockers" class="panel"><div class="section-heading"><div><p class="eyebrow">ATTENTION</p><h2>Blockers</h2></div>${badge(`${blockers.length} open`, blockers.length ? "amber" : "green")}</div>${blockers.map((blocker) => `<article class="blocker"><h3>${e(blocker.packet)} · ${e(blocker.agent)}</h3><p>${e(blocker.reason)}</p><div class="paths">${paths(blocker.paths)}</div></article>`).join("") || empty("No open blockers. Claimed paths are clear.")}</section></div>
        <section id="receipts" class="panel"><div class="section-heading"><div><p class="eyebrow">VERIFIABLE EVIDENCE</p><h2>Receipts</h2></div></div>${state.reviews.map((review) => `<article class="receipt"><div><strong>${e(review.packet)}</strong> ${sha(review.sha)}<p>${review.receiptDigest ? `Digest ${sha(review.receiptDigest)}` : "Waiting for check runner receipt"}</p>${review.receipt?.commands.map((command) => `<code class="path">${e(command)}</code>`).join("") ?? ""}</div>${badge(review.receipt?.status ?? (review.receiptDigest ? "digest available" : "pending"), review.receipt?.status === "passed" ? "green" : "neutral")}</article>`).join("") || empty("No receipt requests.")}</section>
        <section id="activity" class="panel"><div class="section-heading"><div><p class="eyebrow">RECEIVE ORDER</p><h2>Recent activity</h2></div><span class="muted">Latest ${view.activity.length} events</span></div>${
          view.activity
            .toReversed()
            .map(
              (entry) =>
                `<article class="activity"><span class="activity-sequence">${entry.sequence}</span><div><strong>${e(entry.agent ?? "canonical")}</strong> pushed ${sha(entry.after)}<p>${e(entry.repoName)} · ${e(entry.changedPaths.join(", "))}</p></div><time datetime="${e(entry.recordedAt)}">${e(entry.recordedAt.replace("T", " ").slice(0, 16))} UTC</time></article>`,
            )
            .join("") || empty("No recorded pushes.")
        }<details><summary>Promotion ledger (${state.ledger.length})</summary>${state.ledger.map((entry) => `<p>${e(entry.review)} → ${sha(entry.sha)} <span class="muted">${e(entry.promotedAt)}</span></p>`).join("") || empty("No recorded promotions.")}</details></section>`
        }
        <footer>${view.fixture ? "Fixture evidence only · no live deployment" : "Owner actions are authorized by the host"}<span>${view.updatedAt ? `Snapshot loaded ${e(view.updatedAt)}` : "No snapshot loaded"}</span></footer>
      </div>
    </main>
  </div>`;
}
