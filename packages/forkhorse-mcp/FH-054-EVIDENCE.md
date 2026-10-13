# FH-054 local integration checkpoint

Branch: `fh/FH-054-mcp-races`.

Original base: `fc6cfa3216ad9112995d9a0ddb99b635fb2051fe` (the coordinator-supplied, freshly fetched `origin/main`; verified locally before branch creation).

Original fixture build: `7d21977f179cc91652000ffb10f45cfb5c0b3046`, against fixed FH-052/053 packet contracts and read-only FH-052 checkpoint `8d59850bd1d7442d52b018c4dfd7eb5a8023ecd8`. That build did not merge feature core. All task-owned edits remain inside `packages/forkhorse-mcp/**`.

The coordinator's 11:53 integration go authorized a plain merge of freshly fetched `origin/main` at `3320e7989124cc0604ce38b8ad5f440893251387`. Fetch succeeded and the ref matched exactly. Merge `d9868b1773d9bdea3e23c29652f69689a19c683b` has parents `7d21977f179cc91652000ffb10f45cfb5c0b3046` and `3320e7989124cc0604ce38b8ad5f440893251387`, without conflicts or rebase. Core changes are inherited from authorized main; no task-owned core edits were made.

## Behavior

- Read tools expose packet mode, defaulting legacy packets to standard; add caller-scoped `myRaces` while preserving project-wide race state and authoritative `/me` work/hints.
- Standings retain all entrants, milestone timestamps, places, closure, winner, string ledger ID and photo-finish rejection evidence, including after caller closure.
- Claims keep the existing caller-authenticated route and fork argument. Core owns the three-ever-entrants cap, no re-entry and cross-packet conflict enforcement.
- Race commits resolve the caller's open entrant fork. Closed, foreign, duplicate, missing, inconsistent or finished bindings refuse before commit, without standard-claim fallback. Existing standard binding checks remain.

## Original fixture verification

These are **offline fixture checks** using existing MCP package dependencies made available locally, not a fresh install or fresh clone. The workerd fixtures block outbound fetch. They do not exercise live Cloudflare or the core race implementation.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp exec vitest run --project workerd __tests__/workerd/races.test.ts` | 0 | Six race contract tests passed in actual workerd. |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp test:run` | 0 | 52 tests passed across five files, including Node and workerd projects. |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp types:check` | 0 | `tsc --noEmit` passed. |
| Targeted `vp lint`, using the repository's lint object exported to temporary JSON, on `packages/forkhorse-mcp` | 0 | No lint findings. |
| `git -c core.fsmonitor=false diff --check` | 0 | No whitespace errors. |

The default pnpm typecheck invocation initially exited 1 because automatic workspace installation could not find the uninitialized upstream `@gadgets/scripts` workspace package. Dependency verification was disabled for the focused checks rather than initializing upstream or installing the full workspace. A sandboxed workerd launch initially exited 1 with `listen EPERM` on loopback; the authorized local-runtime retry passed. SDK source-map warnings about missing original sources remain non-failing.

Untracked local logs: `FH-054-mcp-suite.log`, `FH-054-mcp-types.log`, `FH-054-mcp-lint.log`. The handback names their local locations and the final commit SHA; logs are not tracked because they contain machine paths.

## Pending gates

- Authorized main integration is complete. This checkpoint is local only, with operator publication pending.
- Full-root `pnpm test` and `pnpm lint`, the fresh-clone suite and D5 require coordinator reservation and were not run.
- No live race, provider, deployment, credentials, token refresh, spend or push was attempted.

## Integrated focused verification

The integrated wire adds `places: [{agent, place}]` and explicitly returns `promoteRejected: null` when absent. MCP now preserves both. `generate-race-wire-fixture.mjs` reads the integrated core's pure `raceStates`, `publicPacket` and `resumeWork` sources and executes them against offline in-memory records. The generated JSON is consumed by MCP workerd tests and includes open and finished race snapshots plus the caller's real mapper-produced resume summary. This checks the MCP wire boundary; it is not acceptance of core Worker execution, promotion transactions or live race behavior.

| Command | Exit | Result |
| --- | --- | --- |
| `node packages/forkhorse-mcp/__tests__/generate-race-wire-fixture.mjs --check` | 0 | Saved fixture matches current integrated core mapper output. |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp exec vitest run --project workerd` | 0 | 34 tests passed across three workerd files, including seven race tests. |
| `pnpm --config.verify-deps-before-run=false --filter forkhorse-mcp types:check` | 0 | `tsc --noEmit` passed. |
| Targeted `vp lint`, using the repository's lint object exported to temporary JSON, on `packages/forkhorse-mcp` | 0 | No lint findings. |
| `git -c core.fsmonitor=false diff --check` | 0 | No whitespace errors. |

Local untracked integration logs: `FH-054-integrated-wire.log`, `FH-054-integrated-workerd.log`, `FH-054-integrated-types.log`, `FH-054-integrated-lint.log`. Node's experimental type-stripping warning and the SDK's missing source-map warnings are non-failing. Full-root, fresh-clone and D5 checks were not run during integration. Live core race verification remains pending according to the coordinator; no live acceptance claim is made here.
