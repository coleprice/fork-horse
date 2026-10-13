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

## Owner decisions on Overview

The owner-only **Needs you** card routes to evidence, with no approval or promotion
controls. It lists uncertain promotions, reconciler alerts, open collisions,
failed required receipts, then reviews ready to promote or approve. Readiness
uses FH-045's shared state derivation and review gate; Returned, Fork moved,
Main moved, Out of date and promoted reviews are excluded, including approved
reviews whose core stale flag is false. Five rows show initially, with expansion in place and a persistent
empty state. Agent connections render no card.

Review rows use the existing detail route; hosts without detail reads fall back
to the review queue. Collisions open Work packet details, and reconciler rows
focus the matching Agents row (or the Agents heading when the canonical repo
has no agent row). Promotion intents without a review route focus Last promotion.
Within each kind, review request times and Core's receive-sequence alert/collision
IDs provide oldest-first ordering. A current-head alert without a sequence follows
the recorded alerts; older capability snapshots without metadata retain their
supplied order and available evidence.

The loopback fixture harness includes `needs-all`, `needs-promotion`,
`needs-reconciler`, `needs-blocker`, `needs-failed`, `needs-promote`,
`needs-approve`, `needs-advisory`, `needs-empty`, and `needs-main-moved`. The last
fixture pairs a nonstale approved Main moved review with a ready-to-promote
review, showing only the latter in the card. Use `role=agent` to check
absence and `host=queue-only` to check the capability fallback. These snapshots
are synthetic, and fixture routes are excluded from production assets.

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
- FH-048 blockers retain `resolved: null | {at, by, reason?}` history. Missing legacy resolution reads as open; missing `at` and `pushingPacket` read as unknown. Open blockers gate the pushing fork and attributed packet (all reviews on that fork when attribution is null), never the claimant.
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
including after a setting flip. A failed before-promote run hides Promote until
a fix; a timed-out or couldn't-run attempt keeps Promote with its retry caption.
An approved Re-checking row has no gate caption. A required missing receipt shows
Not started in its cell and Waiting for checks only under State. Its exact receipt-failure 409 keeps the dialog
open with the new receipt available and a Warning icon. That handled conflict
has no duplicate page banner or raw core error copy. With `requireReceipt: false`, all receipt
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

Contract gaps remain visible: no older-history cursor
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

## FH-036 receipt history

Review shows the five newest public receipt summaries, including promoted reviews.
Finished receipts sort by their finish time; running receipts sort by their start
and show no invented finish time. Each row opens the existing receipt panel.
Overview's Last promotion opens a receipt only when the ledger review ID, commit
and receipt digest match its public summary. Missing or replaced summaries leave
the promotion line without an outcome. Owner logs retain the existing Access
session route; agents have no logs control.

The `history-required` and `history-advisory` fixtures include shuffled promoted
reviews, more than five receipts, both triggers and an advisory failure. These
are offline fixture evidence; design review, owner acceptance and live checks
remain separate.


## FH-040 review detail (FH-039 contract integration pending)

The queue opens a full-width detail at `#review/<rid>`; Back returns to the queue.
Recent receipt rows still open the receipt panel. Checks, Approval and Main each
have their own status and evidence control. The final milestone is Promoted to
main. Promotion evidence comes only from this review's ledger entry.

The optional host transport methods `getReview`, `getDiff` and `returnReview` follow
FH-039's fixed contract. The HTTP transport uses the existing same-origin session
for `GET /projects/:id/reviews/:rid`, `GET …/diff?path=…`, and owner-only
`POST …/return` with `{reason}`. Reads and writes never carry browser tokens.
A host without `getReview` keeps non-linking queue rows and resolves detail
bookmarks back to the queue. It does not invent detail from packet claims or push history. FH-039 core integration and
capability-host support must be checked separately after FH-039 lands.

Diffs fetch only when expanded, accept at most 64 KiB, retain added/removed
prefixes, and render as escaped plain text. Returned reasons retain line breaks
for owners and agents. Return requires a visible labelled textarea with 1–2000
characters and a counter. The controller refuses agent writes, stale/promoted/
returned reviews and duplicate writes; an uncertain owner write is never retried.
The dialog alone owns Return errors, including the promoted 409.

