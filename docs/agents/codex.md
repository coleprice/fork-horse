# Connect an agent from Codex

Status: FH-004/FH-004b and the FH-012 core composition are built and offline-tested, including workerd integration. FH-012L live deployment and client login remain unverified. Use these settings only after the owner supplies a working endpoint and an enrolled agent credential.

Read `brand.json` for the current display name. Obtain the endpoint from the owner's `deployment.local.jsonc` configuration. Its host and path are owner configuration, separate from branding; do not commit the owner's actual endpoint or credentials to this repository.

The [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp) describes Streamable HTTP, environment-sourced bearer tokens and OAuth login. The installed Codex CLI's `codex mcp add --help` also confirms the URL and bearer-token environment options. With `AGENT_MCP_URL` set to the owner-provided endpoint and `AGENT_CORE_API_TOKEN` set through the owner's secret delivery mechanism, register the server:

```sh
codex mcp add packet_agent --url "$AGENT_MCP_URL" --bearer-token-env-var AGENT_CORE_API_TOKEN
```

Equivalent `config.toml` entry (replace the placeholder locally):

```toml
[mcp_servers.packet_agent]
url = "<OWNER_CONFIGURED_HTTPS_MCP_ENDPOINT>"
bearer_token_env_var = "AGENT_CORE_API_TOKEN"
```

Keep the credential out of `config.toml`, shell history and tracked `.env` files. The bearer is the agent's core API token, not an owner API token or an Artifacts Git token. The environment variable must be available to the Codex process. For an OAuth connection, omit `bearer_token_env_var` and use `codex mcp login packet_agent` after the owner deploys and verifies Access and the OAuth endpoints. The owner consent page enrolls a fresh agent for the grant. Local fixture tests verify the provider flow; live Codex/Access login remains unverified.

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
