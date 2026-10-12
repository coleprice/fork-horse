# FH-008 local handback

Status: **local S7/S9 verified; WIP publication, no merge or deployment**. The
private enrolled-agent vendor replaces the starter sample. Full popup UX remains a
manual check; native negative-RPC diagnostics remain disclosed below.

## Provenance and scope

- Branch: `fh/FH-008-gatekeeper`.
- Published checkpoints `4ed940969e1e3a6f48cbc6a1c35326f7665b443e`,
  `53bf918b14cb9dc7d95e9483efb28d2b40da7c1f` and
  `2a355a8e61bfb5aef4fe5d17683d57593f2c2e23` are preserved.
- Accepted FH-013 was integrated by normal merge `e99c96d`. Accepted main
  `ba05c76d7743278ede25880c197933a059279474`, including FH-016, was integrated by
  normal merge `7325fd3`. The two owned script edits were stashed before this merge
  and restored afterward; the one merge conflict combined the deployment-order
  helper with this vendor before implementing the sample replacement.
- Upstream remains pinned and unmodified at
  `8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf`. All 1,676 tracked files in the
  disposable full-OS archive were hash-compared to that pin: zero differences.
- Owned changes are confined to this package, its lockfile importer, deployment
  scripts and the template. Other changes arrive only through accepted main.
- No owner config, real credentials, external inference, Cloudflare operations,
  board edits, deployment or canonical Git writes were performed.

## Implementation and deployment

`UserAccount` stores an enrolled agent credential behind native capabilities.
Connection uses authenticated `/me`, a single-use nonce and the pinned kit handoff.
Reconnect is staged and retains the same origin/project/agent; revocation clears
local credentials and stops sidebar disclosure. Ownership is rechecked before
Git tokens are minted. The picker exposes only owned forks.

`getHead()` records an observation and advertises the exact commit. Pushes require
manual OS approval, a full SHA and a fast-forward on the fork's default branch.
Applying the action builds its scoped pack and sends a real old-SHA CAS through
kit transport with a git User-Agent. Tokens last 60 seconds and never reach the
agent or iframe. There is no force push, canonical write or rewriting revert.

An interrupted approval submission retains its intent and can retry with the same
gatekeeper action ID. If the OS queued it but lost its reply, that action remains
approvable/rejectable. Retries can produce duplicate OS rows; applying the same ID
is serialized and idempotent, so only one Git write occurs. If one duplicate is
rejected, remaining duplicates fail closed and can be rejected in the OS. Tests
cover both lost replies and duplicate application. Process-kill fault injection at
every individual instruction is not claimed.

The sidebar reuses the accepted dashboard's projection, mount function and CSS.
It exposes only read-only snapshot/subscription/poll methods, reauthorizes reads,
coalesces updates and stops on disposal. Capture interception plus transport
rejection disable owner actions. Its srcdoc section links scroll locally; Ask an
agent uses the actual OS `host.openPrompt` without submitting the prompt.

Deployment now omits the starter sample from generated configs, build/deploy order
and both consumers' bindings. The sample package remains as reference code. The
template enables the replacement vendor wiring; disabling it omits the vendor
entirely, without a sample fallback. Legacy sample settings/placeholders are
ignored. The new Worker gets its private BASE_URL and DO migrations and deploys
before Workshop/router. Router HTTP and Workshop vendor RPC use distinct bindings.
MCP remains installed as accepted in FH-016. Generated-config tests show exactly
one `GATEKEEPER_FORKHORSE` and no `GATEKEEPER_CUSTOM`; this is local wiring evidence,
not a claim about an installed owner's admin page.

## Local acceptance evidence

### S7: full OS server and real Git

The unchanged pinned OS ran in a disposable archive, with its own empty HOME and
synthetic user. A deterministic local Anthropic-protocol fixture supplied the tool
sequence; no model inference or provider was involved. The real OS executed:

