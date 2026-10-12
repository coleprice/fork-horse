# Container receipts

FH-032 wires the runner into core. All acceptance evidence for this packet is
**offline workerd with mocked container ports**. It does not establish container
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

Approval calls the runner validator against the exact commit's checks and the
attached immutable record. When required, it rejects missing, stale, altered,
incomplete, failed and `mocked-container-port` evidence. A false setting bypasses
this approval requirement; it does not turn missing checks into passing checks.

Promote first validates the existing owner approval, then **always reruns** checks
with a new generation and the `before-promote` trigger, holding the Supervisor's
workflow mutex until completion. The original owner approval authorizes this
specific commit and its previously attached receipt; the fresh successful run is
an additional pre-write condition. Core compares the returned digest and trigger,
and rechecks the stored commit/generation/digest and both repository heads before
minting a canonical write credential. The ledger records the fresh digest.

A failed, missing or infrastructure-failed rerun returns exactly
`409 { "error": "Checks failed before promote." }`, including when
`requireReceipt` is false. The failed before-promote summary stays visible. It
requires another owner approval before retry because its digest differs from the
previous approval. A required project also rejects a mocked successful rerun.

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
    tier: "full";
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

## Image and demo checks

Core's Wrangler configuration names `default`, built from
`packages/forkhorse-runner/container/Dockerfile`: Node 24 LTS slim, Git, CA
certificates, POSIX `sh` and GNU coreutils (`timeout`, `sleep`). Wrangler builds,
pushes and resolves the image during the separately authorized deployment. The
runner accepts only immutable `@sha256:` references from `ctx.container.images`.
Runtime internet remains disabled; only the selected fork's Git read protocol is
intercepted. Dependencies must be baked into an owner-approved image.

The root `.forkhorse/checks` contains a genuinely failing-on-invalid-JSON `brand`
check that needs no project dependencies. For a smoke repository, commit:

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

Both package suites run under workerd. Core includes a same-script loopback DO RPC
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
