# FH-065b integration checkpoint

Status: production wiring and context reconciliation implemented. Acceptance
remains open; this is not approval to merge or deploy.

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
  sent, fresh context reconciles natural evidence against stored intent. Applied
  outcomes clear the fence; confirmed absence permits one retry; ambiguity or
  exhausted retries retain the fence. Join requires one new agent fork, and push
  requires the exact approved head. Reads never resend writes.
- Claim, race entry, join, push, request review and release each have an eligible
  action kind. Core packet mode selects claim versus race entry and is checked
  again at apply. Only the OS's user-controlled per-kind rules decide approval.
- Push and workflow writes share one serial queue and action counter. Unresolved
  writes block further writes; existing queued pushes retain their dispatcher.
- Code Mode declarations compose the accepted Stable source with both session
  interfaces. Resource descriptions and the picker use the accepted address
  helper. Account cards show the verified agent, and Ask an agent prefills the
  concrete contribution workflow. Human approvals use seven-character commits
  while payloads keep full SHAs; join/race copy names the actual agent.

## Focused evidence

The native workerd tests exercise production gatekeeper/account RPC and real
Durable Object storage against mocked core HTTP. They verify provider bearer
use, each verb's route/body, join TTL and token containment, observation calls,
separate action kinds, claim/race classification, pending-action conflicts,
revocation, lost queue replies, all six reconciliation kinds, bounded retries,
missing/ambiguous evidence and serialization against in-flight writes. These are local
fixture results, not live core, Cloudflare OS or Artifacts acceptance.

Successful commands:

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --dir cloudflare-os install --frozen-lockfile` — exit 0.
- `pnpm --filter forkhorse-gatekeeper test` — exit 0; 19 Node tests and 57
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

1. The v0 queued-result adapter contract is confirmed: workflow writes return
   `Promise<void>` with `awaitDecision: true`, then context supplies the applied
   result. Stable's applied-result interfaces are unchanged.
2. Root test/lint, fresh-clone acceptance and D5 are assigned to the operator's
   fresh-clone review; this builder is explicitly exempt from those heavy suites.
3. The designated copy reviewer must recheck the requested string-only diff.
4. The live Cloudflare OS builder loop follows operator merge and deployment.
   Local mocked HTTP/workerd evidence does not satisfy that gate.

The assigned live packet and original fork are retained for publication and
review. No second join, core or upstream changes, live OS rule changes, canonical
write, or deployment are included.
