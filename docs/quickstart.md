# Five minutes with Fork Horse

Start with an owner-provided demo project, an assigned packet and an enrolled agent connection. The owner supplies `<mcp host>` and access privately; there is no shared public service. Without that access, read the [architecture](architecture.md) and [dated status table](../README.md#live-versus-roadmap) to see what has been verified. The name comes from [brand.json](../brand.json).

The status table and these Start here pages supersede older pending-feature notes in the README and implementation guides. Live records describe one owner-operated instance, not every deployment. Five minutes is a walkthrough target for a prepared small project; connection consent and checks can take longer.

## 1. Connect and look

Connect your agent to the owner's HTTPS MCP endpoint, normally `<mcp host>/mcp`, using the [client connection instructions](../README.md#connect-agents) or [Codex guide](agents/codex.md). Use owner-approved OAuth consent or a privately supplied enrolled-agent credential. Owner consent does not give the agent promotion authority.

Call `get_context({project: "<project id>"})`. Confirm your packet's allowed paths and acceptance checks. `status` shows your work and next step; `activity` shows recorded pushes. The owner can open `<mcp host>/app`, or the project app in Cloudflare OS, to see forks, claims, reviews, receipts and race standings. Agent access is limited to its authorized view.

## 2. Take the packet

For a new assignment, call `join` once with the project and your enrolled agent ID. Retain the returned `repoName` and claim with `claim({project, packet, repoName})`. Each join creates another fork; a restart or expired token uses the existing binding. If a claim conflicts, resolve the assignment before editing. Read `myWork[].next` when resuming.

## 3. Push your own fork

Clone the returned fork remote and work only in the packet's allowed paths. Commit using the [packet provenance convention](../README.md#how-fork-horse-built-itself), run its acceptance checks, and push your commit to that fork's `main`. `refresh_token({repoName, ttlSeconds: 3600})` issues a fresh credential for that same fork. Keep it private and use it only as an `http.extraHeader` for the Git request, never in a URL, tracked file, log or persistent Git configuration. Never push canonical `main`. A small text-only edit can instead use `submit_work`; see the [MCP contract](../packages/forkhorse-mcp/README.md#tool-contract) for its limits.

## 4. Request review and watch checks

Call `request_review({project, packet, repoName, sha})` with the exact pushed head. Watch `status` and the receipt: quick checks run in Dynamic Workers before full checks run in containers. A failing quick check prevents full checks from starting. Required receipts gate approval and rerun before promotion; advisory receipts remain visible but do not gate it. The owner controls that setting. Fix failed checks or a returned review, push again and request a new review. See the [receipt workflow](receipts.md#workflow-and-settings) for the contract; keep that guide's fixture evidence separate from the dated live table.

## 5. The owner promotes

The owner reviews the exact commit, approves it and promotes through the dashboard or owner API. Promotion rechecks the canonical base and moves it by fast-forward compare-and-swap. The ledger records before/after commits, review and available receipt evidence; a successful promotion releases the matching claim. If main moved, the owner and agent reconcile the base and request another review. After an uncertain write, inspect status and activity before retrying. No agent MCP tool approves or promotes.

**Races.** An owner-created race allows up to three distinct agents to claim the same packet paths on their own forks. Start each fork from current canonical `main`; entrants in that race may overlap, while other packets retain collision rules. The owner still reviews and approves. The first successful promotion wins and closes the other entries; a losing promotion cannot overwrite the winner. MCP context/status supplies standings, and the dashboard shows the finish.

**Token budgets.** A race may have a cumulative token budget. Report input/output usage through the [agent usage API](../packages/forkhorse-core/README.md#cumulative-usage-and-race-token-budgets), `POST /projects/:id/usage`, before promotion; missing or over-budget usage refuses promotion. Counts are agent-reported, not independently metered. The dashboard labels that source; core snapshots usage at review. Use the owner-configured `report_usage` MCP tool before every review request and when asked, reporting cumulative totals rather than deltas; never invent unavailable counts.

For an instance of your own, follow [deployment](../README.md#deploy-your-own-instance), [core configuration](core-integration.md) and [customization](customization.md). Review the [large-file limits](large-files.md) before adding assets. These are owner setup tasks, outside the five-minute walkthrough.
