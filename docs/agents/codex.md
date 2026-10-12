# Connect an agent from Codex

Status: the FH-004 library is implemented and tested against local fixtures. FH-012 must integrate and deploy it. Use these settings only after the owner supplies a working endpoint and an enrolled agent credential.

Read `brand.json` for the current display name. Obtain the endpoint from the owner's `deployment.local.jsonc` configuration. Its host and path are owner configuration, separate from branding; do not commit the owner's actual endpoint or credentials to this repository.

The installed Codex CLI's `codex mcp add --help` confirms Streamable HTTP configuration and the bearer-token environment option. With `AGENT_MCP_URL` set to the owner-provided endpoint and `AGENT_CORE_API_TOKEN` set through the owner's secret delivery mechanism, register the server:

```sh
codex mcp add packet_agent --url "$AGENT_MCP_URL" --bearer-token-env-var AGENT_CORE_API_TOKEN
```

Equivalent `config.toml` entry (replace the placeholder locally):

```toml
[mcp_servers.packet_agent]
url = "<OWNER_CONFIGURED_HTTPS_MCP_ENDPOINT>"
bearer_token_env_var = "AGENT_CORE_API_TOKEN"
```

Keep the credential out of `config.toml`, shell history and tracked `.env` files. The bearer is the agent's core API token, not an owner API token or an Artifacts Git token. The environment variable must be available to the Codex process. For an OAuth connection, omit `bearer_token_env_var` and use `codex mcp login packet_agent` after FH-012 enables owner Access and the OAuth endpoints. The owner consent page enrolls a fresh agent for the grant. Local fixture tests verify the provider flow; live Codex/Access login remains unverified.

Suggested repository `AGENTS.md` addition:

```markdown
## Agent collaboration

Read brand.json for the current project display name. Work only from an assigned
packet with allowed paths and acceptance checks. Use the configured agent MCP
server to read context, join your own fork and claim the packet before editing.
Pass the repoName returned by join explicitly to claim. The claim binding is
immutable; submit_work uses that binding even after later joins.
Stop dependent work on claim conflicts or missing scope decisions.

Use submit_work for server-side commits when working without a local Git client.
Send only packet-owned files. Inspect status/activity after an uncertain write
before retrying. Request review for the exact resulting SHA; report check commands,
exit statuses, short evidence excerpts and remaining limitations. Label fixtures
and local results. Owner approval and promotion are separate steps.
```

After connection, verify that `get_context`, `join`, `claim`, `request_review`, `submit_work`, `status` and `activity` are listed. The three read tools must advertise `readOnlyHint: true`. Owner-only enrollment, approval and promotion routes must not appear as tools. Never infer live acceptance merely because the client lists tools.
