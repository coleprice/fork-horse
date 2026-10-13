# FH-065b offline checkpoint

Status: incomplete; not ready for review, merge, or deployment.

Base: `ef4d2d6e11e4c018cb828a6ed5b38e6ba21bfe18`.
Branch: `fh/FH-065b-gatekeeper-calls`.

## Implemented locally

- A credential-free `WorkflowSource` and transport seam, a typed native
  `WorkflowSession` exposing the five named calls, and an approval-only
  controller exercised by workerd fixtures with real Durable Object storage. It is deliberately not wired into
  the production account: FH-065a's accepted provider is required first.
- Existing core route mappings: `GET /state` plus authenticated `/me` work for
  context; `POST /join` with the verified agent and `ttlSeconds: 60`;
  `POST /packets/:packet/claim`; `POST /reviews`; and
  `DELETE /packets/:packet/claim`. Writes return no response body, including
  join's token-bearing result.
- Queued writes persist intent before queue submission, keep the same action ID
  after a lost queue reply, reauthorize at apply, and never resend an ambiguous
  join/review after the external-call boundary. Ambiguous external outcomes
  remain fenced for inspection; automatic reconciliation is not implemented.
- Account display names include the verified agent name.
- The sidebar prompt describes context, attachment, claim/join, approval waits,
  edit/check/commit/push, and exact-commit review. This copy is staged for the
  completed workflow and must not ship before the methods are wired.

## Evidence and limits

All new workflow evidence is local fixture evidence, not live service acceptance.
The fixture transport has no credentials or network access. Existing vendor tests
continue to verify the existing bearer path, but do not prove the new provider
integration. New tests check each route/body, no writes before apply, 60-second
join TTL, no token returned/stored/logged, lost queue replies, ambiguous writes,
denial, revocation, conflicting actions, and malformed inputs.

Successful commands:

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm --dir cloudflare-os install --frozen-lockfile` — exit 0.
- `pnpm --filter forkhorse-gatekeeper types:check` — exit 0.
- `pnpm --filter forkhorse-gatekeeper test` — exit 0; 19 Node tests and 37 workerd
  tests pass, including the native workflow fixture. A focused
  `pnpm --filter forkhorse-gatekeeper exec vitest run __tests__/workflow-native.test.ts __tests__/workflow.test.ts`
  run also passes all 14 tests. Existing native RPC rejection/hang diagnostics remain in output;
  passing tests do not assert a clean runtime log.
- `pnpm exec vp lint packages/forkhorse-gatekeeper` — exit 0.
- `pnpm --filter forkhorse-gatekeeper build` — exit 0; production bundle and three
  self-contained frames verified. Existing mixed JSON import-attribute warning
  remains; the checkpoint workflow seam is not included in the production graph.

Initial checks hit setup/sandbox failures: missing submodule dependencies and
localhost listener `EPERM`. Frozen dependency installation and local listener
access resolved those. Directly importing core's `StateSnapshot` also pulled
unrelated Worker globals into this Worker; the temporary seam therefore preserves
opaque state fields and caller work until FH-065a supplies standalone public types.

## Required next steps

1. Live route is provisioned: `fh-065b` is claimed on `forkhorse--codex-9`.
   Joined exactly once with a 60-second token, then claimed that explicit fork.
   Keep this fork for continuation; refresh only this fork. No review is requested
   while the dependency and acceptance gates remain open.
2. Obtain the accepted FH-065a head and concrete public contract. Merge accepted
   main normally, without rebasing or copying an unaccepted feature branch.
3. Replace the temporary transport/context seam with the accepted provider and
   public types. Wire the controller into `ForkGatekeeper` using its shared
   serial queue and action counter; dispatch workflow apply/reject separately
   from push. Compose the typed workflow session into the existing fork session
   and publish the combined self-contained Code Mode types.
4. Use the accepted fork-address helper for resource descriptions and picker
   addresses. Test the configured exact address without hardcoding deployment
   values. Add actual provider bearer assertions for every workflow call.
5. Keep writes approval-queued unless the owner explicitly changes the policy.
   Add native RPC coverage for the wired methods and prevent push/workflow
   pending-action conflicts. Review ambiguous-operation recovery before shipping.
6. Obtain the serialized heavy-check slot: root `pnpm test`, root `pnpm lint`,
   fresh-clone suite, and D5 were not run because the slot was not granted.
7. `readReceipts` needs contract resolution: accepted core full receipt reads
   are owner-only, while agent review detail includes a summary. No owner
   credential or new core route may be inferred. The five required packet calls
   remain the scope of this checkpoint.
8. Obtain Saddler's PASS for visible copy and live authorization for the full
   Cloudflare OS builder loop. Neither visual acceptance nor live push is proven.

No core edits, submodule edits/pin changes, owner operations,
Cloudflare deployment, board edits, alternate publication, or hidden agents.
