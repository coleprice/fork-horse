# Owner dashboard assets and client

A single responsive view for projects, agent lanes, packets and immutable fork-bound
claims, blockers, receipts, review decisions and receive-ordered activity. This
package builds static assets and a typed transport. It does not deploy a Worker.
FH-012 mounts these assets at `/app`, validates Cloudflare Access JWTs (`aud` and
`iss` from owner configuration), and protects the browser's owner API calls.
FH-008 supplies the sidebar/gadget host and its Cap'n Web `ui` capability.

Every user-visible product name and tagline is read from root `brand.json` at
build time. No owner hostname or owner API credential is embedded in the assets.
Production requests use the page's origin, `credentials: same-origin`, no-store,
and redirect refusal. Access supplies its assertion at the edge; the client never
sets an assertion or bearer header. MCP authentication remains a host concern.

## Run and check

After the root and exact pinned submodule dependencies are installed:

```sh
pnpm --filter forkhorse-dashboard dev:fixture
# Open the printed loopback origin at /fixtures.html.
pnpm --filter forkhorse-dashboard test
pnpm --filter forkhorse-dashboard types:check
pnpm --filter forkhorse-dashboard build
pnpm --filter forkhorse-dashboard build:fixture
pnpm test
pnpm lint
```

`dist/` contains the production `index.html` and assets with `/app/` paths.
`dist-fixture/` is a separate, ignored fixture build. The fixture dev server alone
mounts the labeled fictional API. A static fixture build requires that same fixture
API to be served by a test host; it does not emulate responses in the browser.
Restart the dev server (or POST to its test-only `/__fixtures/reset`) to reset fixture approvals/promotions. All fixture actions
are local. Passing these checks is not Access, Cloudflare, deployment or live Git
acceptance.

## Host composition

Serve `dist/index.html` for `/app` and `/app/` (or redirect `/app` to `/app/`), and
serve its immutable hashed assets under `/app/assets/`. Protect both the HTML and
asset paths with the configured Access application. Protect state, activity,
approve and promote routes with the same owner identity in core. Never inject an
owner API token. `/app?project=demo` selects a project. The HTML may contain this
inert owner-configured project list before the module entry (escape JSON for HTML
when generating it):

```html
<script id="dashboard-config" type="application/json">
  { "projects": [{ "id": "demo", "label": "Example project" }] }
</script>
```

There is no project-list route in FH-003/FH-005. The shell therefore uses configured
project IDs and an “Open project by ID” field. It never invents project data.

For a sidebar app or gadget, import `mountDashboard`, include `src/styles.css`,
and pass `brand`, project options, and a host-owned `DashboardTransport`. Its
interface has `getState`, `getActivity`, `approve`, `promote`, and optional
`subscribe`, owner-only `getReceipt` and `setSettings`. The UI does not import Cap'n Web or mint a capability. The future
host adapter implements that interface from its authorized `ui` capability.

## Wire contract

`StateResponse` in `src/contracts.ts` mirrors the public FH-005 JSON snapshot.
`createHttpTransport` maps it through `stateView` into a `ProjectState` view:

- `GET /projects/:id/state` supplies project, credential-free agents, forks with
  heads, packets, live-only claims including `{packet, agent, repoName}`, blockers,
  reviews, ledger, recent activity, reconciler alerts and `promotionPending`.
- Approval state comes from `{sha, receiptDigest}` or `null`; `stale` and `promoted`
  are explicit flags. A changed approval SHA is treated as stale. Digest binding applies to required review-created receipts; a fresh before-promote run or advisory receipt movement does not mean the fork moved.
- Blockers show the pushing and claiming agents. There is no resolution field in
  the current wire contract, so returned blockers are shown as open.
- FH-032 adds `project.settings.requireReceipt` and the five-state `reviews[].receipt` summary: status, trigger, digest, timestamps, duration and check outcomes. No logs enter `/state`.
- Owner-only `GET /projects/:id/reviews/:rid/receipt` returns the stored `{digest, receipt}` runner record. The panel shows the last 200 log lines and can expand all bounded output. A changed receipt/selection discards late responses. Agents have no log control or request.
- Owner-only `PATCH /projects/:id/settings` sends only `{requireReceipt}` and reloads authoritative state. An absent setting is unavailable, never synthesized as On or Off.
- Core currently does not return the canonical head in state. The shell says
  “Head unavailable” when commits are recorded, or “No commits yet” for an empty
  snapshot; it does not infer a current head from push history.
