# FH-008 WIP checkpoint

Status: **in progress; not for review or merge**. Authenticated agent accounts,
owned-fork Git resources, approval-gated pushes and the read-only sidebar are
implemented. Deployment integration with accepted FH-016 remains outstanding.

## Provenance and scope

- Branch: `fh/FH-008-gatekeeper`.
- Published checkpoints `4ed940969e1e3a6f48cbc6a1c35326f7665b443e` and
  `53bf918b14cb9dc7d95e9483efb28d2b40da7c1f` are preserved.
- Accepted FH-013 `2b19a4f06c3f7b9e03ec0ebd193d43b997241eeb` was integrated by
  normal merge `e99c96d`.
- Upstream remains pinned, unmodified, at
  `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`.
- This checkpoint covers the package and its lockfile importer. Earlier uncommitted
  deployment changes remain outside this checkpoint while FH-016 owns tooling.
- No core/dashboard/upstream/board changes, live owner configuration, Cloudflare
  operations, real credentials, inference or deployment are part of this work.

## Implementation

- `src/worker/account.ts`, `index.ts`: private credential DO, authenticated native
  account, single-use connection handoff, staged reconnect, generation-based local
  revocation, owned-fork discovery/picker and account UI.
- `src/worker/core-client.ts`: authenticated `/me`, dashboard projection of `/state`,
  scoped 60-second tokens, bounded responses/timeouts, no redirects and git UA.
- `src/worker/fork.ts`, `src/fork-types.*`: observed/advertised heads, approval queue,
  action-scoped pack building, fast-forward checks, exact old-SHA CAS and no force.
- `src/feed.ts`, `client.ts`, `mount.ts`, `worker/sidebar.ts`: bounded subscription
  and fallback, source authorization/disposal, dashboard reuse, iframe-local section
  navigation and actual host prompt dispatch. Owner actions remain unavailable.
- `app/picker.ts`: owned-fork selection with initial-resource support. The existing
  draft-only configurator is retained as a fixture, separately from real connection.
- Build/runtime configuration: three inline frames, bundled Worker, native runtime
  validation and credential/fork Durable Object migrations.

## Local evidence

1. The package suite covers 10 Node tests and 19 workerd tests. The latter includes
   account connection/reconnect/revocation, owner and foreign-agent denial, scoped
   discovery, dashboard state projection, no pre-approval token minting, fast-forward
   and stale-head rejection, idempotent application, Git protocol and redirect denial.
2. `pnpm --filter forkhorse-gatekeeper test:local` passed with the unchanged pinned
   OS kernel and real local Git. It exercised native account and gatekeeper
   capabilities, `getHead`, actual `createWorktree`, edit/commit/barrier, native OS
   approval and action-scoped pack/CAS push. Before approval the remote stayed at
   its original SHA; after approval the remote contained the expected file. A real
   concurrent receive-pack ref update was rejected and its OS action stayed pending.
   The printed receipt reported one pull and one successful push before the CAS race.
   This is kernel acceptance in workerd, not that scenario inside the full run-local
   server process. Core enrollment and tokens were synthetic.
3. A browser harness using the actual pinned OS host component and default limiter
   displayed 598 synthetic batches over 150 seconds. Counters stayed at one snapshot,
   one subscription and zero polls; no browser errors/warnings appeared. Ask an agent
   used the actual host prompt/router path.
4. An isolated archive of the exact upstream pin ran its unchanged `pnpm run-local`
   entrypoint with a fresh local HOME and no owner credentials. Package installation
   fetched registry dependencies; this was not a network-free bootstrap. Only a new
   test gatekeeper extension was added to that disposable copy. Its offline Worker
   refused external Core/Git traffic and labeled all state synthetic.
5. Full OS synthetic account connection and handoff redemption succeeded through
   the real OS APIs. Browser form submission succeeded with the correct same-origin
   policy. Automated browser access could not adopt the OS-created popup, so the
   complete popup UX remains unverified; API handoff evidence does not substitute
   for that UX. Reloading the pinned OS after account connection populated its app
   navigation. No AI model was configured and no prompt was sent.
6. Full OS sidebar testing caught and fixed two integration issues: projecting the
   raw Core state before rendering, and preventing srcdoc hash links from navigating
   to the parent OS route. The rebuilt frame stayed active across section navigation
   and advanced 298 synthetic quarter-second batches over 74.6 seconds. Ask an agent
   opened the actual Home composer with the expected project prompt. The native
   resource picker listed the connected agent's fork, enabled Add connection only
   after selection and added that fork to the composer. No message was sent; the
   browser reported no errors.

## Checkpoint validation

| Command | Result |
| --- | --- |
| `pnpm --filter forkhorse-gatekeeper build` | Exit 0; types, inline frames and production fixture-exclusion checks passed. |
| `pnpm test` | Exit 0; repository suites including 10 package Node tests and 19 package workerd tests passed. |
| `pnpm lint` | Exit 0; lint, script types and workspace builds passed. |
| `pnpm --filter forkhorse-gatekeeper test:local` | Exit 0; pinned kernel, real Git approval/CAS evidence described above. |
| Pinned `wrangler deploy --dry-run` with synthetic config | Exit 0; all networking denied, fresh HOME, no owner config or credentials. |
| `git diff --check` | Exit 0. |

Only three lockfile lines were added for the gatekeeper-kit dependency in this
package's importer. Upstream source and its gitlink remained unchanged.

Negative native RPC diagnostics remain visible. A plain returned RpcTarget in the
Vitest pool reproduces the hung-request warning, yet the expected rejection, later
ping and disposal assertions pass. A standalone Miniflare version passes without
the warning. The successful native kernel Git flow also completes without it. This
narrows the issue but does not prove a root cause.

## Remaining gates

- Integrate latest accepted main and FH-016 with normal merges, preserving published
  checkpoints. Then replace the starter sample in deployment order and bindings
  with `GATEKEEPER_FORKHORSE`, so admin has exactly one branded row. Keeping the
  sample package is allowed. Do not edit tooling concurrently with FH-016.
- Finish exact S7/S9 acceptance against the packet: kernel S7 evidence is strong,
  but the same Git scenario has not run inside the full run-local server process.
  Complete popup UX remains distinct from the verified API handoff and sidebar.
- A crash during approval preparation can leave a preparing action requiring
  recovery; final review must assess this state transition before acceptance.
- Pinned OS app discovery currently needs a reload after the manually completed
  connection. The dashboard adapter relies on the accepted dashboard's selectors;
  those assumptions are covered by tests.
- Live Core/Artifacts, owner installation, deployment and production acceptance
  remain unperformed and separately gated. No canonical push or promotion is exposed.

WIP publication is authorized. This checkpoint does not request review, merge,
publication of owner configuration or live operations.
