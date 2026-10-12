# Gatekeeper sidebar preparation

**Partial FH-008 implementation; local UI fixtures and disabled deployment wiring.** This package prepares the
read-only sidebar using the accepted dashboard's `mountDashboard`, stylesheet,
and `DashboardTransport` embedding seam. No dashboard source is copied or edited.
Product branding comes from root `brand.json`.

## What is available

- `pnpm --filter forkhorse-gatekeeper build` creates `dist/sidebar.html`: one
  self-contained iframe document with inline JavaScript/CSS and no external asset
  URLs. The production build graph excludes fixture endpoints and fixture data.
- The iframe uses the pinned OS private MessagePort handshake, `host.ui`, and
  `host.openPrompt`. “Ask an agent” prefills a project-specific prompt; it does not
  submit it or grant agent authority.
- `SidebarUi` is a read-only, single-project capability: `snapshot()`,
  `subscribe(receiver)`, and `waitForChanges(after)`. Full snapshots carry a
  monotonically increasing UI-session version, independently of activity sequence.
- `SnapshotFeed` coalesces bursts at 250ms and retains only the latest pending
  snapshot for a slow receiver. One receiver and one pending long poll per feed
  bound memory/concurrency. Long polls expire after 25 seconds. A client falls back
  to polling when subscription setup fails or pushes go silent for 30 seconds.
- Push takes two inbound calls at startup and no per-batch refresh calls. The
  polling path takes about 240 calls/minute at four batches/second, plus startup.
  Both fit the pinned app limits: 8 concurrent, 600/minute, 128 pending. The
  dashboard's state/activity reads use the current batch locally.
- Approve/Promote are disabled with an explicit reason and intercepted before
  dashboard dispatch. The transport independently rejects them without any RPC.
  No owner token is accepted, reused, exposed, or inferred from an OS admin flag.

## Remaining integration gates

There is deliberately no deployable Worker entrypoint, connected account, fork grant,
Git transport, or claimed live data source yet. A Worker-native read-only UI
capability and a draft-only credential form are prepared and tested. D6 requires
waiting for **FH-013 acceptance**, after FH-012, before implementing Git transport
or S7/S9. FH-013 supplies authenticated caller identity, existing-fork short-lived
tokens, revocation and audit; no Git proxy is planned. At the packet baseline, `/join` creates a
new fork and returns a short-lived token; `/state` supplies fork heads but neither
an authenticated actor nor an existing-fork credential renewal/proxy. Those gaps
cannot be fixed in this package's allowed paths.

After FH-013 acceptance, the account can reuse `sidebarAccountDescription()` for
`providesUi` branding and `createSidebarFrame(source, html)` in `startAppUi()`.
`src/worker/sidebar.ts` uses Worker-native RPC targets and runtime validation;
`source` remains an unwired trusted-host interface. It authorizes before initial
reads, snapshots, callbacks and final long-poll delivery, rejects cross-project
updates and stops its source when revoked or disposed. Keep the publishing side of
`SnapshotFeed` private to that trusted host. The browser receives only `SidebarUi`,
never the feed, credentials, or a caller-selectable project. Bind lifetime cleanup
to the account/UI session and stop polling on revocation. `test/fixture-ui.ts` is a browser/Node fixture RPC endpoint; the workerd harness
exercises the actual Worker-native capability through a service binding. Neither
is an authenticated account implementation.

The accepted dashboard currently has no read-only option. This host uses its
documented transport seam, rejects writes there, and disables its stable
`data-action` owner buttons after each render. It also labels the connection as an
agent session and hides project switching because this capability is bound to one
project. Capture-phase interception closes
the gap before the DOM observer runs. DOM tests guard those selectors. A future
dashboard-owned read-only option can replace this adapter when separately scoped.

FH-012 is merged. The optional `forkhorseGatekeeper` template block now wires a
private Worker through `GATEKEEPER_FORKHORSE`: the router uses its default HTTP
handler and the Workshop uses its `GatekeeperVendor` RPC entrypoint. The Worker is
built and deployed before the Workshop/router and has no public route, preview URL,
core service binding, storage or secrets. The template remains disabled by default.

The wiring-only vendor derives its description from `brand.json`, advertises no
authentication or auto-provisioning, returns no resources/types, and refuses every
connection attempt. Its HTTP handler returns uncached 503 responses without cookies
or redirects. It does not complete or retain connection callbacks. Account creation
and the real sidebar source remain held for FH-013; enabling wiring cannot grant
an account. No core, dashboard, upstream source or gitlink is edited by FH-008. S7 and S9 require the completed gatekeeper in pinned local `run-local`;
the checks below do not satisfy those acceptance scenarios. Live installation is
a separate reviewed step.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm --dir cloudflare-os install --frozen-lockfile
pnpm --filter forkhorse-gatekeeper test
pnpm --filter forkhorse-gatekeeper types:check
pnpm --filter forkhorse-gatekeeper build
pnpm test
pnpm lint
pnpm --filter forkhorse-gatekeeper dev:fixture
```

Open the printed loopback address for the visibly labeled fixture host. It embeds
the built document in a `sandbox="allow-scripts"` frame and marks that document as
a fixture. It sends simulated batches through MessagePort RPC and the actual
pinned OS rate limiter.
Its prompt receiver displays the text locally; it cannot open a real OS chat.

Unit tests use virtual time for 240 quarter-second batches, real MessagePort RPC,
and the unmodified pinned limiter. They cover push, fallback, coalescing, slow
receivers, polling bounds, project isolation, read-only controls and prompt
dispatch. Root/upstream install separate Cap'n Web copies; a test-only Node loader
unifies their runtime identity. Vite's `dedupe` does the same in the fixture bundle.
The production iframe contains one bundled runtime.

Only this package's lockfile importer is added; every dependency/snapshot already
exists in the frozen lockfile.

## D6 configurator preparation and D7 runtime coverage

`dist/configurator.html` is a second self-contained frame using the pinned resource
configurator handshake. It always reports selection not ready and refuses
`collectResourceUrl()`. The form checks origin/project/credential syntax only,
clears the credential field on success or failure, never saves or returns the
credential, and cannot enable Create connection. It is labeled for synthetic
fixture values only. `/configurator.html` on the loopback fixture server embeds
the actual built frame. The local check uses a button event because the OS sandbox
permits scripts without permitting form submission.

`pnpm test` includes both `test:node` and `test:workerd`. The workerd configuration
uses the pinned runtime sentinel (`navigator.userAgent === "Cloudflare-Workers"`)
and the validation transform with `tsconfig.worker.json`. Nine Node tests cover
browser behavior, data budgets and draft handling; eleven application workerd tests cover native
RPC callbacks, source authorization/revocation/disposal, polling, metadata, and
credential-free configurator results.

**Runtime diagnostic:** rejected native calls log expected exceptions. A retained
plain `RpcTarget` control also reproduces the hung-request cancellation without
running sidebar/feed/validation code: the caller receives the expected rejection,
then successfully calls `ping()`, and observes the disposal hook after release.
Run `pnpm exec vitest run __tests__/native-rpc.test.ts` in this package to reproduce
both controls. The underlying runtime cause remains unproven; this evidence does
not replace full OS acceptance after FH-013. Logs are not filtered or suppressed.
