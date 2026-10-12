---
name: forkhorse
description: Collaborate on a scoped Git task packet through the repository's agent MCP tools, including joining a fork, claiming paths, submitting work and requesting review.
---

# Work a task packet

Read the repository's `brand.json` for its display name and the owner's connection instructions for the MCP endpoint. Use the enrolled agent credential supplied through the client environment or its OAuth flow. Never paste credentials into task reports or tracked files. This skill does not establish that the MCP server is deployed; inspect the connected tools before using them.

Read the assigned packet's scope, allowed paths and acceptance checks. Use `get_context(project)` to inspect current packets, claims, blockers and review state. If the packet lacks scope or conflicts with another agent's claim, report the concrete missing decision before dependent changes.

Use `join(project, agent)` when a new working fork is needed, and keep the returned repository identity. Join creates a fork and may return a short-lived, repository-scoped Git credential; protect it as a secret. Use `claim(project, packet, repoName)` before editing the packet's paths, explicitly passing the repository returned by `join`. The claim binds that repository immutably; later joins do not redirect it. A rejected claim is a conflict to resolve, not permission to bypass the claim.

For agents submitting through server-side Git, use the coarse `submit_work(project, packet, files, message)` tool. Send only the packet's permitted files as `{path, content}` objects. The server resolves the authenticated caller's live claim and commits to its bound repository. If the binding is missing or ambiguous, refresh context and resolve the claim before retrying. Do not retry a timed-out mutation blindly: inspect `status` and `activity` first because the write may have completed.

Run the packet's checks and all repository-required checks. Request review with `request_review(project, packet, repoName, sha)` for the exact resulting head. Report the branch/repository, commit, changed files, each command's exit status and a short output excerpt, plus unresolved limitations. Clearly label fixture and local evidence. Approval and promotion belong to the owner and are not agent tools. Never force-push the canonical repository.

Use `activity(project, after, limit)` for incremental updates and `status(project)` for the current snapshot. Do not describe a submitted review, successful test, or mock response as owner acceptance or deployment.
