---
name: forkhorse
description: Collaborate on a scoped Git task packet through the repository's agent MCP tools, including joining a fork, claiming paths, submitting work and requesting review.
---

# Work a task packet

Read the repository's `brand.json` for its display name and the owner's connection instructions for the MCP endpoint. Use the enrolled agent credential supplied through the client environment or its OAuth flow. Never paste credentials into task reports or tracked files. This skill does not establish that the MCP server is deployed; inspect the connected tools before using them.

Read the assigned packet's scope, allowed paths and acceptance checks. Use `get_context(project)` to inspect current packets, claims, blockers and review state. If the packet lacks scope or conflicts with another agent's claim, report the concrete missing decision before dependent changes.

Call `join(project, agent)` **once** for the packet, and retain the returned `repoName` and remote. Every join creates a new fork; it is not a token-refresh operation. Join may return a short-lived, repository-scoped Git credential; keep it in private runtime memory, never a URL, file or log. Use `claim(project, packet, repoName)` before editing the packet's paths, explicitly passing that exact repository. The claim binds it immutably; later joins do not redirect it. A rejected claim is a conflict to resolve, not permission to bypass the claim. If join times out or has an uncertain outcome, inspect `status`/`activity` and reconcile the created fork before any retry; never blindly join again.

Refresh an expired fork token through the authenticated core REST route `POST /projects/:id/forks/:repo/token` (the project-relative route is `POST /forks/:repo/token`). Use the agent bearer and body `{"scope":"write","ttlSeconds":3600}` for the **same registered fork**. The response contains a new scoped token and expiry. Pass the Git token only through an HTTP authorization header. The token route is not an MCP tool; `<mcp host>` is owner configuration, separate from branding.

Use the repository's configured Git identity. Every packet commit subject, including merge commits, starts with `🐎 `. End each commit message with these trailers, filled with the assigned packet and authenticated agent:

```text
Fork-Horse-Packet: <packet id>
Fork-Horse-Agent: <agent id>
```

Apply the same message convention when calling `submit_work`; automatic commit-mark settings are still roadmap (FH-028). Follow the assigned packet's sync instructions before review. Push only the authorized agent fork ref, with its scoped token; a request to work through this service does not grant a GitHub push or owner promotion.

For agents submitting through server-side Git, use the coarse `submit_work(project, packet, files, message)` tool. Send only the packet's permitted files as `{path, content}` objects. The server resolves the authenticated caller's live claim and commits to its bound repository. If the binding is missing or ambiguous, refresh context and resolve the claim before retrying. Do not retry a timed-out mutation blindly: inspect `status` and `activity` first because the write may have completed.

Run the packet's checks and all repository-required checks. Request review with `request_review(project, packet, repoName, sha)` for the exact resulting head. Report the branch/repository, commit, changed files, each command's exit status and a short output excerpt, plus unresolved limitations. Clearly label fixture and local evidence. Approval and promotion belong to the owner and are not agent tools. Never force-push the canonical repository.

Use `activity(project, after, limit)` for incremental updates and `status(project)` for the current snapshot. Do not describe a submitted review, successful test, or mock response as owner acceptance or deployment.

After the owner records that your packet is **promoted**, read state first. If your own claim remains live, release it with the agent bearer through `DELETE /projects/:id/packets/:pid/claim`. If the owner already released it, do not repeat the mutation. Claims do not expire automatically; retaining a finished claim can block the next packet or canonical sync. Claim release is an authenticated REST operation, not an owner approval or another MCP tool.
