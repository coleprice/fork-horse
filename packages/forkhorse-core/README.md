# Project core Worker

An independent TypeScript Worker with one `Supervisor` Durable Object per project.
It creates a canonical Artifacts repository, issues agent forks, and records pushed
snapshot changes. The fixture suite runs in workerd via `@cloudflare/vitest-plugin`;
passing it is offline evidence, not proof of an installed or live deployment.

## HTTP contract

Every response is JSON with `Cache-Control: no-store`. Requests use
`Authorization: Bearer <token>`. The owner configures the lowercase SHA-256 hex
digest of a strong random owner credential as `OWNER_API_TOKEN_HASH`. An absent or
invalid hash fails closed. Agent credentials are separate random 256-bit API
tokens, generated at project creation, returned once, and persisted only as SHA-256
hashes. They authorize one enrolled agent in one project. The owner must distribute
these credentials privately. Do not include credentials in URLs or logs.

### Create a project

`POST /projects`, owner credential required:

```json
{
  "id": "demo",
  "requireReceipt": true,
  "agents": ["builder", "reviewer"],
  "sourceUrl": "https://git.idiot.tax/public/template.git"
}
```

`sourceUrl` is optional. Without it, the binding creates an empty canonical repo
with default branch `main`. With it, the binding imports the public HTTPS remote
and retains that remote's default branch. The example URL is fictional. Local
names, IP literals, URL credentials, query strings, fragments, and nonstandard
ports are rejected; the Artifacts service performs the public remote fetch. This
Worker passes no credentials or custom headers to an import.

Project IDs use lowercase letters, digits and single internal hyphens, at most 48
characters. Agent IDs follow the same grammar, at most 32 characters; each project
requires 1–50 unique agents. The canonical repo name is exactly the project ID.
The `--` delimiter is reserved for forks.

A `201` response contains:

```json
{
  "project": {
    "id": "demo",
    "namespace": "default",
    "repoName": "demo",
    "remote": "https://git.idiot.tax/default/demo.git",
    "defaultBranch": "main"
  },
  "agents": [{ "agent": "builder", "apiToken": "<returned-once-api-token>" }]
}
```

The response includes one credential for every requested agent (the shortened
example shows one). It contains no canonical Git token. Artifacts create/import
necessarily returns an initial token internally; the Worker immediately revokes
it before committing the project or responding. This package never mints a
canonical write token for a caller.

A repeated ID returns `409`. A durable creation-intent marker fences an uncertain
provider outcome: if create/import or token revocation fails, retries return `409`
and require owner inspection. The Worker never adopts an existing unverified repo.
Additional enrollment and credential rotation are owner-only routes described below.
Save one-time credentials before distributing them.

### Join with an agent fork

`POST /projects/:id/join`, the matching agent's credential or the owner's:

```json
{ "agent": "builder", "ttlSeconds": 3600 }
```

`ttlSeconds` defaults to 3600 and must be an integer from 60 to 3600. A successful
`201` response contains `project`, `agent`, `repoName`, `remote`, `token`, `scope`
(`write`), `expiresAt` (ISO timestamp), and `ttlSeconds`.

Each request creates a fresh fork named `<project>--<agent>-<n>`. The supervisor
serializes requests and reserves the number durably before calling Artifacts.
Failures can leave gaps or orphaned forks; retries never reuse a fork name. The
fork's initial provider token is revoked, then a new fork-scoped write token is
minted with the requested TTL. Only enrolled agents may join; an agent credential
cannot select another agent. The canonical write credential is confined to the owner-only promote path.

### Read activity

`GET /projects/:id/activity?after=0&limit=100`, owner or any enrolled project agent:

```json
{
  "activity": [{
    "sequence": 1,
    "namespace": "default",
    "repoName": "demo--builder-1",
    "agent": "builder",
    "ref": "refs/heads/main",
    "before": "<40-character-sha1>",
    "after": "<40-character-sha1>",
    "changedPaths": ["src/index.ts"],
    "changedPathCount": 1,
    "changedPathsTruncated": false,
    "eventTimestamp": "2026-10-11T12:00:00.000Z",
    "recordedAt": "2026-10-11T12:00:01.000Z"
  }],
  "nextAfter": 1
}
```

