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
Owner recovery/credential rotation and additional enrollment are not implemented
in this packet; save the one-time credentials before distributing them.

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
cannot select another agent. This package has no canonical push or promote route.

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

Errors have `{ "error": "..." }`: `400` invalid input, `401` missing/malformed
bearer token, `403` unauthorized token/agent, `404` unknown route/project, `405`
unsupported method, `409` duplicate/uncertain creation, `413` body over 16 KiB, and
`502` sanitized provider failure. Authorization happens before repo operations.

## Queue and changed paths

Connect a Cloudflare event subscription for `cf.artifacts.repo.pushed` to a Queue
consumed by this Worker. Provision the Queue and subscription through the owner's
deployment configuration; no live resources are created by this package or its
tests. Set a dead-letter queue and retry limit so permanent failures are inspectable.
`ARTIFACTS_NAMESPACE` must match the namespace in the `ARTIFACTS` binding.

The consumer uses `source.namespace`, `source.repoName`, `payload.ref`,
`payload.before`, `payload.after`, and `metadata.eventTimestamp` from the documented
envelope. Other events, namespace mismatches, ref deletions (`after` all zeros),
and unknown repositories are acknowledged without a log entry. A matching naming
prefix alone does not establish membership: the supervisor checks its stored
canonical/fork registry.

The idempotency key is exactly `(namespace, repoName, ref, after)`, hashed for a
bounded storage key. The complete activity entry and key are committed atomically.
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
runtime. They do not contact Cloudflare. No raw Git HTTP requests are made here;
future raw Git transport must send a git-style `User-Agent`.

References read before implementation:
[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
[isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/),
and [Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/).
The newer binding supports reads directly, so this package does not need the Git
clone shown in the older example.