1. Native account connection and handoff redemption.
2. Owned-fork resource selection, observed `getHead` and commit advertisement.
3. Its actual agent `createWorktree` tool, Git pull, read/write and commit.
4. Native pending approval with the remote unchanged and zero Git writes.
5. `approveAction`, action-scoped pack construction and successful Git CAS push.

Final receipt: old SHA `5713416f094424cc79f1f7cb8aa03ad6218437da`, new SHA
`0300b810687c0753b9cb715bc699fc5b842832c1`, one pull and one write. The actual bare
repository contained `After full run-local approval` in `README.md`. The browser
showed the same approved action, before/after SHAs, worktree head and file diff.

The separate native kernel test also passed a real receive-pack race: another
commit moved the branch after the gatekeeper read, Git rejected the old-SHA CAS,
the losing commit was absent and the OS action remained pending. This case uses
the native workerd kernel harness, distinct from the full-server positive flow.

### S9: full OS browser and default limiter

The final rebuilt sidebar advanced 347 labeled synthetic quarter-second batches
in 86.8 seconds through the actual native account and pinned OS host. Section
navigation preserved the iframe. Ask an agent navigated to Home with the expected
project prompt. That prompt was not sent. Earlier full-OS picker checks listed
only the connected fork, enabled Add connection after selection and added it to
the composer. The retained component harness also observed 598 batches in 150
seconds with one snapshot, one subscription and zero polls under the pinned
8-concurrent/600-per-minute/128-pending limiter.

On reopening the browser with an older synthetic account whose fixture identity
had changed, the sidebar correctly denied it. Signing into the fresh fixture
account succeeded. The stale-account denial is not suppressed or described as a
successful session. No subsequent error appeared during the final S7/S9 browser
interaction.

## Checks and reproduction

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0 on accepted merged workspace. |
| `pnpm --filter forkhorse-gatekeeper build` | Exit 0; browser/Worker types and all production bundle checks. |
| `pnpm --filter forkhorse-gatekeeper test` | Exit 0; 10 Node tests and 21 workerd tests. |
| `pnpm --filter forkhorse-gatekeeper test:local` | Exit 0; native kernel and real Git CAS race. |
| Full local OS API driver | Exit 0; receipt above, verified in the actual browser. |
| `pnpm test` | Exit 0; all repository suites, including package Node/workerd tests. |
| `pnpm lint` | Exit 0; lint, script types and workspace builds. |
| Pinned Wrangler dry-run with synthetic config | Exit 0; Worker bundling only, no owner config, networking or deployment. |
| Full-OS preparation helper | Exit 0; disposable exact-pin archive and separate fixture extension created. |
| `git diff --check` | Exit 0. |

See [the local harness guide](test/local/README.md) for reproducible preparation and
commands. Only this package's lockfile importer differs from accepted main. Full OS
bootstrap fetched registry dependencies; it was not a network-free installation.
Production `dist/worker.js` excludes the test-only Worker, synthetic credential and
model fixture. Deployment consumes only that production artifact.

## Explicit remaining boundaries

- The automated browser could not adopt the OS-created disowned popup. Browser
  form submission and the real OS API handoff were verified separately. The entire
  popup UX remains a manual acceptance item; no provider/install acceptance is claimed.
- Negative native RPC tests still emit expected exceptions and, in the Vitest worker
  pool, a hung-request diagnostic. A plain returned RpcTarget reproduces it while
  rejecting correctly, responding to a later ping and disposing. A standalone
  Miniflare control passes without the warning. The positive full-server flow and
  native kernel flow complete. The underlying pool/runtime cause remains unproven;
  logs are not filtered or suppressed.
- Pinned OS app discovery needed a reload after API-only account connection and
  selects the first management-UI account per vendor. This package does not change
  those upstream behaviors. Dashboard selector coupling remains guarded by tests.
- Live Core/Artifacts, owner installation, deployment, popup UX and production
  acceptance remain separate. No review/merge authority is inferred from checks.
