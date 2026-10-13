# Check receipts

FH-032 wires the runner into core. All acceptance evidence for this packet is
**offline workerd with mocked container ports**. FH-010 adds real local
Dynamic Worker execution, with fixture Artifacts reads. It does not establish container
startup, registry access, deployed bindings, provider token revocation or live
promotion. Those remain behind FH-032L.

## Workflow and settings

`POST /projects` accepts owner-only `requireReceipt: boolean`, defaulting to true.
A stored project with no settings uses `{ requireReceipt: false }` until its owner
opts in. This backward-compatible fallback also covers the existing development
project; this change does not read or modify any live project.

Owner-only `PATCH /projects/:id/settings` accepts exactly
`{ "requireReceipt": true }` or `{ "requireReceipt": false }` and returns
`200 { "settings": { "requireReceipt": boolean } }`. Agent credentials cannot
change the setting. Browser owner requests retain Access, same-origin and JSON
content-type checks. `/state` always includes `project.settings`.

An authorized agent's successful `POST /reviews` reserves a fresh execution UUID,
clears the digest and returns immediately with a running receipt summary. The
Supervisor starts checks in the background. Authority comes from the stored
project, registered caller-owned fork, live packet claim and exact fork head.
Public input cannot select a generation, image URL, authority, remote or digest.

The packet ruling of **2026-10-12 16:55 ET** supersedes the original unconditional
before-promote requirement and 409 wording. The state wire shape below is unchanged.

When `requireReceipt` is **true**, approval calls the runner validator against the
exact commit's checks and attached immutable record. It rejects missing, stale,
altered, incomplete, failed, `mocked-container-port` and `mocked-worker-loader` evidence. Promote validates
owner consent for the exact commit, then reruns checks with a new generation and
the `before-promote` trigger, holding the Supervisor's workflow mutex until
completion. It compares the new digest, trigger, commit and generation and
rechecks both repository heads before minting a canonical write credential. The
ledger records this fresh digest. A failed, timed-out, missing or infrastructure
result returns exactly `409 { "error": "Checks failed before promote." }`.
The failed before-promote summary stays visible. Mocked successful evidence also
fails the required gate.

When `requireReceipt` is **false**, receipts are advisory. Review-created checks
still execute when the commit contains `.forkhorse/checks`; their results remain
visible, including failures. An absent check file leaves `receipt: null` after
configuration discovery. Invalid or unsafe configuration is an infrastructure
error, but does not gate approval or promotion. Approve and promote ignore receipt
status, digest changes and in-flight execution. Promote starts no checks and does
not wait for checks or return a check-related 409. A review-created result can
attach after advisory promotion without overwriting the promotion or owner consent.
The ledger captures the digest known at promotion; a later advisory result can
therefore differ from that historical ledger entry.

A settings change affects later approve and promote calls. Turning the requirement
on also gates an already-approved review at its next promote: it must complete a
new required run, even if its earlier approval or receipt was advisory. Turning it
off makes subsequent calls advisory. Owner authorization, exact-commit consent,
live claims, fork-head checks, canonical fast-forward/CAS and uncertain-outcome
fencing apply in both modes.

## Fixed state wire contract

Every `/state` review has `receipt: null` for an older review without an execution,
or this shape:

```ts
{
  status: "running" | "passed" | "failed" | "infrastructure-error" | "timed-out";
  trigger: "review-created" | "before-promote";
  digest: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  checks: {
    name: string;
    tier: "quick" | "full";
    runtime?: "dynamic-worker" | "container";
    message?: string;
    outcome: "running" | "passed" | "failed" | "infrastructure-error" | "timed-out";
    durationMs: number | null;
  }[];
}
```

There are no logs, images, tokens or execution-generation fields in this summary.
While definitions load, `checks` is empty. The digest is null while running and
when infrastructure fails before a record can be safely published. Missing or
invalid checks, unresolved images and unconfirmed cleanup fail closed.

Owner-only `GET /projects/:id/reviews/:rid/receipt` returns the currently attached
`{ digest, receipt }` record, including each check's bounded logs, or 404 if there
is no attached record. It never accepts receipt input. Each stream retains at
most 32 KiB of original source bytes; UTF-8 replacement decoding can expand its
serialized size. Agent access returns 403.

## Persistence and capability boundary

Receipt records are content-addressed SHA-256 values, stored in 16,384-code-unit
chunks. Even worst-case UTF-8 chunks stay under 128 KiB. All chunks and their
manifest commit atomically. Attachment is a separate atomic compare-and-set over
commit, generation, trigger and live claim; a stale execution may leave an
unattached immutable record but cannot replace the current digest. Approval also
compares the current receipt inside a transaction before persisting owner consent.

