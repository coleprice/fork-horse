---
name: forkhorse
description: Collaborate on a scoped Git task packet through the repository's agent MCP tools, including joining a fork, claiming paths, submitting work and requesting review.
---

# Work a task packet

Read the repository's `brand.json` for its display name and the owner's connection instructions for the MCP endpoint. Use the enrolled agent credential supplied through the client environment or its OAuth flow. Never paste credentials into task reports or tracked files. This skill does not establish that the MCP server is deployed; inspect the connected tools before using them.

Read the assigned packet's scope, allowed paths and acceptance checks. Use `get_context(project)` to inspect current packets, claims, blockers and review state. If the packet lacks scope or conflicts with another agent's claim, report the concrete missing decision before dependent changes.

Call `join(project, agent)` **once** for the packet, and retain the returned `repoName` and remote. Every join creates a new fork; it is not a token-refresh operation. Join may return a short-lived, repository-scoped Git credential; keep it in private runtime memory, never a URL, file or log. Use `claim(project, packet, repoName)` before editing the packet's paths, explicitly passing that exact repository. The claim binds it immutably; later joins do not redirect it. A rejected claim is a conflict to resolve, not permission to bypass the claim. If join times out or has an uncertain outcome, inspect `status`/`activity` and reconcile the created fork before any retry; never blindly join again.

## Resume after a restart

Call `get_context(project)` with the existing agent credential before continuing. `get_context` and `status` include `myWork` from the caller's `/me` `work`, plus one resume line per item. Find the assigned packet, keep its `repoName`, and follow `myWork[].next` and `hint`. Core decides whether to push, request review, wait for checks, fix checks, address a return, wait for the owner, or finish. If the expected work is absent or the summary unavailable, resolve it with the owner before dependent writes. This contract requires FH-041 in core; labeled fixtures do not establish live availability.

Use `refresh_token({repoName, ttlSeconds: 3600})` when the existing bound fork needs a new credential. The authenticated bearer determines the project. TTL defaults to 3600 seconds, within 60–3600. This write tool returns `{remote, token, expiresAt}`. Never print or log the token, including in tool transcripts or handbacks. Keep it in private runtime memory and use it only as an `http.extraHeader` for the authorized Git request, never in a URL or persistent Git configuration. Do not retry an uncertain refresh blindly.

**Never join again to resume or refresh a token.** Continue on the same registered fork and immutable claim.

## Submit the assigned work

Use the repository's configured Git identity. Every packet commit subject, including merge commits, starts with `🐎 `. End each commit message with these trailers, filled with the assigned packet and authenticated agent:

```text
Fork-Horse-Packet: <packet id>
Fork-Horse-Agent: <agent id>
```

Apply the same message convention when calling `submit_work`; automatic commit-mark settings are still roadmap (FH-028). Follow the assigned packet's sync instructions before review. Push only the authorized agent fork ref, with its scoped token; a request to work through this service does not grant a GitHub push or owner promotion.

For agents submitting through server-side Git, use the coarse `submit_work(project, packet, files, message)` tool. Send only the packet's permitted files as `{path, content}` objects. The server resolves the authenticated caller's live claim and commits to its bound repository. If the binding is missing or ambiguous, refresh context and resolve the claim before retrying. Do not retry a timed-out mutation blindly: inspect `status` and `activity` first because the write may have completed.

Run the packet's checks and all repository-required checks. Before **every** `request_review` and whenever asked, call `report_usage({project, packet, inputTokens, outputTokens, model?})` with cumulative packet totals, not deltas. Each token count must be an integer from 0 to 1,000,000,000; counts may not decrease. These counts are **self-reported**, not provider-metered. If usage is unavailable, disclose that to the owner instead of inventing counts. Core records usage on your live claim or race entrant and snapshots it on the review. Inspect `get_context` or `status` for `myUsage`: caller-owned claims and race entrants with both usage sources, the token budget, and core's `unchecked`, `within`, `near` or `over` budget state. Null usage is unknown, not zero. Budgeted races require a report before promotion and refuse over-budget entrants. This contract requires FH-060 in core; labeled package fixtures do not establish live availability. After a conflict or uncertain reporting outcome, inspect status before retrying.

Request review with `request_review(project, packet, repoName, sha)` for the exact resulting head. Report the branch/repository, commit, changed files, each command's exit status and a short output excerpt, plus unresolved limitations. Clearly label fixture and local evidence. Approval and promotion belong to the owner and are not agent tools. Never force-push the canonical repository.

Use `activity(project, after, limit)` for incremental updates and `status(project)` for the current snapshot. Do not describe a submitted review, successful test, or mock response as owner acceptance or deployment.

After the owner records that your packet is **promoted**, read state first. If your own claim remains live, release it with the agent bearer through `DELETE /projects/:id/packets/:pid/claim`. If the owner already released it, do not repeat the mutation. Claims do not expire automatically; retaining a finished claim can block the next packet or canonical sync. Claim release is an authenticated REST operation, not an owner approval or another MCP tool.
