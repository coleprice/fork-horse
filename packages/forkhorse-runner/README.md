# Container test receipts

FH-007 runner with FH-032 core integration, **offline implementation**. The acceptance suite uses an explicitly
**mocked container port**. No container was started, no Cloudflare service was
called, and no live receipt is claimed. Live acceptance remains locked pending
separate FH-032L authorization and the specified budget alert.

This package exports a Sandbox SDK **1.0** native Durable Object adapter,
`ReceiptRunner`, plus a pure orchestration function and typed FH-005 seams. It
has no public HTTP endpoint. Core now composes both exports into its own Worker;
its Wrangler configuration references `container/Dockerfile`. Tests run in workerd
with mocked container ports and never invoke a local container runtime.
See [receipts](../../docs/receipts.md) for the integration and locked live gate.

## Checks contract

The exact authorized commit's `.forkhorse/checks` is a UTF-8 JSON array:

```json
[
  { "name": "unit", "tier": "full", "image": "node-tests", "run": "npm test" }
]
```

There must be 1–16 uniquely named checks; the file is limited to 32 KiB. Unknown
fields, non-full tiers, empty commands, and symlink files/directories fail closed.
`image` names an owner-configured `container.images` entry that must resolve to
an immutable `@sha256:` reference. A project cannot supply an arbitrary image URL.
The owner must build the image with its dependencies already present, Git,
CA certificates, POSIX `sh`, `sleep`, and GNU `timeout`. Package installation
requiring public internet will fail with this policy. No SDK shim is needed:
the implementation uses native process APIs, not the SDK's Files/S3 helpers.

Each check gets a fresh container with `enableInternet: false`. A scoped HTTPS
intercept permits only the selected fork's `info/refs?service=git-upload-pack`
and POST `git-upload-pack` routes. Redirects and all write routes are excluded.
Git sends a git-style User-Agent. The runner initializes a worktree, fetches the
exact 40-character commit, checks it out detached, and verifies HEAD.

Authorization precedes `createToken("read", 180)`. The full token goes through
Git's per-command environment configuration for `http.extraHeader`; it never
enters the remote URL or persistent Git configuration. Clone output and provider
exception text are discarded. The token is revoked before project code runs,
and cleanup retries revocation if checkout or revocation fails. A trusted image
is required because it sees the read token during Git preparation.

A check has a 120-second runner deadline, a 110-second GNU timeout with a
5-second kill grace, and a container inactivity timeout. The runner destroys the
container on success, failure, or deadline. Cleanup failure blocks publication.
Startup/checkout failures produce an infrastructure-error receipt; ordinary
nonzero exits produce a failed receipt. A runner deadline produces timed-out.
Native timeout exit codes remain ordinary nonzero exit statuses.

Each receipt contains the exact commit, full check definition, image digest,
exit status, outcome, UTC timing and duration, bounded stdout/stderr, truncation
flag, and SHA-256 log digest. Each stream retains at most 32 KiB of source bytes;
the rest is drained without buffering. The log digest covers the retained,
UTF-8-decoded logs plus truncation flag, not the discarded tail. The suite digest
uses `receiptJson()`'s fixed field order. No empty suite can pass.

## FH-005 integration dependencies (wired by FH-032)

`ReviewAuthority` in `src/types.ts` is a required trusted service seam. Core supplies
a per-execution RPC capability rather than a globally reusable authority binding:

1. **Review-created trigger:** authenticate and authorize the caller; bind the
   review to a project, fork repo, returned Artifacts remote, and exact commit.
   Reserve a new execution generation and clear the old receipt digest before
   returning `AuthorizedReview`. Never accept these authority fields from a
   public request. The runner receives only review ID and trigger.
2. **Before-promote trigger:** always call `run()` again and wait for it. Do not
   reuse the review-created receipt, even if the commit is unchanged. Serialize
   promotion against review edits, compare commit/generation, and require the
   newly returned digest/trigger before writing the canonical repository.
3. **Artifacts capability:** provide `ARTIFACTS.get()` scoped to the owner's
   namespace. Authorization must verify the selected repo is this review's fork;
   this package never opens the canonical repo or mints a write token.
4. **Supervisor persistence:** `storeReceipt()` must durably save the immutable
   record by digest before resolving. Split/chunk the bounded log payload where
   necessary to respect storage value limits; do not assume a whole 16-check
   suite fits one KV value. `setReviewReceiptDigest()` must atomically compare the
   reserved generation and commit, then set the digest. Return false if stale.
   An unattached immutable record may remain after a stale-run failure.
5. **Approve:** call `requirePassingReceipt()` with the current server-owned
   review, exact expected checks, and attached digest. `requireReceipt` defaults
   to true. The helper requires every check to pass and rejects mocked evidence,
   changed commits/generations, missing checks, and altered digests. The authority
   must load records from its own trusted storage, never a caller-supplied body.
6. **Adapter wiring:** provide the trusted authority and Artifacts bindings;
   configure `ReceiptRunner` with the `durable_object` scheduling policy, named
   digest-resolved images, and unique authorized execution IDs. Export the
   `GitReadGateway` loopback entrypoint. It receives only the authorized remote
   as props. Do not bind it or the runner directly to unauthenticated callers.
   The DO rejects overlapping calls and already-running containers rather than
   silently reusing another execution's filesystem.
7. **Operational acceptance:** authorize the live gate, set a spend cap, and
   verify scheduling/image resolution, Git TLS interception, token revocation,
   exact checkout, process streams/deadline cleanup, and real Supervisor writes.
   Also verify orphan-container recovery after a DO restart. None of these live
   properties is proven by this packet's mock suite.

The production adapter labels its actual container path `container`; tests inject
`mocked-container-port`. A request cannot choose this field. Validator tests may
construct fabricated records to exercise validation; these remain test fixtures.

## SDK/API evidence

Primary documentation checked for this implementation:

- [Sandbox 1.0 changes](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/): use an application-owned Durable Object and native container calls, not the 0.x Sandbox class.
- [Native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/): `images`, `start`, `exec`, HTTPS interception, inactivity timeout, and `destroy`.
- [Process execution](https://developers.cloudflare.com/containers/guides/execute-commands/): argv execution, process streams/exitCode, signals, and GNU timeout for descendants.
- [Private Git clone](https://developers.cloudflare.com/sandbox/network/clone-a-private-repository/): HTTPS interception and the container CA certificate path.
- [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/): full Bearer read token through `http.extraHeader`.
- [Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/): exact-commit tree/blob reads and repo-scoped token lifecycle.

The adapter typechecks against `@cloudflare/workers-types@5.20261006.1` using
`Pick<Container, ...>` rather than invented SDK signatures. There is intentionally
no `@cloudflare/sandbox` dependency: the 1.0 package supplies optional helper
classes; this runner only needs the documented native platform APIs.

## Offline validation

```sh
pnpm install --frozen-lockfile
pnpm -C cloudflare-os install --frozen-lockfile
pnpm --filter forkhorse-runner test
pnpm --filter forkhorse-runner types:check
pnpm test
pnpm lint
```

The mock suite covers authorization ordering, read-only token scope and lifetime,
exact fetch/checkout, configured image digests, log bounds, deadlines, startup and
checkout failures, cleanup failures, stale-review attachment, both triggers,
multiple checks, approval defaults, and narrow Git egress. Root checks also run
existing packages' local Worker tests; these are not container acceptance.
