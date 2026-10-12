# Local acceptance fixtures

These helpers use only synthetic accounts, credentials and model responses. The Git
repository and HTTP Git protocol are real. Nothing contacts a live Core, Artifacts
account or model provider. Never deploy `offline-worker.js`.

## Kernel S7 and CAS race

From the repository root:

```sh
pnpm --filter forkhorse-gatekeeper build
pnpm --filter forkhorse-gatekeeper test:local
```

The runner creates a disposable bare repository and local Git HTTP server, builds
required upstream generated modules outside the checkout, executes the native
workerd test and removes its temporary files. The native test verifies the exact
remote commit/file after approval and rejection of a real receive-pack CAS race.

## Full pinned OS S7/S9

Run the following from the repository root after frozen installs in both workspaces:

```sh
pnpm --filter forkhorse-gatekeeper build
pnpm --filter forkhorse-gatekeeper exec vite build --config vite.run-local.config.ts --mode full-os
pnpm --filter forkhorse-gatekeeper exec node test/local/prepare-full-os.ts
```

The last command prints a disposable directory containing an archive of the exact
reviewed upstream pin and a new fixture extension. None of the archived upstream
source is changed. In that directory run the unchanged upstream entrypoint with an
empty HOME and environment; substitute the printed directory for `FIXTURE_DIR`:

```sh
env -i PATH="$PATH" HOME="FIXTURE_DIR/empty-home" CI=1 WRANGLER_SEND_METRICS=false pnpm run-local --port 4180
```

This bootstrap downloads registry dependencies. It uses the fixture HOME for local
OS state and does not load an owner's deployment config or Cloudflare credentials.
Use separate terminals for the loopback fixture and API driver:

```sh
pnpm --filter forkhorse-gatekeeper exec node test/local/run.ts --serve
node packages/forkhorse-gatekeeper/test/local/full-os-client.ts
```

The server listens only on `127.0.0.1:4181`. The test Worker forwards only its two
fixed fictional Core/Git origins there. The OS model uses a deterministic local
Anthropic-protocol endpoint that emits a fixed tool sequence; this is a protocol
fixture, not inference or an evaluation of model quality. The real OS executes
`getHead`, `createWorktree`, edits, commit and push submission. The driver asserts
that Git has not moved before approving the native OS action, then verifies the
exact remote head and file. It prints `FULL OS ACCEPTANCE` on success.

Restart the fixture server for each full S7 run to obtain fresh Git and model
sequence state. Stop with SIGTERM or Ctrl-C; the runner cleans its temporary Git
repository. Stop the OS process and its watcher children after browser checks.
Do not delete another task's listeners or an owner's data to free these ports.

For S9, sign into `http://localhost:4180` using the synthetic username printed by
the driver and password `local-fixture-only`. Open the branded app. Its explicitly
labeled Core snapshots advance every quarter second through the real account and
OS host limiter. Check section links, wait over one minute, then use Ask an agent:
the Home composer should contain the project prompt, without sending a message.
The resource picker should list only `fork-alpha` and enable Add connection after
selection. No external model is needed for these browser checks.

The API driver validates the actual OS connection/handoff contract. It does not
claim the entire popup UX was browser-automated. Browser automation could not adopt
the disowned popup; manual form submission and API redemption were checked
separately. The popup path remains a manual acceptance item.
