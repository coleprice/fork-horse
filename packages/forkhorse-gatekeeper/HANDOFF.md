# FH-008 WIP checkpoint after FH-012 integration

Status: **independent UI, capability, configurator and disabled deployment wiring implemented;
full packet blocked on FH-013; workerd rejection diagnostic isolated to a native RPC control**.
D9 requests a draft checkpoint with subject prefix `WIP checkpoint (not for review):`.
Status stays in-progress; this is not a review or merge handback.

## Provenance and scope

- Branch: `fh/FH-008-gatekeeper`.
- Freshly fetched starting baseline: `2fa697c01e78b8446207edc2adce6de0ba47e152`.
- Published first checkpoint: `4ed940969e1e3a6f48cbc6a1c35326f7665b443e`.
- Accepted main `abbb608f8ef2cb9a965cc8d6683394b733f1d0c2` integrated with merge
  `c4439ff4c2f6fd75b7bfd054577ce81090d8b511`, preserving the published checkpoint.
- Pinned upstream: `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`, source and gitlink unchanged.
- D6 continuation: UI, capability and configurator fixtures allowed; Git transport
  and S7/S9 wait for FH-013 acceptance. FH-012 is merged and its deployment gate is cleared.
- Thirty-four package files plus 37 lockfile lines for its importer only. Automated
  comparison confirms every lockfile byte outside that importer matches accepted main.
  Existing snapshots are reused; no catalog/override/workspace edits.
- New deployment changes are limited to `scripts/` and the optional template block.
  No FH-008 core, dashboard, upstream or board edits. No live APIs, account
  credentials, owner token handling, deployments or spend.

## Changed files

- `package.json`, `tsconfig.json`, `tsconfig.worker.json`, `vite.config.ts`,
  `vitest.config.ts`: separate browser/Worker types, two inline frames, Node and
  workerd tests, explicit pinned runtime sentinel and validation transform.
- `app/main.ts`, `app/configurator.ts`, `app/configurator.css`: iframe bootstraps,
  private port handshakes, prompt bridge and sandbox-safe local draft check.
- `src/assets.d.ts`, `src/ui-types.ts`, `src/client.ts`, `src/feed.ts`, `src/mount.ts`:
  bounded push/poll snapshots, project isolation, accepted dashboard embedding and
  read-only controls/labels. No owner actions are exposed or inferred.
- `src/configuration.ts`, `src/configuration-form.ts`: draft validation and form;
  no credential persistence/echo, no authentication claim or enabled connection.
- `src/worker/sidebar.ts`, `src/worker/configurator.ts`: Worker-native validated
  capabilities, branding metadata/frame helpers, authorization checks, revocation
  and lifetime cleanup. Actual authenticated source/account is still unwired.
- `__tests__/worker.ts`, `__tests__/sidebar.test.ts`, `__tests__/native-rpc.test.ts`:
  native service-binding fixture, nine UI/configurator tests and two runtime controls.
- `src/worker/index.ts`, `wrangler.jsonc`, `__tests__/vendor.test.ts`: wiring-only
  vendor, private Worker base and two native runtime refusal tests. No connected
  account, credentials, source, callback completion or resource grant exists.
- `scripts/gatekeeper-deployment.ts`, `scripts/gatekeeper-deployment.test.ts`,
  `scripts/deploy.ts`, `scripts/deployment-config.ts`, `deployment.jsonc`: disabled
  template, Worker identity validation, private generated config, separate router
  HTTP/Workshop RPC bindings, uncached build and deployment before those consumers.
- `test/sidebar.test.ts`, `test/configuration.test.ts`, `test/node-runtime.ts`,
  `test/verify-bundle.ts`: nine Node tests, one RPC runtime identity, bundle checks.
- `test/fixture-main.ts`, `test/fixture-ui.ts`, `test/configuration-fixture-main.ts`,
  `index.html`, `configurator.html`: explicitly labeled local fixture hosts.
- `README.md`, `HANDOFF.md`: composition boundaries, checks and remaining gates.
- Root `pnpm-lock.yaml`: own importer only.

