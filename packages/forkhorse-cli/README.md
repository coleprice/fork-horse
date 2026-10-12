# Owner CLI

A small Node CLI for the existing core HTTP contract. Display names and the executable
name come from the root `brand.json`. It requires Node 24.19 or newer. The package's
`bin` entry exposes `forkhorse` after building/linking it; from the workspace, invoke
the built entrypoint directly:

```sh
pnpm --filter forkhorse-cli build
node packages/forkhorse-cli/dist/main.js --help
```

This package does not provision, deploy, log in, or configure Cloudflare. Tests use an
in-process synthetic loopback HTTP server, not live core/Artifacts acceptance.

## Configuration

Pass `--base-url <https-origin>` or `--config <json-file>`. Flags override config.
The base URL must be the core origin, with no path, credentials, query or fragment.
Loopback HTTP is permitted for fixture tests only. Example owner-local config:

```json
{
  "baseUrl": "https://core.fixture.idiot.tax",
  "project": "demo",
  "mcpPath": "/mcp"
}
```

The hostname above is fictional. Only these three fields are accepted. Keep actual
owner endpoints/config outside tracked files. API commands read the credential only
from `FORKHORSE_OWNER_API_TOKEN`, populated by your private secret delivery mechanism.
The CLI never prints or logs that value, including with `--show-once`. It does not
read `deployment.local.jsonc`, browser cookies, or the owner's credential store.

## Commands

In these examples, `forkhorse` refers to the linked executable; the built Node entry
above accepts identical arguments. Assume the owner credential is already in the
environment. No credential value belongs in a command, snippet, config or history.

```sh
forkhorse project create demo --base-url "$CORE_BASE_URL" --agents claude,codex,cfos --output "$PRIVATE_TOKEN_FILE"
forkhorse project create imported-demo --config "$CLI_CONFIG" --source https://git.idiot.tax/public/template.git --agents claude,codex --output "$PRIVATE_TOKEN_FILE"
forkhorse agent enroll builder --config "$CLI_CONFIG" --output "$NEW_PRIVATE_TOKEN_FILE"
forkhorse agent rotate builder --config "$CLI_CONFIG" --show-once
forkhorse packet create packet.yaml --config "$CLI_CONFIG"
forkhorse state --config "$CLI_CONFIG"
forkhorse activity --config "$CLI_CONFIG" --after 0 --limit 100 --follow
forkhorse connect codex codex --config "$CLI_CONFIG"
forkhorse connect claude claude --config "$CLI_CONFIG" --mcp-path /mcp
forkhorse demo seed --config "$CLI_CONFIG" --output "$PRIVATE_TOKEN_FILE"
```

Enrollment, rotation, project creation and demo seeding require exactly one of:

- `--output <new-file>`: exclusively creates a new file with mode **0600**, refusing
  existing files and symlinks before making a request. Saves only `{project,agents:
  [{agent,apiToken}]}`. It never echoes file contents or its path. POSIX file permissions
  are required for this protection; the permission tests run on a POSIX filesystem.
- `--show-once`: deliberately prints only validated one-time agent API credentials to
  stdout. Extra response credentials, Git tokens and owner credentials remain hidden.

Core returns these credentials once. Save and distribute the file privately. No
credential storage, recovery, automatic enrollment retry, or credential display
command exists. Ordinary state/activity/packet/project output redacts credential
fields recursively, API-token patterns, bearer/JWT text, and the exact owner value.
`--show-once` is rejected for ordinary reads and connection snippets. Errors show fixed
local messages or the HTTP status; raw core/network/parser errors are never printed.

`project create` uses `POST /projects`; `--source` maps to `sourceUrl`. Core validates
the public source host. Agent commands use `POST /projects/:id/agents` with `{agent}`
or `POST /projects/:id/agents/:agent/rotate` with `{}`. Rotation invalidates the old
agent API credential; it does not revoke still-valid short-lived Git tokens.

`--project` (or config `project`) is required for agent/packet/state/activity commands.
`project create <id>` selects its positional ID. `demo seed` uses the configured ID,
or `demo` if none was supplied. It performs real writes against the chosen core API:
one project, three agents (`claude`, `codex`, `cfos`), and three packets. Two packets
share `src/shared/**` so different agents attempting claims will conflict; the third
owns `docs/**`. Titles/goals label the content synthetic. Seeding makes no claims,
joins, commits, subscriptions or pushes. Repeating an existing project fails with
409; it does not overwrite or adopt it. Tokens are saved before packet creation,
so a later packet failure leaves the issued credentials available to the owner.

## Packet input

JSON accepts exactly `{id,title,goal,paths,acceptance}`. The small YAML subset accepts
top-level string scalars and two-space-indented lists of strings, blank lines and
whole-line comments. Quote strings using JSON double quotes or YAML single quotes.
Inline comments, flow arrays/maps, aliases, tags and multiline scalars are unsupported;
use JSON for more complex input. Files and encoded request bodies are limited to
16 KiB; core remains authoritative for packet paths and validation.

```yaml
# Synthetic packet example
id: demo-ui
title: Synthetic UI packet
goal: Exercise the demo workflow
paths:
  - src/shared/**
  - src/ui/**
acceptance:
  - Run assigned checks
```

## Activity and connections

`activity` prints one JSON page. `--follow` polls using the returned exclusive
`nextAfter` cursor, drains full pages immediately and waits between other pages.
`--interval-ms` defaults to 1000 (range 250–60000); `--limit` is 1–100. Ctrl-C/SIGTERM
stops a follow session cleanly. Invalid/nonadvancing cursors fail closed. There is no
SSE stream or retry loop. A network failure exits nonzero without advancing the cursor.

`connect` makes no network request and needs no owner credential. It names the MCP
server using the current brand slug and agent ID. Set `AGENT_CORE_API_TOKEN` privately
to that enrolled agent's API credential in the client's environment. Codex output is
the exact `codex mcp add … --url … --bearer-token-env-var AGENT_CORE_API_TOKEN` command;
Claude Code output is a `.mcp.json` entry with HTTP transport and the literal header
`Bearer ${AGENT_CORE_API_TOKEN}`. Merge that entry into the local client config; do
not paste an actual token there. The snippet does not prove enrollment or connection.
The endpoint uses the owner's origin and configured MCP path, not a brand domain.

Sources: [merged Codex connection contract](../../docs/agents/codex.md),
[core composition](../../docs/core-integration.md),
[core routes](../forkhorse-core/README.md), and
[Claude Code env expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).
Codex's local `mcp add --help` was also checked for the bearer-env option.

All HTTP requests refuse redirects, have a 25-second deadline through response
reading, and cap decoded JSON responses at 1 MiB. Writes are not automatically retried:
a timeout, cancellation or file-write failure may follow a write already accepted by
core. Inspect state before retrying. If credentials were issued but could not be
saved, rotate them. A partially written credential file is preserved for inspection.

## Offline checks

```sh
pnpm --filter forkhorse-cli test
pnpm --filter forkhorse-cli types:check
pnpm --filter forkhorse-cli build
pnpm test
pnpm lint
```

The Node fixture suite exercises exact routes/bodies, owner credential confidentiality,
one-time token output, redaction, exclusive 0600 files, safe input rejection, polling,
connection snippets, deliberate demo overlap and partial seeding failure. This CLI
does not run on Workers; workerd acceptance applies to the deployed core packages,
which the root suite checks separately. Live clients, Access, core and provider
behavior remain separate acceptance gates.
