# Public core integration

FH-012 composes the MCP OAuth adapter, owner dashboard and project API in one core Worker. The pinned OS still has its own router and is unmodified. `brand.json` remains the display-name authority. This is deployment wiring and offline acceptance, not a deployed service.

## Owner configuration

Copy the tracked template to gitignored `deployment.local.jsonc` and set `core.enabled: true` only after the deployment has been reviewed. The core block specifies:

- `workerName`: permanent core identity and its Supervisor storage. Renaming it does not migrate projects.
- `hostname`: a custom hostname distinct from the OS router. It becomes `CORE_PUBLIC_ORIGIN`; workers.dev and preview URLs are disabled.
- `mcpPath`: a single path segment, normally `/mcp`, distinct from reserved owner and OAuth routes.
- `project`: the existing project used for MCP authentication/enrollment and initially offered by the dashboard. Create it with the owner API before connecting MCP clients.
- `artifactsNamespace`: the namespace for canonical repositories, forks and push events.
- `oauthKvNamespaceId`: an existing dedicated OAuth KV namespace, or `null` for Wrangler provisioning. Treat grant records as credentials. Do not share this namespace across deployments.
- `pushQueueId`: the resolved 32-hex ID of `pushQueue`, supplied by the owner before provisioning the event-only token. Core uses this ID directly and needs no Queue Read permission. The owner must verify it belongs to the named consumer Queue in this account.
- `secretsFile`: optional repository-relative path to an ignored JSON file containing exactly `OWNER_API_TOKEN_HASH` and `CF_EVENTS_API_TOKEN`; `null` uses secrets already installed on the Worker. See first-deploy handling below.
- `pushQueue` and `deadLetterQueue`: distinct, owner-approved Queue names. Configure both before a live deploy and monitor dead-letter messages.
- `access.issuer`, `access.audience`, `access.owners`: the core Access application issuer, exact audience, and nonempty owner email allowlist. These are separate from the OS application's Access configuration.

Actual account IDs, hostnames, audiences, email addresses and resource IDs belong only in the gitignored file. `OWNER_API_TOKEN_HASH` is a Worker secret containing the SHA-256 hash of a separately held high-entropy owner credential. Neither the raw credential nor its hash goes in tracked configuration, browser code, MCP grants or a response. Enrolled agent API credentials continue to work on the project API without browser cookies.

## Access and routing

The owner must configure an Access application covering `/app`, `/app/*`, and `/authorize` on the core hostname, with a narrow owner policy. Leave `/projects` and `/projects/*` reachable by non-browser bearer clients. Browser owner requests there carry the same application's `CF_Authorization` cookie, whose JWT the Worker verifies identically to the Access assertion header. Verify that the application cookie reaches these paths during the separately authorized live gate. Do not place interactive Access login in front of the MCP endpoint, OAuth registration/token endpoints, or discovery endpoints: their OAuth challenge and token flows must reach the Worker.

The Worker verifies `Cf-Access-Jwt-Assertion` (or the Access application cookie when no assertion header is present) with RS256 keys from the configured team's `/cdn-cgi/access/certs`, exact issuer/audience, expiry/not-before/issued-at, and the owner email allowlist. A header's presence alone grants nothing. A missing, forged, expired or non-owner assertion is refused. Browser API writes additionally require the configured origin and JSON content type. Cross-origin browser calls cannot use an owner bearer credential to bypass this check.

All dashboard requests, including JavaScript and CSS, pass through the Worker first (`assets.run_worker_first: true`). The Worker strips the `/app` prefix only after authentication and returns private, non-cacheable responses. Root asset aliases and missing assets are not an SPA fallback. Only inert project-selection JSON is injected; no credential is sent to the dashboard. The existing dashboard keeps using same-origin cookies.

MCP discovery, registration, consent, token exchange and agent tools use the FH-004 OAuth provider. The core adapter authenticates against stored enrolled-agent hashes and refuses owner credentials as agent credentials. Approved Access-authenticated consent enrolls a new agent in the configured project. Rotating that agent's credential invalidates its OAuth grant on the next MCP call. Private Supervisor methods carry trusted identity and owner requests over the binding; no public identity header or auth-bypass route is added.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Per-repository push subscriptions

FH-018 creates a subscription after registering a canonical repository or each new agent fork. The request matches installed Wrangler 4.149.0's `src/queues/client.ts` and `src/queues/cli/commands/subscription/create.ts`: `POST /accounts/{account}/event_subscriptions/subscriptions` with `name`, `enabled: true`, `source: {type: "artifacts.repo", namespace, repo_name}`, `events: ["pushed"]`, and `destination: {type: "queues.queue", queue_id}`. The delivered event is `cf.artifacts.repo.pushed`; the account-level `artifacts` source has no `pushed` event.

