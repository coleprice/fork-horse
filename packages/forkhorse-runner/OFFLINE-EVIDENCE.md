# FH-007 offline evidence

Status: offline acceptance passed. **Every container-port result is mocked.**
No container runs, deployment, live Cloudflare APIs, credentials, or spending
were used. Live acceptance and FH-005 integration remain pending.

Base: freshly fetched `main` at
`6544d967456b1966f7276df7d1a06b06672bc50a`.
Development branch: `fh/FH-007-runner`.
Upstream gitlink: `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`, unchanged.
Toolchain: Node `v24.21.0`, pnpm `11.17.0`.

Validation completed on 2026-10-12:

| Command | Exit | Output excerpt |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | `Scope: all 8 workspace projects`; `Already up to date` |
| `pnpm -C cloudflare-os install --frozen-lockfile` | 0 | `Scope: all 34 workspace projects`; `Already up to date` |
| `pnpm --filter forkhorse-runner test` | 0 | `Test Files 1 passed (1)`; `Tests 26 passed (26)` |
| `pnpm --filter forkhorse-runner types:check` | 0 | `tsc --noEmit` |
| `pnpm test` | 0 | root scripts 26; upstream scripts 374; runner 26; core 13; custom gatekeeper 2; upstream error reporting 23; error reporter 2, all passed |
| `pnpm lint` | 0 | `vp lint`; `tsc -p scripts/tsconfig.json`; six package builds completed |
| `git -c core.fsmonitor=false diff --check` | 0 | no output |
| `git -c core.fsmonitor=false -C cloudflare-os status --short` | 0 | no output |

The first root test attempt failed because the filesystem/network sandbox denied
localhost listeners (`listen EPERM: operation not permitted 127.0.0.1`). The
successful rerun enabled the existing local workerd test pools; those tests did
not run containers. The initial install for the added workspace package required
registry access and a noninteractive modules refresh; the frozen install passed
without dependency version changes. Two initial lint findings were corrected
before the final successful lint run.

D2 audit: only the new `packages/forkhorse-runner` importer was added to
`pnpm-lock.yaml` (15 lines); it reuses existing resolutions. No existing importer,
catalog, override, workspace configuration, core source, board, deployment file,
or upstream tracked file/gitlink changed.

Open dependencies and live checks are enumerated in the package README. In
particular, the authority must provide caller/fork authorization, execution
reservations, chunk-safe Supervisor storage, atomic digest attachment, default
approval enforcement, and the mandatory fresh pre-promote execution. No core
integration is claimed by these offline tests.