`review-*` scenarios in `test/review-fixtures.ts` are labeled offline FH-039
contract fixtures: current, approved, promoted, returned, stale, advisory failed,
400-file changes (200 visible), detail loading/error/not-found, and return 409.
These fixtures do not establish Cloudflare or owner acceptance. Dashboard tests
exercise routes/back navigation, independent evidence, escaping, lazy diffs,
return bounds, agent restrictions, owner conflicts and existing receipt gates.
Farrier design PASS and the superprime's code review remain separate gates.
Use `?scenario=review-current&host=queue-only#review/review-1` in the fixture entry
to exercise the dashboard fallback with `getReview` and `getDiff` absent.


## FH-045 stale causes and quick durations

Review detail and queue derive the first proven state from the public snapshot:
Promoted, Returned, Fork moved, Main moved, then Out of date. Returned reviews
never show a stale banner. Fork moved requires a known fork head different from
the review SHA. Main moved requires a ledger entry whose latest `after` differs
from the review base, no `current-head` reconciler alert, and an explicitly null
`promotionPending`. It applies even when core reports `stale: false`; Approve,
Promote and Return are hidden. Out of date requires `stale: true`. If main movement
cannot be proven and the review is non-stale, its normal state stays visible.
Approval binding and server checks still govern owner writes.

All receipt surfaces format durations below one second in whole milliseconds
(for example `227 ms`); values from one second retain the existing format.
Synthetic fixture projects include `review-main-moved` (the non-stale approved
photo-finish loser), `review-main-moved-stale`, `review-out-of-date`, and stale and
non-stale reconciler/pending-promotion variants. Open their detail at
`#review/review-1` or queue at `#review`. These fixtures establish offline rendering
only. Design PASS and independent code acceptance remain external handback gates.

## FH-049 collision resolution (FH-048 integrated; final acceptance pending)

Owner-only `POST /projects/:id/blockers/:bid/resolve` sends `{reason}` (1–200 characters, with non-whitespace content) through the same-origin session. Agents have no control or request. The dialog shows paths and editable secondary quick-reason buttons in a wrapping row, supports Cmd/Ctrl+Enter, and refreshes authoritative state after success or uncertainty without retrying a write. A repeat uses the returned resolution cause. The resolution record supplies the audit history; no activity event is assumed.

Resolved collisions remain as quiet rows in packet details and matching pushing-fork review details, excluded from counts, gates and Needs you. FH-048 review detail retains its claimant-packet filter; pushing-fork gates and history derive from all `/state.blockers`. Snapshot blockers survive an omitted detail list; a refreshed snapshot wins over stale detail resolution. Needs you opens and focuses the collision; success returns focus to Collisions and offers Open review in a 10-second toast and once on the newest resolved history row while the pushing packet has a current review. Legacy push times are never synthesized.

The `collision-*` scenarios are local contract fixtures, including history, 404, generic failure and claim-release/promote races. They provide no live core or Cloudflare acceptance.

## Recorded races (FH-055)

Race packets open a read-only full-width page at `#race/<packet>` in either host.
The track is a semantic table and becomes stacked lanes below 640px. It shows only
recorded milestones in claim order (equal timestamps sort by agent): Claimed, First push, Review requested, Checks
passed, Approved, Promoted. The shared race clock starts at the earliest claim;
there is no running timer or estimated progress. Results use core's recorded places.

The optional FH-052/053 projection carries `races`, agent enrollment `createdAt`,
and `ledgerEntryId` (the exact string `ledger[].id`). Legacy agents are numbered
alphabetically first, then enrolled agents by `createdAt`; response order never
assigns identity. Fixture race, enrollment, ledger and review slices are checked
against the core public types, including recorded `places` and quick receipts.
The reviewed `race-silk-*`, `race-cloth-ink`, and
`race-hurdle-ink` values live in `src/host-tokens.json`, with identity always carried
by the number. Missing ledger evidence or activity counts are omitted.

Results counts only default-branch pushes recorded on each entrant's fork from its
claim through its closure, the race finish, or the current time. It shares
the fork graph's packet interval filter. If the oldest loaded activity is later
than any entrant's claim, Results omits Pushes rather than showing a partial count.
`race-reused-forks` exercises historical fork totals of 20 and 3 with one push each
inside the race; the Results counts are 1 and 1.