Core and the runner share one Worker script. `ReceiptRunner` is a SQLite Durable
Object with `durable_object` container scheduling; `GitReadGateway` is a loopback
entrypoint created through the same `ctx.exports`. The Supervisor passes a
one-execution `RpcTarget` authority directly to the runner. These callbacks use
storage transactions rather than the workflow mutex, avoiding deadlock while a
promote waits. The runner opens only the capability-authorized fork within the
configured Artifacts namespace. The canonical write token remains confined to
core's promote path. Neither runner nor gateway has a public HTTP route.

On Supervisor restart, interrupted running summaries become infrastructure errors
and their generations are invalidated. On runner restart, any existing container
is destroyed before another RPC can proceed. Normal execution still refuses
concurrent/reused running containers and destroys them on every completed attempt.
A terminated runner's unrevoked read token is bounded by its 180-second expiry;
live restart/recovery behavior still needs operator verification.

## Quick checks (FH-010)

The exact reviewed commit's `.forkhorse/checks` also accepts this strict shape:

```json
{"name":"brand-quick","tier":"quick","module":".forkhorse/quick/brand.js"}
```

No `image` or `run` is allowed on a quick check. A module must be one `.js` file
immediately under `.forkhorse/quick/`, exporting a default async function:

```js
export default async (ctx) => {
  const text = await ctx.read("brand.json");
  return { ok: text !== null, message: "Checked brand.json." };
};
```

`ctx.read(path)` returns a regular file's UTF-8 text or null if absent.
`ctx.stat(path)` returns `{size, binary}` or null if absent: `size` is the blob's
byte size, and `binary` is true when its first 8 KiB contains a NUL byte. This
heuristic does not validate UTF-8 or identify every binary format. Only that
bounded sample is materialized; the file's contents are never returned by stat.
`ctx.list(prefix)` returns sorted regular file paths starting with that literal
prefix; `""` lists the snapshot and `"src/"` lists that directory's descendants.
Executable regular files are included. Paths are repository-relative; absolute
paths, traversal, empty components, backslashes, control bytes and `.git`
components are rejected. Symlinks and submodules are never followed. Text reads
reject malformed UTF-8; missing provider objects and unsafe trees fail closed
for stat as well as read/list. Snapshot access uses only
Artifacts `readCommit`/`readTree`/`readBlob` at the reviewed SHA, never branch refs.

Each check gets a fresh `LOADER.load()` isolate with `globalOutbound: null`, only
a `FILES` RPC loopback in its environment, no Node compatibility, no tails and
no secrets. A trusted main-module harness imports the unchanged check module;
this adapts its default function to a Worker handler, like upstream's overseer
harness. Importable environment access is disabled. The loopback names the
execution's Durable Object and a random per-check capability ID. The ID is not
a Git/API token; it authorizes only read/list/stat of one snapshot. The runner retains
all state and budgets. No token is minted for quick execution.

Aggregate limits per check are 2 MiB of reads and stat samples (including module source),
2,000 listed paths (including repeated listings), 10,000 fetched tree entries
and file calls, and 64 path levels. Budget reservation happens before async blob
materialization or return, including concurrent calls. Validated immutable tree
metadata is cached per snapshot, so list/read/stat reuse it without refetching.
Modules return
`{ok: boolean, message?: string}`. Messages are limited to 4 KiB of UTF-8, with
control/bidi escapes and stack-shaped suffixes removed. Thrown exceptions are
replaced by static text; provider exception text and stacks never enter receipts.
Returned messages are project-authored check output, not trusted provider diagnostics.

A 10-second wall deadline covers module loading, startup and execution. It aborts
the dispatched fetch and revokes the file capability, including pending reads.
The loader also receives a 10,000 ms CPU limit. A thrown check or `ok:false` is
`failed`; startup/import errors are `infrastructure-error`; the deadline is
`timed-out`. No late result can turn a timed-out receipt into a pass. A process
restart drops these capabilities; there is no resumable quick execution.

Quick checks run first, preserving order within each tier. Any non-passing quick
result prevents every full container start and token mint. Full checks then have
`outcome:"failed"`, `durationMs:null`, and the exact message
`"Skipped: a quick check failed."`. Quick-only suites never start a container.
Full image preflight and container cleanup are otherwise unchanged.