## Commands and results

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Final 11-project frozen install, existing snapshots linked. |
| `pnpm --dir cloudflare-os install --frozen-lockfile` | 0 | 34 pinned upstream workspace projects; unchanged since initial preparation. |
| `pnpm --filter forkhorse-gatekeeper types:check` | 0 | Browser and Worker TypeScript configurations. |
| `pnpm --filter forkhorse-gatekeeper test:node` | 0 | 9 tests pass. |
| `pnpm --filter forkhorse-gatekeeper test:workerd` | 0 | 13 tests pass under actual workerd; diagnostic evidence below. |
| `pnpm --filter forkhorse-gatekeeper build` | 0 | Inline sidebar ~81.46 kB and configurator ~56.27 kB; both bundle checks pass. |
| `pnpm test` | 0 | Final Vite+ run: 5/11 cache hits; gatekeeper Node/workerd suites executed. |
| `pnpm lint` | 0 | Lint, script types, package types/builds; final Vite+ run 9/13 cache hits. |
| `node --test scripts/gatekeeper-deployment.test.ts` | 0 | 3 tests: disabled/absent, private bindings, invalid/colliding identities. |
| Pinned `wrangler deploy --config <synthetic-config> --dry-run` | 0 | Generated vendor only, all networking denied, fresh empty HOME and environment; 2.06 KiB; no bindings. |
| `git -c core.fsmonitor=false diff --check` | 0 | No whitespace errors. |

Frozen install correction: an initially unqualified Miniflare peer snapshot
reference failed. A pnpm script auto-install then attempted unrelated lockfile
normalization. Those changes were removed, the exact already-pinned Miniflare
version is declared directly, and the final frozen install and byte comparison
passed. No unrelated lockfile changes remain.

## Evidence boundaries

- Node tests send 240 batches at virtual 250ms intervals through actual MessagePort
  RPC and the unmodified pinned OS limiter. Push uses two startup calls and no
  per-batch inbound refresh; fallback uses at most 243 calls including startup and
  an outstanding poll. One receiver, one latest pending snapshot and one poll bound
  backlog. The runtime limits are 8 concurrent, 600/minute and 128 pending.
- workerd tests verify the runtime sentinel, branding, native callback retention,
  subscription closure, denied setup before any source read, UI disposal, one poll,
  cursor bounds, authorization before disclosure, source revocation and foreign
  project refusal. The configurator returns no credential and no connection grant.
- Both built frames were inspected in actual opaque-origin sandboxed iframes in a
  local browser fixture. Sidebar updates and prompt callback were visible. The
  configurator's format result appeared, its credential field cleared, and Create
  connection stayed disabled. Browser logs showed no errors/warnings.
- This is **not** pinned OS `run-local`, a real enrolled-agent connection, S7/S9,
  live Artifacts Git, deployment, owner approval or promotion evidence.

## Open issues and gates

1. **Runtime diagnostic isolated, not suppressed:** a plain returned native
   `RpcTarget` whose method throws reproduces the same hung-request cancellation
   without executing sidebar/feed/validation code. The caller receives the intended
   error, a subsequent `ping()` succeeds, and disposing the target invokes its
   disposal hook. A plain entrypoint rejection logs the intended exception without
   the hung warning. Reproduce the two controls with
   `pnpm --filter forkhorse-gatekeeper exec vitest run __tests__/native-rpc.test.ts`.
   The 2/2 control assertions pass under the pinned runtime. This is evidence that
   the warning does not by itself indicate a hung sidebar or failed disposal; the
   underlying runtime cause remains unproven and full OS acceptance is still held.
   The application tests separately verify subscription/source disposal and rejected
   polls. No exception logs are filtered or suppressed.
2. FH-013 must be accepted before connecting an actual source, account credentials,
   caller identity or existing-fork tokens. No proposed API is treated as shipped.
3. Account connection completion, fork resource grants/heads, kit Git transport,
   approved CAS push and full integration remain to be implemented after FH-013.
4. Offline binding wiring is prepared after FH-012 merge; it does not enable an
   account. Only the new generated vendor Worker was dry-run in this continuation.
   A full owner-configured deployment check and live operations remain separate gates.
5. S7 and S9 remain **not run / not accepted**. Live installation remains separate.
6. Dashboard has no native read-only option. The package guards its existing button
   and label selectors, with tests; a separately scoped dashboard seam can replace
   that coupling later.

D9 permits WIP checkpoints on this packet branch before S7/S9. Ordinary approval
review permitted the first push after repository privacy/admin access verification.
Subsequent publication preserves that checkpoint and uses normal fast-forward pushes.
This does not authorize review, merge to main, dependent Git work or live operations.
The unsuppressed diagnostic must be fixed or evidenced benign for full acceptance.
