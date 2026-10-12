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
- `pushQueue` and `deadLetterQueue`: distinct, owner-approved Queue names. Configure both before a live deploy and monitor dead-letter messages.
- `access.issuer`, `access.audience`, `access.owners`: the core Access application issuer, exact audience, and nonempty owner email allowlist. These are separate from the OS application's Access configuration.

Actual account IDs, hostnames, audiences, email addresses and resource IDs belong only in the gitignored file. `OWNER_API_TOKEN_HASH` is a Worker secret containing the SHA-256 hash of a separately held high-entropy owner credential. Neither the raw credential nor its hash goes in tracked configuration, browser code, MCP grants or a response. Enrolled agent API credentials continue to work on the project API without browser cookies.

## Access and routing

The owner must configure an Access application covering `/app`, `/app/*`, and `/authorize` on the core hostname, with a narrow owner policy. Leave `/projects` and `/projects/*` reachable by non-browser bearer clients. Browser owner requests there carry the same application's `CF_Authorization` cookie, whose JWT the Worker verifies identically to the Access assertion header. Verify that the application cookie reaches these paths during the separately authorized live gate. Do not place interactive Access login in front of the MCP endpoint, OAuth registration/token endpoints, or discovery endpoints: their OAuth challenge and token flows must reach the Worker.

The Worker verifies `Cf-Access-Jwt-Assertion` (or the Access application cookie when no assertion header is present) with RS256 keys from the configured team's `/cdn-cgi/access/certs`, exact issuer/audience, expiry/not-before/issued-at, and the owner email allowlist. A header's presence alone grants nothing. A missing, forged, expired or non-owner assertion is refused. Browser API writes additionally require the configured origin and JSON content type. Cross-origin browser calls cannot use an owner bearer credential to bypass this check.

All dashboard requests, including JavaScript and CSS, pass through the Worker first (`assets.run_worker_first: true`). The Worker strips the `/app` prefix only after authentication and returns private, non-cacheable responses. Root asset aliases and missing assets are not an SPA fallback. Only inert project-selection JSON is injected; no credential is sent to the dashboard. The existing dashboard keeps using same-origin cookies.

MCP discovery, registration, consent, token exchange and agent tools use the FH-004 OAuth provider. The core adapter authenticates against stored enrolled-agent hashes and refuses owner credentials as agent credentials. Approved Access-authenticated consent enrolls a new agent in the configured project. Rotating that agent's credential invalidates its OAuth grant on the next MCP call. Private Supervisor methods carry trusted identity and owner requests over the binding; no public identity header or auth-bypass route is added.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Push event subscription prerequisite

The deployment generator attaches the core consumer to `pushQueue`, with five retries and `deadLetterQueue`. It does not create event subscriptions or prove event delivery.

After separate live approval, open the target Queue in Cloudflare's dashboard, select **Subscriptions**, then **Subscribe to events**. Use the Artifacts repository source (`artifacts.repo`), the configured namespace, the exact repository name, and the `pushed` event. Delivered messages use `cf.artifacts.repo.pushed`. Inventory subscriptions for the canonical repository and every agent fork. A canonical-only subscription misses fork activity; creating a new fork therefore needs subscription coverage before its pushes can be treated as observed. Automatic subscription provisioning for future forks is not implemented by this packet.

Do not substitute account-level repository-created events for pushed events. The consumer ignores other namespaces and unregistered repositories and retries incomplete diff reads. Live acceptance must demonstrate canonical and fork push delivery, idempotent handling, and a failed delivery reaching the dead-letter Queue. CLI support for source-specific namespace/repository parameters must be verified against the pinned Wrangler before automating subscription creation; this packet does not invent an unverified command.

References: [Artifacts event schemas](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), [Queue subscription setup](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/).

## Checks and remaining gates

Run root and upstream frozen installs, the core package's test/typecheck/build, `pnpm test`, `pnpm lint`, and owner-configured `pnpm check`. Check builds MCP and the production dashboard before the core's Wrangler dry run. Generated configurations are temporary and removed after the check. The tracked template intentionally fails placeholder validation: no owner configuration means plain `pnpm check` is blocked, not passed.

For the explicitly approved FH-012 offline acceptance only, an isolated worktree may use a synthetic, gitignored `deployment.local.jsonc` created exclusively from the public template. Use an all-zero account ID, `*.fixture.idiot.tax` hosts, `fh-check@idiot.tax`, fixture Access values and `core.enabled=true`. Run with a fresh temporary HOME, an empty inherited environment except PATH, and external networking denied (loopback is allowed for workerd). Use the already-installed pinned tools; do not bootstrap tools, log in, use Keychain or copy any owner's configuration. Refuse to start if the local file exists, and remove only the exact synthetic file created by that invocation on completion or failure. Report tests, builds and all seven Worker dry runs as offline evidence. The owner-configured check at the reviewed SHA remains a separate pre-deploy requirement.

Workerd integration tests use newly generated test signing keys, intercepted JWKS, local KV/DOs, built production dashboard assets and fixture Artifacts. They exercise missing/invalid JWTs, owner API authorization and origin checks, MCP tools/list, PKCE consent/enrollment, and grant invalidation after rotation. Core tests build the dashboard first and serve that output through a local assets binding; this is not evidence of deployed UI acceptance.

Live DNS/TLS, Access policy/cookies, provider credentials, OAuth clients, Artifacts operations, Queue/subscription delivery and the custom-domain deployment remain separate locked gates. This packet does not wire runner ReviewAuthority or enforce default check receipts. Existing-fork credential issuance and public authenticated-actor discovery also require their own approved contract.