Canonical pushes have `agent: null`. Entries are ordered by durable receive
sequence, not by provider timestamp. `after` is exclusive; use `nextAfter` for the
next page. `limit` is 1–100 (default 100); an empty page retains the supplied cursor.
The log and idempotency records persist without a retention cutoff in this version.

`changedPaths` contains at most the first 50 paths from the sorted full diff.
`changedPathCount` is the total number of changed paths; `changedPathsTruncated`
is true only when that total exceeds 50. New entries are stored with this cap.
Both `/activity` and `/state` (including MCP reads through them) cap legacy entries
on read without rewriting storage and preserve existing totals. Blocker detection
uses the full diff before the activity cap; blocker `paths` are unchanged.

Errors have `{ "error": "..." }`: `400` invalid input, `401` missing/malformed
bearer token, `403` unauthorized token/agent, `404` unknown route/project, `405`
unsupported method, `409` conflicts/stale approvals/uncertain operations, `413` oversized bodies, and
`502` sanitized provider failure. Authorization happens before repo operations.

Unexpected failures keep the same public message and add a UUID `diagnosticId`.
One JSON `core.error` log line carries that ID, a static operation label, the
known promote stage, and validated error name/code and HTTP status when present.
Name/code values must match `[A-Za-z0-9_.-]{1,64}`; messages, stacks, URLs,
headers, tokens and response bodies are excluded. `HttpError` responses are unchanged.

## Queue and changed paths

Connect a Cloudflare event subscription for `cf.artifacts.repo.pushed` to a Queue
consumed by this Worker. Provision the Queue and subscription through the owner's
deployment configuration; no live resources are created by this package or its
tests. Set a dead-letter queue and retry limit so permanent failures are inspectable.
`ARTIFACTS_NAMESPACE` must match the namespace in the `ARTIFACTS` binding.

The consumer uses `source.namespace`, `source.repoName`, `payload.ref`,
`payload.before`, `payload.after`, and `metadata.eventTimestamp` from the documented
envelope. Other events, namespace mismatches and unknown repositories are acknowledged without
a log entry. Ref deletions compare the previous tree with an empty tree; canonical
deletions also raise reconciler alerts. A matching naming
prefix alone does not establish membership: the supervisor checks its stored
canonical/fork registry.

Fork activity uses `(namespace, repoName, ref, after)` for idempotency. Canonical
events additionally include `before` and the event timestamp so later moves back
to previously seen SHAs remain visible. Keys are hashed for bounded storage. The complete activity entry and key are committed atomically.
Duplicate and concurrent deliveries produce one record. `readCommit`/`readTree`
compare the before and after snapshots recursively; new refs compare against an
empty tree. Changes include additions, removals, mode changes, symlinks and submodule
references; renames appear as removed and added paths. Force pushes need no ancestry
assumption. No blob reads or Git tokens are needed for the diff.

Missing commits/trees, provider failures, and storage failures retry without a
partial activity record or an idempotency key. Traversal is limited to 10,000 entries
per snapshot and 64 directory levels; oversized records can also hit Durable Object
storage limits. Such messages retry and ultimately require owner handling in the
DLQ. Malformed push envelopes retry. A tag pointing directly to a non-commit object
cannot be diffed by this implementation and follows that same failure path.

## Configuration and checks

The package's Wrangler template declares the Artifacts binding, supervisor binding
and SQLite migration. The owner supplies the Worker name, namespace, Queue consumer
and event subscription in deployment configuration, and supplies
`OWNER_API_TOKEN_HASH` as a Worker secret. No account values or credentials belong
in tracked files. Deployment integration and live acceptance are separate work.

From an installed repository workspace:

```sh
pnpm --filter forkhorse-core test
pnpm --filter forkhorse-core types:check
pnpm test
pnpm lint
```

The standalone package declares its own toolchain so its fixtures can also run
independently when starter tooling is unavailable. Production types derive the
Artifacts surface from `@cloudflare/workers-types`. Tests instantiate real Durable
Objects with explicit fixture binding implementations and assert the workerd
runtime. They do not contact Cloudflare. Production commit/promote uses raw Git HTTP with a git-style `User-Agent`. The
offline protocol fixtures exercise actual isomorphic-git objects, packs and push
commands against a fixture HTTP peer; they never contact a live remote.

