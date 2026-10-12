# Agent fork gatekeeper

**FH-008 remains in progress.** This package connects an enrolled agent to its own
Git forks and embeds the accepted dashboard in the pinned OS. Product names come
from root `brand.json`. Core identity/token support from FH-013 is integrated;
FH-016 deployment integration and final acceptance remain pending.

## Account and Git authority

The private Worker implements the OS vendor, account and fork capabilities. Its
connection form accepts a public HTTPS Core origin, project and already-enrolled
agent credential. It checks `/me` and rejects owner credentials. A single-use,
ten-minute nonce and the pinned kit's handoff bind connection completion to the OS
user. Credentials remain in `UserAccount` Durable Object storage. Reconnection
stages credentials and retains the same origin, project and agent identity.

Discovery and the resource picker expose only that agent's forks. `getHead()`
records an observation and advertises the exact commit to the OS Git cache, so
`createWorktree()` can pull it through the pinned kit transport. `push()` accepts a
full commit ID on the default branch, requires a fast-forward, and queues an OS
approval action. Only applying that exact action builds its scoped pack and
performs a compare-and-swap push with the recorded old SHA. Changed heads fail;
there is no force push or history-rewriting revert. A successful push whose reply
was lost can be recognized by its exact new head.

Before each Git request the Worker rechecks ownership and requests a repo-scoped,
60-second read or write token. Raw Git HTTP uses a git-style User-Agent and refuses
redirects. Neither credentials nor tokens are returned to the browser or agent.
Canonical repository writes are outside this package. Disconnect deletes the local
connection and stops its capabilities; it does not revoke other clients' Core
credentials or all tokens for that repository. Already issued tokens expire.

## Sidebar and resource picker

`AgentAccount.startAppUi()` supplies the built sidebar and a read-only native RPC
capability. Core `/state` is projected through the accepted dashboard's `stateView`
and rendered by its unchanged `mountDashboard`. Authorization is checked before
reads and disclosures. Core polling has one request in flight and waits 250ms
between reads; snapshot publication coalesces at 250ms. Disposal/revocation stops
polling and releases subscribers.

The sidebar uses the pinned OS private MessagePort handshake, `host.ui` and
`host.openPrompt`. Ask an agent prefills a project-specific prompt without sending
it. Section links scroll within the srcdoc frame. Approve/Promote are disabled,
capture-blocked, and independently rejected by the transport. Project switching is
disabled because the capability is bound to one connection.

Push uses two inbound startup calls and no per-batch refresh calls. One receiver,
one latest pending snapshot and one long poll bound backlog. A silent/unsupported
push channel falls back to a 25-second long poll. Four updates per second fit the
pinned limits of 8 concurrent calls, 600/minute and 128 pending calls. These are
browser capability limits; Core authorization/state requests are separate traffic.

The resource picker lists owned forks, supports an owned initial selection, and
returns only the selected resource URL. The separate draft configurator remains a
clearly labeled fixture for format checks; it cannot establish a connection.

## Builds and checks

```sh
pnpm install --frozen-lockfile
pnpm --dir cloudflare-os install --frozen-lockfile
pnpm --filter forkhorse-gatekeeper build
pnpm --filter forkhorse-gatekeeper test
pnpm --filter forkhorse-gatekeeper test:local
pnpm test
pnpm lint
```

The build produces three self-contained HTML documents and `dist/worker.js`.
Bundle checks exclude the offline entrypoint and its synthetic credentials/data
from production. Worker types use native RPC validation. The production config has
no public Workers URL; the generated deployment supplies its private base URL and
Durable Object migrations. Only this package's lockfile importer is changed.

The suite includes browser/MessagePort tests and native workerd tests for account
lifecycle, ownership, approval, stale heads, Git transport and sidebar disposal.
`test:local` uses a temporary real bare Git repository, actual `git http-backend`,
the unchanged pinned OS kernel and a native workerd approval queue. It creates a
worktree from the advertised fork head, edits/commits, verifies that the remote does
not move before approval, applies the approval and verifies the remote file. It
also races a real ref update against receive-pack and verifies CAS rejection.
Core enrollment and tokens in this test are explicitly fixtures. The runner removes
its temporary repository and generated modules and never edits upstream source.

## Local browser acceptance and limits

- `dev:fixture` hosts a visibly synthetic sidebar/draft configurator.
- `dev:local-sidebar` uses the actual pinned `SandboxedGatekeeperApp` component,
  router and limiter with a synthetic feed. This is a component harness.
- `vite.run-local.config.ts` builds `dist/offline-worker.js` for a disposable copy
  of pinned upstream `run-local`. Its fixture entrypoint supplies only synthetic
  `/me` and `/state`, and refuses every other outbound request. It must never be
  deployed. Production tooling consumes `dist/worker.js` only.

The full local OS has also been exercised with a synthetic account, real OS
connection handoff and actual native account/sidebar capabilities. This remains
local fixture evidence, not live Core/Artifacts or installed owner acceptance.
See `HANDOFF.md` for exact coverage and outstanding gates.

Negative native RPC tests emit expected exceptions. A plain returned RpcTarget
control reproduces a hung-request warning in the Vitest worker pool while still
returning the rejection, responding to a later ping and disposing correctly. The
standalone Miniflare control and successful pinned-kernel Git acceptance do not
emit that warning. Logs remain unsuppressed; the underlying pool/runtime cause is
not proven.