The race view uses the accepted FH-057 `LaneRunner`, `LaneMarker`, `LaneConnector`
and enrollment identity helpers from `src/lane.tsx`. Marker shapes and silk styling
are shared with the fork graph; race-specific CSS only places them in the track.

The offline fixture harness includes `race-open`, `race-finished`, `race-photo`,
`race-empty`, `race-loading`, `race-error`, `race-unknown`, `race-standard`, and
`race-advisory`. Open `fixtures.html?scenario=race-photo#race/race-01` for the recorded
rejection panel, or `?scenario=race-open#work`, `#review`, and `#overview` for its
Work badge, Promote warning, and Needs you copy. These snapshots are synthetic;
they do not establish live race, deployment, or owner acceptance.

### Forks on Overview (FH-057)

The read-only hero projects `/state` into a clock-time graph above Needs you. It uses
live claims, loaded push activity, reviews and their current receipt summaries, and
ledger `recordedAt` times. Optional FH-052/053 races appear only when supplied.
Dense events fold at the measured plot width; their tooltips and the always-accessible
table retain the recorded facts. Below 640px only the table renders. The graph caps
at eight lanes with in-place expansion, a 24-hour maximum default window, guarded
viewer disclosure storage, and reduced-motion support.

`src/lane.tsx` owns the shared primitives for FH-055 and FH-057:
`LaneRunner({entrant, state})`, `laneSilkStyle(state, agent)`, `saddlecloth(state, agent)`,
`Saddlecloth({identity})`, `LaneMarker({kind})`, `LaneLine({path})` (SVG), and
`LaneConnector({reached})` (decorative race-table connector). Marker kinds include
`unreached`, `reached`, `claim`, `push`, `review`, `passed`, `failed`, `approved`, and
`promoted`. `agentIdentities(agents)` ranks legacy agents alphabetically before
agents ordered by enrollment timestamp, with alphabetical tie-breaking. The number
always accompanies the repeating `race-silk-1/2/3` colors. Unknown agents get no
invented number. Both `--lane-silk` and FH-055's `--entrant-silk` are supported.

Missing history stays missing: a promoted lane without its claim uses its earliest
loaded event and an open stub, with no invented branch junction. Standard review
approval timestamps and released standard claims are not exposed by the current
core snapshot. Approval marks render only if a recorded `approvedAt` is supplied;
the Approved state word remains available without a timestamp. Race release and
approval times come from recorded entrant fields. Earlier push history is explicitly
labeled when the loaded activity cannot cover a claim's start.

Fixture scenarios: `fork-hero`, `fork-resolved`, `fork-old`, `fork-many`, `fork-empty`,
`fork-dense`, and `fork-live` on `fixtures.html?scenario=…`. The live scenario has a
**Fixture new push** control that appends a synthetic push and invalidates the
snapshot through the normal read path. These routes and controls never ship in
production assets. Captures prove fixture rendering only; reserved root tests,
worker-host integration, fresh-clone/D5 checks, and design/code sign-off remain
separate acceptance gates.

### Fork graph bundle fixes (FH-057b)

The shared graph carries its closed-table hiding styles in the component as well as
in CSS, so an older host stylesheet cannot reveal the accessibility twin. Closed
cell controls leave keyboard tab order; opening the disclosure restores them.
Unloaded starts use a dashed lead-in with a recorded-start tooltip. Main SHA labels
reserve space for the newest promotion first, then fit older labels into the remaining
space. Every event cell shows its three newest events, with `+n earlier` exposing the
omitted facts on focus or hover.

For offline bundle verification, build the dashboard and gatekeeper sidebar assets,
then open `gatekeeper-fixtures.html?bundle=owner&scenario=fork-hero` or
`gatekeeper-fixtures.html?scenario=fork-hero` on the dashboard fixture server.
The owner route uses the built production entry and CSS against the local fixture API;
the gatekeeper route loads its built self-contained sidebar in an opaque-origin frame
with a synthetic host capability. Light/dark controls use the app theme path.
`fork-history` exercises dense main labels and capped cells. These harnesses are excluded
from production assets and prove offline bundle behavior only.
