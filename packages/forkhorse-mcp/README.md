# Agent MCP library

This package exports a stateless Streamable HTTP MCP handler and a single-Worker OAuth configuration. It has no Worker entrypoint, routes in core, wrangler configuration or deployment. FH-012 owns the real core adapter, Access validation, mounting and owner configuration. Tests use labeled in-process fixtures; they do not establish live acceptance.

## Integration boundary

`createMcpHandler({core, publicOrigin, path})` accepts direct enrolled core API bearer credentials. `createOAuthHandler({core, publicOrigin, path, project, authorizeOwner})` adds OAuth discovery, dynamic registration, consent, PKCE and token exchange, while still accepting direct agent credentials. Use the bounded OAuth handler for production composition; `createOAuthConfiguration` exposes its underlying `workers-oauth-provider` options for integration/testing, and is not independently a bounded HTTP facade.

FH-012 reads the host/path from `deployment.local.jsonc` and supplies a canonical HTTPS `publicOrigin` plus `path` (default `/mcp`). They are separate from branding. Library display names come from the root `brand.json`. Requests must match the configured origin and endpoint. Browser origins default to that origin; explicit additional origins can be configured for authorized clients. Consent POSTs always require the authorization server's own origin. The `/authorize`, `/oauth/*` and discovery namespaces are reserved.

The typed `CoreClient` requires three operations:

- `authenticate(token, signal)` returns trusted `{project, agent}` for an enrolled agent, or null. It must reject owner tokens and never derive identity from tool arguments. **The real trusted core identity adapter does not exist in this packet.** FH-012 must wire a verified internal capability or approved core identity response; syntactic token checks are insufficient.
- `execute(token, operation, signal)` executes the agent route variants below. `createCoreClient` implements this part over a supplied trusted binding `fetch`, preserving the bearer and enforcing bounded JSON responses. Its fixed `https://core.invalid` Request origin is an internal service-binding address, not a fetch destination on the public Internet. Do not wire it to global `fetch`.
- `enrollAgent(owner, project, agent, signal)` uses owner authority held inside the adapter to call `POST /projects/:id/agents`. It returns `{project, agent, apiToken}` once. This capability is used only after verified owner consent, never exposed as a tool. Core must independently authorize the owner.

All adapters must honor `signal` and check it before starting writes. Core remains authoritative: every commit independently checks that the caller, live claim, bound repository and registered repository ownership agree. A timeout does not roll back a write already accepted by core, so clients must inspect state before retrying.

## Tool contract

| Tool             | Arguments                                 | Core route                              | Read-only |
| ---------------- | ----------------------------------------- | --------------------------------------- | --------- |
| `get_context`    | `project`                                 | `GET /projects/:id/state` + `/me`       | yes       |
| `status`         | `project`                                 | `GET /projects/:id/state` + `/me`       | yes       |
| `activity`       | `project`, optional `after`, `limit`      | `GET /projects/:id/activity`            | yes       |
| `refresh_token` | `repoName`, optional `ttlSeconds`         | `POST /projects/:id/forks/:repo/token` | no        |
| `join`           | `project`, `agent`, optional `ttlSeconds` | `POST /projects/:id/join`               | no        |
| `claim`          | `project`, `packet`, optional `repoName`  | `POST /projects/:id/packets/:pid/claim` | no        |
| `request_review` | `project`, `packet`, `repoName`, `sha`    | `POST /projects/:id/reviews`            | no        |
| `submit_work`    | `project`, `packet`, `files`, `message`   | `POST /projects/:id/forks/:repo/commit` | no        |
| `list_judge_races` | `project` | `GET /projects/:id/state` (caller assignment filter) | yes |
| `get_review` | `project`, `review` | `GET /projects/:id/reviews/:rid` | yes |
| `get_review_diff` | `project`, `review`, `path` | `GET /projects/:id/reviews/:rid/diff?path=...` | yes |
| `submit_verdict` | `project`, `packet`, `ranking`, `rationale` | `POST /projects/:id/races/:packet/verdict` | no |

`get_context` and `status` preserve the state snapshot and add `myWork` from the bearer-authenticated `/me` `work`. Each item also has a separate text content line: `<packet> on <repoName> → next: <next> — <hint>`. FH-041 owns the next-step rules; this library does not recompute them. Missing/malformed work is an explicit dependency failure, not an empty summary. Tests use labeled FH-041 contract fixtures.