- `GET /projects/:id/activity?after=:sequence&limit=100` follows the last receive
  sequence in the recent snapshot. It deduplicates and displays the latest 100
  available events; event timestamps do not determine ordering.
- Approve and Promote send `{}` to `POST /projects/:id/reviews/:rid/approve` and
  `POST /projects/:id/reviews/:rid/promote`. Promote reads `{sha}`. Every action
  reloads state; writes are never automatically retried. A failed refresh clears
  actionable old state. A `409` message such as `stale base, rebase` stays visible.

The client hides decisions for a moved fork, stale review or packet blocker.
With `requireReceipt: true`, approve requires a passing summary and digest;
already-approved reviews may enter promote so core can freshly re-run checks,
including after a setting flip. Its exact receipt-failure 409 keeps the dialog
open with the new receipt available. With `requireReceipt: false`, all receipt
outcomes are advisory and promote shows no re-check state. The server remains
the authority. Unknown settings withhold actions until a valid snapshot arrives.
All API/config text is escaped before entering markup.

HTTP works without sockets. `createHttpTransport` accepts an optional host-supplied
`socketUrl(project)` for an existing same-origin WebSocket route. There is no socket
endpoint in FH-003/FH-005; this package does not claim one exists. Socket messages
invalidate state, then the UI re-reads HTTP; writes never pass through the socket.
The host should provide invalidation/reconnect behavior through its capability
transport if it needs more than this optional socket. Unmount closes subscriptions.

## Fixture acceptance

The package tests mount the real view in jsdom and use fixture JSON at the HTTP
boundary. They exercise Approve and Promote endpoints, duplicate clicks, stale
conflicts, session expiry, project selection, empty views, escaping, exact fork and
receipt gates, activity cursors and socket origin/cleanup. Browser acceptance uses
`/fixtures.html` at phone and desktop widths against the loopback fixture API.
The API deliberately returns the FH-005 wire shape, not a separate mock UI model.

## Kumo workspace UI

The same real Kumo components render the standalone dashboard and agent frame.
Overview, Work, Review and Agents use underline tabs with hash selection. Activity
is a collapsible panel and a Kumo modal drawer below 1024px. Packet details replace
the feed without navigating. React retains focus during snapshot refreshes.

The agent frame subscribes to the pinned host theme once, implements
`GatekeeperAppThemeReceiver.setTheme`, and uses upstream `applyAccentColor`.
The standalone copy follows system appearance. The reviewed host palette, font
and radius definitions are in `src/host-tokens.json`; component CSS consumes
semantic variables. Appearance never supplies authorization.

Approval still binds the exact SHA and receipt digest. Promotion confirms the
target branch and exact head in a Kumo Dialog, then the existing server gate runs
again. Agent connections disable these actions and refuse them in the controller
and transport. Ask an agent opens the host composer without sending the prompt.

Contract gaps remain visible: no Return-to-agent method; no older-history cursor
on the snapshot capability; no packet update time,
or connected-agent identity. Those fields/actions are labeled
unavailable or pending rather than synthesized. Activity preference storage is
best-effort: an opaque sandbox may deny browser storage.

## FH-033 offline receipts evidence

The receipt fixtures (`receipts`, `advisory`, `recheck`, `rerun-failed`) implement
FH-032's fixed wire contract and the 16:55 advisory ruling. `role=agent` exercises
the shared read-only view; it does not simulate owner authority. Check copy and
warning dots follow the receipts spec: Timed out and Couldn't run. Durations use
supplied milliseconds, including the timed-out check's own duration. Receipt
completion has a polite announcement; elapsed time changes never spin.

Required handback remains fixture captures in both themes, narrow/phone frames,
owner and agent details/settings, promote pending/409, advisory actions, empty,
error/loading, focus, theme accent and first paint. The fetched base already emits
the sidebar bundle after its loading caption at the end of body. FH-033 leaves
that gatekeeper source unchanged and compares baseline/final first paint.
Farrier design PASS, superprime code acceptance and the post-FH-032L live receipt
capture are separate gates; this package's offline checks cannot establish them.
