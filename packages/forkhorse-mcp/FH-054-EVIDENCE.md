# FH-054 local fixture checkpoint

Branch: `fh/FH-054-mcp-races`.

Base: `fc6cfa3216ad9112995d9a0ddb99b635fb2051fe` (the coordinator-supplied, freshly fetched `origin/main`; verified locally before branch creation).

Wire reference: fixed FH-052/053 packet contracts and read-only FH-052 checkpoint `8d59850bd1d7442d52b018c4dfd7eb5a8023ecd8`. No feature-core commit was merged. Only `packages/forkhorse-mcp/**` changes belong to this checkpoint.

## Behavior

- Read tools expose packet mode, defaulting legacy packets to standard; add caller-scoped `myRaces` while preserving project-wide race state and authoritative `/me` work/hints.
- Standings retain all entrants, milestone timestamps, places, closure, winner, string ledger ID and photo-finish rejection evidence, including after caller closure.
- Claims keep the existing caller-authenticated route and fork argument. Core owns the three-ever-entrants cap, no re-entry and cross-packet conflict enforcement.
- Race commits resolve the caller's open entrant fork. Closed, foreign, duplicate, missing, inconsistent or finished bindings refuse before commit, without standard-claim fallback. Existing standard binding checks remain.

## Verification

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

- Accepted FH-052 is required before merge. This checkpoint is local only, with operator publication pending.
- Full-root `pnpm test` and `pnpm lint`, the fresh-clone suite and D5 require coordinator reservation and were not run.
- No live race, provider, deployment, credentials, token refresh, spend or push was attempted.