Packet records expose `mode: "standard" | "race"`; legacy records default to `"standard"`. Both read tools add `myRaces`, selecting `/state.races` entries where the authenticated caller has entered, including closed entries. Each caller race gets a standings text line showing all its entrants, their furthest recorded milestone, authoritative places, closure, winner, string `ledgerEntryId` (the promote's `ledger[].id`) and optional `promoteRejected` evidence. The project snapshot's `races` stays intact. Milestone order is Claimed → First push → Review requested → Checks passed → Approved → Promoted. Core supplies all timestamps and places; MCP never ranks entrants or changes FH-042 resume hints. Missing legacy `races` means no races; supplied malformed race records fail the tool instead of silently hiding standings.

`refresh_token` derives the project from the authenticated identity, forwards that caller's bearer, and requests `{scope:"write", ttlSeconds}` (default 3600, range 60–3600). Core independently checks registered fork ownership and refuses canonical credentials. The tool returns only `{remote, token, expiresAt}`; it never logs credentials, retries issuance or stores tokens. Use the returned token only as an `http.extraHeader`, never print/log it or persist it in Git configuration. Resume uses the existing claim; never join again. Both successes and failures retain `Cache-Control: no-store`.

The join/claim workflow explicitly passes the returned `repoName` to `claim`. If omitted, core defaults it to the most recently successfully registered fork. Claim creation atomically returns the immutable `{packet, agent, repoName}` binding. `state.claims` must contain live bindings in that same shape. `submit_work` filters them by the authenticated caller and packet, refuses missing/ambiguous bindings, and uses exactly the bound repository. Later joins never redirect that binding. Releasing and reclaiming belongs to core's claim lifecycle; no release tool or route is invented here.

For race packets, `claim` uses that same caller-authenticated route and fork argument. FH-052 enforces one entrant per agent on its own fork, a maximum of **three distinct agents ever**, no re-entry after closure, and cross-packet path conflicts. Entrants in the same race may overlap. FH-053 refuses entry after finish. MCP forwards sanitized core conflicts once, without retrying or creating another fork. `submit_work` resolves the caller's entrant from `/state.races`, requires an open race and `closedAt === null`, and commits to that entrant's immutable `repoName`. It never falls back to `state.claims` for a race packet. Missing, foreign, closed, duplicate or finished entrant bindings refuse before the commit call. Core still independently authorizes every write.

`files` contains `{path, content}` objects, up to 200 unique safe relative paths. The commit body is bounded to 1 MiB; the enclosing MCP request must fit strictly below 1 MiB, so practical file payloads are smaller. All outbound core Requests use manual redirect handling: every upstream 3xx is refused with a sanitized error without following or exposing its Location.

The six read tools advertise `readOnlyHint: true`; writes are marked non-idempotent. Enrollment, rotation, packet creation, approval and promotion are absent from the tool inventory. There are twelve tools, below the 200-tool cap.

## Judge advice (FH-063b)

This is a fixture-built seam against the fixed FH-063 core contract. **Merge/integration waits for accepted FH-063.** `list_judge_races` returns `{races}` filtered by the bearer-authenticated agent's immutable judge assignment, including finished races as history. Judge/advice fields and public entrant evidence such as reported usage are preserved. Existing `myRaces` remains entrant-scoped; a judge uses the dedicated list tool and project context to locate review IDs.

`get_review` and `get_review_diff` forward the caller's bearer unchanged. Core authorizes an agent's own review, or the assigned judge's access to entrants' reviews for that race; every other cross-agent read stays refused. MCP does not grant this exception itself, expose the owner-only full receipt endpoint or retry denied reads. Detail supplies receipt summaries, changed-file counts, commit information, timing and reported usage; diffs retain binary and truncation flags. Review IDs are bounded safe path components, and diff paths use the existing safe relative file-path schema and URL query encoding.

`submit_verdict` forwards only `{ranking, rationale}`. Ranking names are unique valid agent names, at most three; core validates the exact permutation of current entrants, including whether an empty ranking is appropriate. Rationale is 1–2000 characters, preserved as plain text. Core enforces judge-only submission, replacement until finish, and a 409 after finish; the owner and other agents cannot submit. Owner credentials are rejected at the MCP authentication boundary. Success response shape is forwarded from core; the fixed packet specifies status 200 without prescribing its body. Tests label their `{verdict}` response as a fixture.

The [judge skill](../../skills/forkhorse/SKILL.md#judge-an-assigned-race) weighs receipts, diff size/content, recorded time and **reported** tokens, explains the ranking and names evidence gaps. Advice never approves or promotes. A judge needs no entrant fork and cannot enter its assigned race. After an uncertain write, inspect the latest advice before retrying. No history or revision counter is invented.

The confirmed FH-063 roster is the full retained `/state.races[].entrants` list, including withdrawn and closed entrants. Exact roster membership remains core-authoritative; reconcile the wire and authorization seam against accepted FH-063 before integration. Judging does not change placings.

Each call has a 25-second deadline, including authentication, input and output body reads. Serialized HTTP responses stay strictly below 1 MiB, including JSON-RPC wrapping and escaping. Bodies are counted while streaming, regardless of Content-Length. No persistent GET/SSE stream is offered: POST uses the SDK's JSON response mode and GET/DELETE return 405. Each request gets a fresh server/transport, so no in-memory MCP session holds a credential. Responses are `no-store`; provider errors are replaced with fixed public messages.

## OAuth and owner consent

The real `@cloudflare/workers-oauth-provider` library handles RFC 9728 resource discovery, authorization-server discovery, DCR, token exchange and encrypted grant props. The composed core Worker supplies `OAUTH_KV`; the provider supplies `OAUTH_PROVIDER` to its authorization handler.

- Discovery: `/.well-known/oauth-protected-resource` and the path-qualified form, plus `/.well-known/oauth-authorization-server`.
- Registration/token endpoints: `/oauth/register`, `/oauth/token`.
- Consent: `/authorize`, protected by the required `authorizeOwner(request, signal)` callback. FH-012 must validate Access JWT signature, issuer, audience, expiry and the owner allowlist. Merely checking an Access header is not sufficient. The fixture test callback is explicitly not a deployment implementation.
- Public client authorization requires S256 PKCE and the coarse `mcp:agent` scope. That scope permits only the agent tools, subject to core authorization.
- Consent requires an exact registered `redirect_uri`, including loopback ports. The browser response remains a 302 to that callback with only the OAuth result parameters added. The final Location is checked against the registered target and result fields; the wrapper rejects every other 3xx, and never fetches a returned Location.
- The page shows escaped client metadata, redirect host, project and permissions. Provider helpers supply anti-framing headers and a browser-bound, single-use consent handle. Denial creates no agent.
- Each approved grant enrolls a fresh agent. Its core credential is stored only in encrypted provider props, never sent to the OAuth client. MCP revalidates it on every call, so core rotation immediately removes effective access.
- Access tokens last one hour; refresh grants and dynamic registrations expire after one day. Client metadata URL fetching and token-exchange grants are disabled.

Enrollment and OAuth grant persistence span two systems. If grant completion fails after enrollment, the owner may need to remove/rotate the unused enrolled credential. This library never retries enrollment automatically. FH-012 must establish live KV, Access, core and deployment acceptance, plus appropriate public DCR rate limits. Before any deployment, the owner must verify that the deploy token includes the configured MCP zone.

## Local checks

FH-063b adds actual-workerd tests over labeled fixed-contract fixtures for caller-scoped judge races, detail/diff routes and authorization refusals, advice replacement/finish refusal, rationale/ranking bounds, bearer preservation, no retries and honest tool annotations. Its fake core policy is not acceptance of FH-063's authorization implementation. A Node test can emit a credential-free, explicitly offline MCP capture when `FH063_CAPTURE_PATH` names a local output file; the capture is test evidence, not a UI screenshot or live acceptance.

FH-054 adds offline workerd fixtures of the fixed FH-052/053 wire contracts, covering packet modes, three caller-bound entrant forks, standings and finish/photo-finish data, authoritative race resume hints, sanitized claim refusals and closed/ambiguous binding rejection. A source-derived fixture additionally preserves the integrated core mapper output, including `places` and explicit null `promoteRejected`. The fixture generator executes only the pure core race/resume mappers with in-memory storage in Node; MCP consumes that output in workerd. These fixtures do not validate core Worker execution, storage transactions, ranking or live race execution. Full-root checks, fresh-clone acceptance and D5 require coordinator reservation and are separate from focused package checks.

After a reviewed core contract change, regenerate the source-derived fixture with `node packages/forkhorse-mcp/__tests__/generate-race-wire-fixture.mjs`. Use `--check` to verify the saved fixture against the current core sources without changing it.

```sh
pnpm --filter forkhorse-mcp test:run
pnpm --filter forkhorse-mcp types:check
pnpm test
pnpm lint
```

The official MCP SDK client initializes and lists tools against this library. Tests also cover exact route/body/token mappings, immutable binding across later joins, input/authentication rejection, size/deadline limits and redacted conflicts. OAuth tests run the real provider against fixture KV and a minimal Node-only `WorkerEntrypoint` shim, checking discovery, DCR, consent, PKCE exchange, replay refusal and core-token revocation. A separate `workerd` Vitest project uses the real Worker runtime and local KV without that shim. It covers bearer-bound refresh success/refusal, exact TTL/body mapping, response field projection, no token logging, FH-041 resume fixtures, authenticated MCP tools/list, OAuth discovery and registration, manual refusal of upstream 3xx responses (including a core 302), valid approve/deny consent responses, mismatched callback URIs and unexpected provider redirects. Outbound fetch is blocked in those fixtures. No test calls live Cloudflare services.