References read before implementation:
[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
[isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/),
and [Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/).
The newer binding supports reads directly, so this package does not need the Git
clone shown in the older example.


## Packets, claims, review and promote

Public record types, including `StateSnapshot`, are exported from
`src/workflow-types.ts`. Every route below uses the same project-scoped bearer
validation, JSON responses and no-store header as the original routes. Owner
credentials cannot impersonate an agent on claim creation, commit or review requests.

| Method and suffix under `/projects/:id` | Role | Body / response |
| --- | --- | --- |
| `POST /agents` | Owner | `{agent}` → `{agent, apiToken}` (201, returned once) |
| `POST /agents/:agent/rotate` | Owner | `{}` → `{agent, apiToken}`; previous API credential immediately stops working |
| `POST /packets` | Owner | `{id,title,goal,paths,acceptance}` → `{packet}` (201) |
| `GET /packets` | Owner/agent | `{packets}` |
| `POST /packets/:pid/claim` | Agent | `{repoName?}` → `{claim}` (201 new, 200 existing) |
| `DELETE /packets/:pid/claim` | Owner or claiming agent | `{released:true}`; invalidates outstanding reviews for that packet |
| `POST /forks/:repo/commit` | Agent | `{packet,files:[{path,content}],message}` → `{repoName,packet,sha}` (201) |
| `GET /blockers` | Owner/agent | `{blockers}` |
| `POST /reviews` | Agent | `{repoName,sha,packet}` → `{review}` (201) |
| `POST /reviews/:rid/approve` | Owner | `{}` → `{review}` |
| `POST /reviews/:rid/promote` | Owner | `{}` → `{sha}` |
| `GET /state` | Owner/agent | `StateSnapshot` |

Agent enrollment remains limited to 50 per project. Rotation changes API access;
it does not revoke previously issued join Git tokens, which retain their original
short expiry. The state snapshot returns agent names, never credential hashes.

Claims are created under the same supervisor serialization gate as joins and
promotes. Explicit `repoName` must be a registered caller-owned fork. When omitted,
the default is the caller's most recently **successfully registered** fork. Failed
joins and reserved counter gaps do not update that pointer. The claim is one
atomic `{packet,agent,repoName,paths,createdAt}` record. Retries retain it, and later
joins never redirect it. Release and claim again to select a different fork.
`state.claims` contains only live claims, with no implicit expiry. The owner can
release any agent's claim; agents can still release only their own. DELETE is
idempotent for an existing packet without a claim, and both roles are fenced while
`promotionPending` needs inspection. Each actual release atomically invalidates
outstanding reviews and writes a credential-free `claimRelease:<id>` audit record
with `packet`, `agent`, `repoName`, `claimedAt`, `releasedBy` (`owner`, `agent` or
`promote`) and `recordedAt`. Promotion also records the review ID. These are durable
storage records, following token audit conventions, not a public audit endpoint.
An already-running advisory receipt may attach after promotion using that exact
promote-release audit as its historical binding. Commit, generation and stale
checks still apply, and manual release does not grant this exception.

Paths are literal repository-relative file or directory names. A directory may
optionally end in `/**`; plain directory paths also cover descendants. Other glob
syntax, traversal, empty components, backslashes, control bytes and `.git`
components are rejected. `src` and `src-old` are siblings, not overlapping paths.
A claim overlapping another agent's live claim returns 409. On recorded pushes,
changes overlapping another agent's live claims create immutable blocker records
in the activity transaction; duplicate delivery creates no duplicate blocker.
Blockers are observations, not an additional approval gate or a claim release.

Commit validates the live packet/agent/repo binding independently of its client:
canonical/foreign repos return 403; missing or mismatched bindings return 409.
Files must lie inside the claimed paths. The **entire encoded JSON request** is
limited to 1 MiB, with 1–200 distinct text files and a nonempty message of at most
4,000 characters. Other JSON request bodies remain limited to 16 KiB. Commit
modifies Git objects without checking out files or executing repository code;
it preserves other files and executable modes, and rejects writing through
symlinks, submodules or file parents. There is no deletion input in this contract.
Commit authors use the enrolled agent slug and a synthetic `@idiot.tax` address;
this metadata is not a verified human identity.

A review must name the current fork default-branch head and a live matching claim.
It captures the canonical base at submission. `receiptDigest` starts null; FH-032
reserves a generation and starts the runner in the background through a trusted
capability, not an agent-editable HTTP field. New projects require passing real
check receipts for approval by default; legacy records without settings default
to false until the owner opts in. See [receipts](../../docs/receipts.md).
Approval records `{sha,receiptDigest}`, including null, but advisory projects never
use receipts to gate approval or promotion. Null means **no check receipt**, not
passing checks. Moving the fork head or releasing its claim invalidates an
outstanding review. Both approve and promote read the fork head fresh rather than
relying only on queued push events. State also computes stale status from fresh heads.

With `requireReceipt: true`, promote waits for a new successful before-promote
execution and compares its generation/commit/digest, including for reviews approved
before the setting was enabled. With false, promote neither runs nor waits for
checks; even failed advisory receipts gate nothing. In both modes, promote prepares
the exact reviewed commit, verifies fast-forward ancestry, then
re-reads both heads. The canonical head must equal the review's captured base.
Only then does the supervisor mint a 60-second canonical write token, use it for
one push, and revoke it in `finally`. It is never returned, stored or logged.
The isomorphic-git pre-push hook checks the advertised old SHA and target SHA;
receive-pack carries that old SHA for the server-side compare-and-swap. Push never
uses force. Competing promotes are serialized: the loser receives 409 with
`{"error":"stale base, rebase"}`. Repeated promotion of an already promoted review
also returns 409.

Each successful push atomically appends a ledger entry, marks the review
promoted, releases its matching claim and records `releasedBy: "promote"`. Other
outstanding reviews for that packet become stale. The release checks the original
agent, fork and claim creation time so it cannot erase a replacement binding.
Failed, stale or uncertain pushes do not release claims; an audit/storage failure
rolls back the complete ledger/review/release transaction. A durable `promotionPending` intent is saved before external I/O; a
transport/storage failure with uncertain outcome fences further promotions for
owner inspection. It is exposed separately in state and is **not** a successful
ledger entry. Recovery of uncertain outcomes is currently an owner operation;
there is no public reset endpoint. Short token expiry bounds interruption risk
when a Worker is terminated before cleanup. Provider exception text is sanitized.

The reconciler matches canonical events against the full `(repo,ref,before,after)`
ledger transition, not just a previously promoted SHA. Each ledger transition
can account for only one distinct event; later replays raise alerts. An unmatched move, including
a nondefault ref or deletion, raises a persisted alert. State also compares a
fresh default-branch head with the last known canonical/ledger head, detecting
moves before queue delivery. Historical alerts and blockers are retained.
Activity in state is the most recent 100 records in receive order; the existing
activity endpoint provides pagination. Other state arrays are currently unpaged.

### Offline evidence and integration limits

Tests cover immutable/explicit/default claim binding, conflicts and blockers,
authentication/rotation, invalid commit inputs, stale commit and receipt approvals,
two promote race scenarios, external CAS races, token cleanup, uncertain-outcome
fencing, canonical reconciliation, and real Git objects/packs over fixture HTTP.
The production transport refuses redirects and bounds each Git HTTP request and
response to 8 MiB with a 30-second fetch timeout. The ephemeral filesystem also caps stored bytes at 32 MiB. These bounds do not
fully bound transient decompression allocations. Oversized operations fail closed with 413 and need
the FH-007 sandbox Git runner. `GitOperations`/`PreparedPush` define the integration
seam; FH-032 wires container receipts separately from this Git transport. Large-repository
Git transport and live container acceptance remain separate work; the local suite
uses mocked container ports.

## Public Worker composition (FH-012)

The Worker now hosts the OAuth-wrapped MCP endpoint, Access-protected `/app` assets,
and the existing project API. The trusted adapter validates enrolled-agent credentials
through private Supervisor RPC and rejects owner credentials as MCP agents. Browser
owner calls verify Access signatures, audience, issuer, time claims and an explicit
owner allowlist; writes also require the configured origin and JSON content type.

See [core integration](../../docs/core-integration.md) for the optional owner-local
configuration, assets build, Queue consumer, event subscription prerequisites and
separate live gates. `__tests__/integration.test.ts` uses offline signed JWTs, local
KV/DOs, built dashboard assets and a mocked JWKS fetch. These are not live acceptance results.

## Caller identity and existing-fork credentials (FH-013)

All routes authenticate through the existing project credential/verified browser-owner
boundary. Query/body agent names never establish identity. Responses use `Cache-Control:
no-store`; plaintext Git tokens appear only in the successful issuance response.

| Route | Authority | Result |
| --- | --- | --- |
| `GET /projects/:id/me` | Agent or owner | `{role, agent?, forks:[{repoName, remote, head, createdAt}]}`. Agents see only their registered forks; owners see all registered forks. Canonical and inconsistent/unregistered records are excluded. Heads come from the repository's default-branch log. |
| `POST /projects/:id/forks/:repo/token` | Owning agent only | Body `{scope:"read"\|"write", ttlSeconds?}`; TTL is an integer 60–3600, default 900. Returns status 201 with `{repoName, remote, token, scope, expiresAt}`. Owner credentials cannot mint through this route. |
| `DELETE /projects/:id/forks/:repo/tokens` | Owning agent or owner | Revokes active provider tokens, including join-issued tokens, then returns `{repoName, revoked}`. A completed repeat returns zero. |

Canonical token operations return 403, unknown forks 404, and foreign ownership 403.
An agent credential still cannot approve or promote reviews. A supplied Git token is
not a core API credential.

The Supervisor serializes authentication, ownership validation and issuance/revocation.
Each successful POST writes a durable `tokenAudit:` record with `action:"issued"`,
`repoName`, caller role/agent, `scope`, `expiresAt` and `recordedAt` before returning the
token. Audit records contain neither plaintext nor token IDs. They are operator-side
storage records, not a new public audit endpoint. An audit failure attempts immediate
revocation and never returns the unaudited credential.

Revocation uses the provider's token inventory, not just IDs issued by this endpoint.
The current binding offers `listTokens()` with no cursor. Core drains active pages and
re-lists to verify completion, bounded to 100 rounds. A stale page, an inaccessible
truncated listing or a provider error fails closed: no claim that all tokens were
revoked. A durable pending marker blocks new POST issuance until DELETE succeeds.
Revocation audits contain metadata/counts only. Out-of-band provider changes cannot
be serialized by this Supervisor; live provider behavior remains a separate acceptance
step. No live Artifacts calls were used by the workerd fixture suite.

Binding reference: [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/).

## Repository event coverage

Core provisions `artifacts.repo` / `pushed` subscriptions for the canonical repository
and every new fork using `CF_EVENTS_API_TOKEN`, `CF_ACCOUNT_ID` and the owner-resolved
`PUSH_QUEUE_ID`. The event token is separate from all Git credentials. Subscription
status is returned as `events: "active" | "pending"` on the create response's project,
the join response, `/state` project/forks and `/me` project/caller-filtered forks.
Active entries include `subscriptionId`; they do not claim live push delivery.

The registry and pending alarm are committed before API calls. Failed provisioning
still returns successful create/join, retries with durable 30-second-to-one-hour
backoff, and checks paginated subscription listings before any POST to recover
uncertain outcomes without creating another subscription. Missing credentials stay
pending. Legacy repositories need owner inventory/backfill; active records are not
periodically reconciled against external deletions. See [core integration](../../docs/core-integration.md)
for exact Wrangler schema, limits, first-deploy secrets files and the separate live gate.

## Quick checks (FH-010)

Core also exports `QuickFiles` and declares a `LOADER` Worker Loader binding.
Quick modules execute before full container checks, using exact-reviewed-commit
Artifacts reads through a bounded, revocable RPC loopback. Receipt summaries
preserve each check's actual tier/runtime and skipped-check message. Required
approval verifies quick module source digests independently; generation, claim,
CAS and advisory-mode semantics are unchanged. See [receipts](../../docs/receipts.md).
The workerd suite exercises real local Dynamic Workers with fixture repositories
and mocked containers. Deployed latency and no-container live smoke remain open.
