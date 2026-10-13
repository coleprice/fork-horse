# Shared contribution primitives

Pure TypeScript with no runtime dependencies or import-time I/O. Nothing consumes
this package yet. It contains the v0 contribution contract, the address helper,
and the connected-account credential provider. V1 names are reserved only.

## Address

`forkAddress({ origin, project, repoName })` returns
`<origin>/projects/<project>/forks/<repoName>`. Pass the canonical HTTPS origin from
the connected account; no product domain is hardcoded. Project IDs follow core's
lowercase slug grammar (48 characters maximum). Repository names must start with
that project and exactly one `--` delimiter, followed by a lowercase slug, within
the MCP repository-name limit of 128 characters. This validates address syntax;
it does not establish ownership or access.

## Credentials

`storedAgentKeyProvider(read)` creates a server-only `CredentialProvider`.
`read` reads the connected account's current `{coreOrigin, project,
agentCredential}` or returns null/undefined when disconnected. It may be async.
`getBearer({origin, project})` checks that destination against the stored account
and returns an Authorization header value for the HTTP layer only. Construction
does not read storage. Each call reads again, with no credential cache.

The provider has no serializable key property, logs nothing, and replaces storage
errors with a fixed message without a cause. Never export this capability through
an agent RPC, MCP response, UI, or log. The HTTP adapter must retain the existing
authorization checks, refuse redirects and check revocation when queued writes
apply and across in-flight calls. This provider does not implement leases,
revocation fencing, or an approval policy.

## Contribution contract

`contributionVerbs` lists `{name, status}` for every declared capability.
`ContributionContract`, `ContributionRequest<V>`, `ContributionResponse<V>` and
`ContributionApi` provide exact v0 request/response types. Public data records
are self-contained mirrors of core, checked for drift in the package tests;
core does not import this package.

| V0 verb | Existing core route | Public response |
| --- | --- | --- |
| `context` | `GET /projects/:project/state` plus `/me` | State plus `myWork` from `/me.work` |
| `join` | `POST /projects/:project/join` | Explicit join metadata, **no token** |
| `claim` | `POST /projects/:project/packets/:packet/claim` | Claim or race entrant, including normalized usage |
| `release` | `DELETE /projects/:project/packets/:packet/claim` | `{released: true}` for the authenticated agent |
| `requestReview` | `POST /projects/:project/reviews` | Public review of the exact `sha` |
| `readReview` | `GET /projects/:project/reviews/:review` | Public review, packet, changes, commits, promotion and blockers |
| `readReceipts` | Read the same review's `receipt` | `{receipt: ReceiptSummary \| null}`; no owner-only logs |

All requests name `project`. Fields in the path are explicit request fields;
remaining fields mirror the existing body. `join` accepts `agent` and optional
`ttlSeconds`; HTTP adapters should use 60 seconds for its discarded Git grant.
Its response must be built by selecting the declared fields: spreading core's
raw JSON would leak its token. The types do not perform runtime sanitization.
`claim` accepts `packet` and optional `repoName`, including core's race-entry path.
Core continues to authorize the caller, packet, fork and commit; naming an agent
or fork in a request never supplies authority. These are contracts, not routes
or an alternate authorization implementation.

`Review` omits core's private `receiptGeneration` and makes public normalization
of `receipt` and `usageAtReview` explicit. `readReview` includes the existing
`returned` reason/time. `readReceipts` must not call core's owner-only full-log
`/receipt` endpoint. Release has no owner override. Approval and promotion are
not contribution verbs; gatekeeper writes remain approval queued.

Reserved v1 names: `list_projects`, `start_work`, `resume_work`, `end_work`,
`read_tree`, `read_file`, `read_diff`, `run_checks`. They have `status: "v1"` and
no shapes in `ContributionContract`. In particular, v0 `join` is **not** an
idempotent work-session start. Submission remains in the existing Git transport;
this package does not add a submit adapter.

## Checks

From this workspace: `pnpm --filter forkhorse-stable test`,
`pnpm --filter forkhorse-stable types:check`, and
`pnpm --filter forkhorse-stable lint`. `build` also checks types so root build
includes this package. The existing `packages/*` workspace glob includes it.
Tests use offline fixtures and Node's test runner. This package is not a Worker
entrypoint; its eventual Worker consumers still require workerd acceptance.
The core compatibility test reads current core declaration source into a temporary
declaration-only project and type-checks `test/core-shapes.ts` against it. It uses
no committed core fixture and loads no Worker implementation. Core request fields
are checked against the existing MCP `CoreOperation` seam; read-review detail
fields mirror the JSON construction in core `workflow.ts` and `review-detail.ts`.
Root/fresh-clone/D5 checks remain separate acceptance requirements.
