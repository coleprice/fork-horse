# FH-065b integration checkpoint

Status: production wiring implemented and focused checks pass. Acceptance remains
open; this is not approval to merge or deploy.

Accepted Stable dependency: `5fb494946ddabe0a732daf5a1b668a677c7970a7`.
Plain merge: `4a13b72a61a3d33897cfd8c8dc940b199c07fc5e`, parents
`b6a5a09c0a216ede0ab173821051d430a61a5acb` and the accepted dependency.
No newer main was merged. Task-owned changes remain in this package.

## Implemented

- The production fork session exposes context, join, claim, release, requestReview,
  readReview and readReceipts. It consumes the accepted Stable records and
  stored-key credential provider. Every HTTP request obtains its bearer through
  that provider, with account generation checks around asynchronous work.
- Context combines core state and authenticated work. Receipt reads project the
  agent-visible review summary, never the owner-only receipt log route.
- Join requests a 60-second grant and discards its entire token-bearing response.
  No Git token is returned, persisted in an action, or included in an error.
- Writes persist their intent before queue submission and reauthorize at apply.
  Interrupted submissions reuse the same action ID. Once an external request is
  sent, uncertain outcomes remain fenced to prevent duplicate forks or reviews.
  Automatic reconciliation is not implemented.
- Claim, race entry, join, push, request review and release each have an eligible
  action kind. Core packet mode selects claim versus race entry and is checked
  again at apply. Only the OS's user-controlled per-kind rules decide approval.
- Push and workflow writes share one serial queue and action counter. Unresolved
  writes block further writes; existing queued pushes retain their dispatcher.
- Code Mode declarations compose the accepted Stable source with both session
  interfaces. Resource descriptions and the picker use the accepted address
  helper. Account cards show the verified agent, and Ask an agent prefills the
  concrete contribution workflow.

## Focused evidence

The native workerd tests exercise production gatekeeper/account RPC and real
Durable Object storage against mocked core HTTP. They verify provider bearer
use, each verb's route/body, join TTL and token containment, observation calls,
separate action kinds, claim/race classification, pending-action conflicts,
revocation, lost queue replies and uncertain external outcomes. These are local
fixture results, not live core, Cloudflare OS or Artifacts acceptance.

Successful commands:

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --dir cloudflare-os install --frozen-lockfile` — exit 0.
- `pnpm --filter forkhorse-gatekeeper test` — exit 0; 19 Node tests and 42
  workerd tests across 6 files pass. Existing negative native RPC rejection/hang
  diagnostics remain in output; passing tests do not assert clean runtime logs.
- `pnpm exec vp lint packages/forkhorse-gatekeeper` — exit 0.
- `pnpm --filter forkhorse-gatekeeper build` — exit 0, including both typechecks,
  the production Worker and three self-contained frame checks. Existing mixed
  JSON import-attribute warning remains.

The focused commands use `pnpm_config_verify_deps_before_run=false` after the
frozen installation to avoid an environment-specific dependency-store recheck.
The native runtime suite caught and verified the correction of an iterator
assumption that the earlier Map fixture did not expose.

## Open gates

1. Confirm the queued-result adapter contract. OS `submitAction()` acknowledges
   submission before approval; workflow writes return `Promise<void>` and set
   `awaitDecision: true`, matching push. After approval the agent reads context.
   Stable's public response types describe applied core results; this adapter
   never invents a result while approval is pending. The contract question is
   routed to the coordinating reviewer.
2. Review the intentional uncertainty fence: context remains readable, but an
   ambiguous external write requires operator reconciliation before further
   writes on the resource. No automatic retry or clearing capability is exposed.
3. Root `pnpm test`, root `pnpm lint`, fresh-clone acceptance and D5 remain held
   pending the serialized heavy-check lane.
4. Visible copy requires the designated copy reviewer's PASS. The live Cloudflare
   OS builder loop requires separate acceptance through the enrolled demo agent.

The assigned live packet and original fork are retained for publication. No
second join or review request is needed for this checkpoint. No core or upstream
changes, live OS rule changes, canonical write, or deployment are included.