Receipt schema remains 1. New check records include `runtime:"dynamic-worker"`
or `"container"`. Quick `imageDigest` is `module:sha256:<digest of module source>`;
when no source could be loaded, it is empty and the check cannot pass. A skipped
full check also has an empty image digest. Top-level evidence is `dynamic-worker`
for quick-only, `container` for full-only, or `mixed` for both actual runtimes.
Any mocked port keeps a mocked evidence label and cannot satisfy the required
gate. The gate independently hashes each quick module from the reviewed commit
and checks its definition, runtime, source digest, generation and receipt digest.
Old full-only records retain their original digest serialization; an absent
runtime field is accepted only for legacy full/container records.

Core's Wrangler template declares `worker_loaders: [{binding:"LOADER"}]`;
the existing deployment generator preserves it without additional owner config.

## Image and demo checks

Core's Wrangler configuration names `default`, built from
`packages/forkhorse-runner/container/Dockerfile`: Node 24 LTS slim, Git, CA
certificates, POSIX `sh` and GNU coreutils (`timeout`, `sleep`). Wrangler builds,
pushes and resolves the image during the separately authorized deployment. The
runner accepts only immutable `@sha256:` references from `ctx.container.images`.
Runtime internet remains disabled; only the selected fork's Git read protocol is
intercepted. Dependencies must be baked into an owner-approved image.

The root `.forkhorse/checks` first runs `.forkhorse/quick/brand.js`, checking that
`brand.json` parses and has non-empty `name`, `slug` and `mark` strings. Then the
full `large-files` check runs one Node command in the `default` container image
to scan checkout metadata, excluding `.git` entries and not following symlinks.
It fails on any regular file of 10,000,000 bytes (10 MB) or more and never reads
file contents. Repository-wide serial stat RPCs exceeded the quick tier's
10-second deadline in the operator's live run; this check uses the full tier.
`.forkhorse/quick/large-files.js` remains an unregistered stat API example for
small snapshots, not the repository's acceptance check.
See [large files and binaries](large-files.md) for limits and the storage roadmap.
The existing full `brand` container check remains and needs no project
dependencies. For a smoke repository, commit:

```json
[{"name":"test","tier":"full","image":"default","run":"npm test"}]
```

alongside this dependency-free `package.json`:

```json
{"scripts":{"test":"node -e \"if (2 + 2 !== 4) process.exit(1)\""}}
```

A failing test can use `process.exit(1)` to exercise refusal. No package install
runs inside the container. The separately gated live demo uses the smoke project.

## Offline validation and D5

Both package suites run under workerd. The installed Vitest/Miniflare supports a
real Worker Loader: quick pass/fail, throws, startup failures, HTTP/TCP egress
blocking, RPC reads/listing and the real 10-second deadline execute in local
Dynamic Workers. A separately labeled fake-loader test inspects abort signaling
and capability revocation. Artifacts, Git and all containers remain fixtures;
local workerd does not establish production CPU enforcement or deployed latency.

The post-deploy operator gate remains open: on `fh-smoke`, show one quick check
passing well under one second with `runtime:"dynamic-worker"`, followed by a full
check; then fail a quick check and verify no container started. No deployment or
live smoke is performed by this implementation.

Primary references: [Dynamic Worker API](https://developers.cloudflare.com/dynamic-workers/api-reference/),
[egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/),
and [resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
 Core includes a same-script loopback DO RPC
test using the production adapter and an explicitly mocked container port. Tests
of required approval use separately fabricated validator records; mocked runner
results are never relabeled as real container evidence.

Fresh-clone validation runs root/upstream frozen installs, both package tests and
`types:check`, root `pnpm test`, `pnpm lint`, and `pnpm check`. D5 remains **eight
Worker dry runs**: runner and gateway are exports of core, not another Worker.
`--check` passes `--dry-run --containers-rollout none` to Wrangler. The installed
Wrangler 4.149.0 implementation returns before both container-image build paths
for that flag; plain `--dry-run` alone would build Dockerfiles. D5 therefore checks
Worker bundles/configuration without building, pulling or resolving the image.

Run D5 only in a fresh review clone with an exclusively created mode-0600 synthetic
`deployment.local.jsonc`, a temporary empty HOME and environment, metrics disabled,
external networking and Keychain access denied, and cleanup limited to those owned
synthetic files. Refuse an existing local owner file. No live configuration or
credentials are needed. D5 is not image or deployment acceptance.

FH-032L remains locked: operator deployment, budget alert, one live smoke receipt,
container start, exact checkout, token revocation, attached digest, gated approval,
cleanup and restart/orphan recovery must all be verified separately.