The owner supplies `CF_EVENTS_API_TOKEN` as a Worker secret: an owner-created token restricted to the deployment account and only the event-subscription permissions required for list/create. Exact provider permission availability and provisioning remain owner/live gates. Core never resolves Queue names with this token or uses it for Artifacts Git operations. `CF_ACCOUNT_ID` comes from the existing top-level `accountId`; `PUSH_QUEUE_ID` comes from `core.pushQueueId`. No token is stored in a var, returned, or logged.

Core lists subscriptions using Wrangler's `queue_id`, `page`, and `per_page` query parameters before creating. It adopts an enabled matching source, repository, destination and `pushed` event, including one created by an earlier attempt whose response was lost. It stops safely on an incomplete/failed listing. Scans are bounded to 100 pages of 20 subscriptions and 10 seconds per attempt; reaching either bound leaves pending state for owner inspection/retry. Concurrent changes by external administrators are outside the per-project serialization guarantee.

Registration atomically saves `repoEvents:<repo>` beside the membership registry and arms an alarm before external API work. API failure does not fail create/join: responses, `/state`'s project/forks, and `/me`'s project/caller-filtered forks show `events: "pending"`. Successful entries show `events: "active"` and their persisted `subscriptionId`. This means subscription provisioning succeeded, not that any push was delivered. Attempts back off from 30 seconds to one hour. Each alarm handles up to ten due repositories, shares the Supervisor serialization gate, and re-arms remaining work; it requires no new user request. Provider errors and response bodies are discarded. Manual redirects are rejected without forwarding the bearer token.

Pre-FH-018 repositories without subscription records are shown as pending but are not automatically migrated; owner inventory/backfill is a follow-up live task. Active subscriptions are not periodically revalidated after external deletion or configuration changes. Inventory those cases during FH-012L. The consumer continues to reject other namespaces and unregistered repositories and retries incomplete diffs. Live acceptance must demonstrate canonical and fork push delivery, duplicate handling and dead-letter behavior.

## First-deploy secrets

A new Worker needs both required secrets in its first `wrangler deploy`; `wrangler secret put` cannot provision a nonexistent Worker. Set `core.secretsFile` locally, for example to `packages/forkhorse-core/.wrangler/deploy-secrets.json` (already ignored). The owner file is a JSON object with the lowercase 64-hex `OWNER_API_TOKEN_HASH` and nonempty `CF_EVENTS_API_TOKEN`. Do not commit it. The owner resolves the Queue ID and provisions credentials separately; this packet does not do either live.

`pnpm deploy` validates the file is inside this repository, ignored and untracked, and not a symlink. It makes a private, exclusively created temporary copy in the ignored core `.wrangler` directory, passes `--secrets-file` to only the core deploy, suppresses that subprocess's output and disk log, and removes the exact copy after success or failure. The owner source file remains owner-managed. A changed temporary file causes cleanup to refuse deletion. The helper never prints parser/provider errors or secret contents. `pnpm check` uses only `--dry-run`, never reads the secret file and needs no real secret. With `secretsFile: null`, an existing Worker's installed secrets are used; first deploy then fails if they do not exist.

## Checks and remaining gates

Run root and upstream frozen installs, the core package's test/typecheck/build, `pnpm test`, `pnpm lint`, and owner-configured `pnpm check`. Check builds MCP and the production dashboard before the core's Wrangler dry run. Generated configurations are temporary and removed after the check. The tracked template intentionally fails placeholder validation: no owner configuration means plain `pnpm check` is blocked, not passed.

For the explicitly approved FH-012/FH-018 offline acceptance only, an isolated worktree may use a synthetic, gitignored `deployment.local.jsonc` created exclusively from the public template. Use an all-zero account ID, `*.fixture.idiot.tax` hosts, `fh-check@idiot.tax`, fixture Access values and `core.enabled=true`. Run with a fresh temporary HOME, an empty inherited environment except PATH, and external networking denied (loopback is allowed for workerd). Use the already-installed pinned tools; do not bootstrap tools, log in, use Keychain or copy any owner's configuration. Refuse to start if the local file exists, and remove only the exact synthetic file created by that invocation on completion or failure. Report tests, builds and all configured Worker dry runs as offline evidence. The owner-configured check at the reviewed SHA remains a separate pre-deploy requirement.

Workerd integration tests use newly generated test signing keys, intercepted JWKS, local KV/DOs, built production dashboard assets and fixture Artifacts. They exercise missing/invalid JWTs, owner API authorization and origin checks, MCP tools/list, PKCE consent/enrollment, and grant invalidation after rotation. Core tests build the dashboard first and serve that output through a local assets binding; this is not evidence of deployed UI acceptance.

Live DNS/TLS, Access policy/cookies, provider credentials, OAuth clients, Artifacts operations, Queue/subscription delivery and the custom-domain deployment remain separate locked gates. This packet does not wire runner ReviewAuthority or enforce default check receipts. Existing-fork credential issuance and public authenticated-actor discovery also require their own approved contract.
