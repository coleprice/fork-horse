# Field notes from building on Cloudflare

These observations come from building Fork Horse against a pinned, unmodified Cloudflare OS and testing the owner-operated instance on 2026-10-12 and 2026-10-13. They describe the behavior we encountered, not a guarantee about every deployment or future release. The [architecture](architecture.md) explains the system; the [status table](../README.md#live-versus-roadmap) separates live checks from fixtures and pending work. The code name comes from [brand.json](../brand.json).

## 1. Artifacts log references

**Symptom:** a fork with commits looked empty to core, so review refused the commit as not being the fork head.

**Cause:** the live Artifacts log API returned no commits for `refs/heads/main`, while bare `main` worked. Our fixture had accepted the qualified form.

**What we did:** FH-020 introduced a shared bare-branch head reader at all three log call sites and changed the fixture to mirror the observed provider behavior. Qualified refs remain appropriate in the separate Git transport. The operator verified correct live heads and successful review/approval on 2026-10-12 at 12:11 ET.

**Suggestion:** document accepted reference forms per API, and reject an unsupported form explicitly rather than returning an empty history indistinguishable from an empty repository.

## 2. Repository event subscriptions

**Symptom:** creating another push subscription on the same repository returned HTTP 405. It was also unclear which token permission the subscription API needed.

**Cause:** the platform allowed one subscription per resource. The observed permission boundary was Queues Edit: the operator proved list, delete and create using that permission alone on 2026-10-12 at 10:14 ET.

**What we did:** core lists before creating and adopts an enabled matching repository/queue subscription. A subscription to a different queue remains a conflict requiring owner inspection; it cannot be silently adopted. See the [subscription contract](core-integration.md#per-repository-push-subscriptions).

**Suggestion:** state the one-subscription limit and required permission beside the create API, and return a conflict that identifies the existing subscription without exposing credentials. A documented idempotent create-or-adopt operation would simplify recovery after an uncertain response.

## 3. Repository tokens and Git Basic authentication

**Symptom:** the returned repository token shape and the working Git Basic-auth representation differed.

**Cause:** the returned shape can include expiry metadata: `art_v1_…?expires=…`. Git Basic auth uses `x:` followed by the token portion before `?expires=`. These are shapes only, with no credential value shown.

**What we did:** the Git transport uses that token portion and a git-style User-Agent. The operator verified `ls-remote` against an agent fork on 2026-10-12 at 09:48 ET. Scope, expiry and revocation still apply; formatting is not authorization.

**Suggestion:** return credential material and expiry as separate fields, with a tested Git Basic-auth example and clear guidance about URL suffixes. Keep examples entirely synthetic.

## 4. Redirect handling in workerd

**Symptom:** a Git clone worked in Node but failed in the Worker runtime; MCP had encountered the same boundary earlier.

**Cause:** workerd rejected `fetch` with `redirect: "error"`, accepting only follow or manual. Tests that replaced `globalThis.fetch` hid RequestInit validation.

**What we did:** FH-004b and FH-021 use `redirect: "manual"` for outbound subrequests and refuse every 3xx without following or exposing provider targets. Regression tests go through real workerd fetch with fixture peers. OAuth consent's own 302 response remains allowed only to the exactly registered callback; it is not an outbound fetch. The edge clone path was verified on 2026-10-12 at 12:43 ET.

**Suggestion:** document runtime differences next to RequestInit options and provide conformance examples that exercise native fetch validation. A stubbed transport test should be accompanied by a Worker runtime test.

## 5. Diagnosing a promote failure without leaking provider errors

**Symptom:** promote returned 502, while the live tail showed no exception useful for finding the failing stage.

**Cause:** core deliberately suppressed provider error text to keep credentials and URLs out of responses and logs, but initially had no safe correlation record.

**What we did:** FH-025 added one structured `core.error` record with a generated ID, allowlisted operation/stage labels and bounded name/code/status fields. The public 502 retains its generic message and adds the matching `diagnosticId`. Tests assert secret-like strings and provider URLs are absent and unsafe fields are dropped. This telemetry was accepted on 2026-10-12 at 13:25 ET; the telemetry change itself was not a speculative promote fix.

**Suggestion:** offer examples for safe stage-level diagnostics and correlation IDs across RPC boundaries, with tests for hostile error objects. Full error serialization is unnecessary to make a failure traceable.

## 6. Cloudflare OS integration boundaries

The pinned OS provides two routes: an MCP connector and a project-specific gatekeeper. The integration observations below came from the 2026-10-12 owner-operated checks; the cold-load observation was repeated on 2026-10-13.

| Symptom | Cause observed | What we did | Suggestion |
| --- | --- | --- | --- |
| A static bearer header or Access service token could not connect through the MCP Server connector. | That connector supports no-auth or OAuth, without configurable fixed headers. | Added OAuth discovery, registration, PKCE and owner consent. | Make supported auth modes visible before connection, and document the boundary for private services. |
| Consent failed with an owner-login error. | Access covered `/app` but not `/authorize`. Consent also needs an existing configured project to enroll into. | Covered `/authorize`, left MCP/OAuth discovery and bearer routes reachable by their clients, and preflighted the target project. | Provide an Access/OAuth route checklist and distinguish login failures from missing enrollment targets. |
| An agent tried public web fetch instead of the private integration. | The connection appeared as generic MCP Server; agent code is sealed and the host web-fetch path reaches public URLs only. | Named the connection and requested its tools explicitly; used a gatekeeper for typed project capabilities and sidebar UI. | Expose service identity in discovery and document how agents find an attached connection. |
| Embedded UI capabilities differed from a normal page. | The app frame declares `allow-scripts allow-modals` and clipboard-write permission, without same-origin, popups, camera or microphone. | Kept the sidebar within the frame's capabilities and used the supported connection flow. | Publish a capability matrix for app frames versus gadget UIs, including clipboard constraints. |
| Rail artwork needs to work in one color. | The OS renders it as a small, one-color mask. | Selected a silhouette suitable for the rail; cached connection metadata still requires reconnecting to see an icon change. | Document mask rendering, size and cache refresh beside the icon field. |
| Deployment interrupted the app connection and left a blank frame. | A 2026-10-12 observation recorded socket code 1006 cycling for roughly three minutes, including a 20+ second blank frame. A later cold load took 20–25 seconds well after deployment; deployment alone does not explain all loading delays. | Added loading/reconnect handling, reserved a recording freeze and pre-warmed/reloaded before capture. Recovery and latency remain limitations, not proven fixes. | Surface host loading/recovery state before app HTML arrives, and provide timing across the shell, capability relay and frame. |

## 7. Workers Builds token scope

**Symptom:** production and non-production branch builds use the same token, whose default permissions cover more than one Worker.

**Cause:** the documented auto-created token has Account Settings Read, Workers Scripts Edit, Workers KV Edit and Workers R2 Edit at account scope; Workers Routes Edit for all zones; and User Details and Memberships Read. Account-owned tokens already support per-Worker scope through “Specified Workers” (2026-09-15 changelog), but Workers Builds currently supports only user tokens.

**What we did:** the operator checked the token configuration documentation and scoping changelog on 2026-10-13, confirming the account-owned token capability and the token type Workers Builds accepts. Builds of non-production branches use the same token.

**Suggestion:** let Workers Builds use account-owned, Worker-scoped tokens.

## 8. Artifacts to Workers Builds — proposed next step

**Symptom:** canonical Git promotion and runtime deployment are separate owner operations today.

**Cause:** our deployment flow is separate from promotion, although the documented Workers Builds Artifacts integration can connect them. Pushes to the production branch deploy; other branches produce Worker Previews. The production branch must be `main`.

**What we did:** the operator verified the Artifacts integration documentation, updated 2026-10-01. Using it for “deploy on promote” from canonical `main` is our planned next step after the contest; it has not shipped in Fork Horse.

**Suggestion:** connect the documented integration to authorized promotion, retain the exact promoted commit in the build/deployment record, and keep production approval explicit.
