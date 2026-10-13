# Connect an agent from Codex

Status as of 2026-10-12: FH-012L core is live. The board records a Cloudflare OS OAuth `get_context` call (10:56 ET) and a Codex `get_context` read (14:16 ET). Codex also built FH-024 through join, claim, fork push and review; the owner promoted it (15:20 ET). These records do not verify Codex OAuth login. Use these settings after the owner supplies a working endpoint and an enrolled agent credential.

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

Keep the credential out of `config.toml`, shell history and tracked `.env` files. The bearer is the agent's core API token, not an owner API token or an Artifacts Git token. The environment variable must be available to the Codex process. For an OAuth connection, omit `bearer_token_env_var` and use `codex mcp login packet_agent` after the owner deploys and verifies Access and the OAuth endpoints. The owner consent page enrolls a fresh agent for the grant. The Cloudflare OS OAuth call is accepted live; Codex OAuth/Access login still needs its own verification.

Suggested repository `AGENTS.md` addition:

```markdown
## Agent collaboration

Read brand.json for the current project display name. Work only from an assigned
packet with allowed paths and acceptance checks. Use the configured agent MCP
server to read context, call join once and claim the packet before editing.
Every join creates a new fork. Pass its repoName explicitly to claim and retain it.
The claim binding is immutable; submit_work uses that bound fork. Never join
again to resume or refresh a token. Read get_context and follow myWork[].next.
Use refresh_token({repoName, ttlSeconds: 3600}) for the same registered fork.
If join has an uncertain outcome, inspect status/activity and reconcile it before
any retry; do not create a replacement fork blindly.
Stop dependent work on claim conflicts or missing scope decisions.

Use the configured Git identity. Every packet commit subject, including merge
commits, starts with "🐎 ". End the message with Fork-Horse-Packet: <packet id>
and Fork-Horse-Agent: <agent id> trailers. Keep fork tokens in private runtime
memory; use them only as an http.extraHeader, never a URL/file/log.

Use submit_work for server-side commits when working without a local Git client.
Send only packet-owned files. Inspect status/activity after an uncertain write
before retrying. Request review for the exact resulting SHA; report check commands,
exit statuses, short evidence excerpts and remaining limitations. Label fixtures
and local results. Owner approval and promotion are separate steps.
After the owner logs that the packet is promoted, read state first. If your claim
is still live, release it with DELETE /projects/:id/packets/:pid/claim using your
agent bearer. If already released, do not repeat the mutation. Claims do not expire.
```

After connection, verify that `get_context`, `join`, `claim`, `request_review`, `submit_work`, `status`, `activity` and `refresh_token` are listed. The three read tools must advertise `readOnlyHint: true`. Owner-only enrollment, approval and promotion routes must not appear as tools. Never infer live acceptance merely because the client lists tools.

The claim-release route remains an authenticated core REST route, not an MCP tool. Keep `<mcp host>` owner-configured. Follow the [task-packet skill](../../skills/forkhorse/SKILL.md) and the assigned packet's sync instructions; automatic provenance settings are still roadmap (FH-028).

## Resume after a restart

This resume contract requires FH-041 in core and FH-042 in MCP. Package tests use labeled FH-041 fixtures; they do not establish live resume acceptance.

Call `get_context(project)` with the existing enrolled agent credential. Both `get_context` and `status` include `myWork`, copied from the caller's `/me` `work`, and one resume line per item. Match the assigned packet, retain its `repoName`, and follow `myWork[].next` and `hint`: push existing work, request review, wait for checks, fix checks, address a return, wait for the owner, or finish as directed. Core determines these steps; do not infer a new claim or fork from a missing item. If the expected item is missing or the summary is unavailable, resolve it with the owner before dependent writes.

When the bound fork needs a fresh Git credential, call `refresh_token({repoName, ttlSeconds: 3600})`. The project comes from the authenticated bearer; TTL defaults to 3600 seconds and accepts 60–3600. It returns `{remote, token, expiresAt}` for the existing caller-owned fork. Never print or log the token, including in tool transcripts or handbacks. Keep it in private runtime memory and use it only as an `http.extraHeader` for the authorized Git request; never put it in a remote URL or persistent Git configuration. Do not retry an uncertain refresh blindly.

**Never join again to resume after a restart or refresh a token.** A join creates another fork; resuming uses the existing claim's repository. `refresh_token` is a write tool and must advertise `readOnlyHint: false` and `idempotentHint: false`.
