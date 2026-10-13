import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type {
  OAuthHelpers,
  OAuthProviderOptions,
  ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import brand from "../../../brand.json";
import { boundedCall, MAX_BYTES, PublicError, readBounded } from "./core";
import type { OwnerIdentity } from "./core";
import { createMcpHandler, endpointConfig, publicFailure } from "./mcp";
import type { McpOptions } from "./mcp";
import { consentRedirect, requireRegisteredRedirect } from "./consent";

export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}
export interface OAuthOptions extends McpOptions {
  /** Project chosen in owner deployment configuration, never inferred from a client URL. */
  project: string;
  /** FH-012 must verify JWT signature, issuer, audience, expiry and owner allowlist here. */
  authorizeOwner(request: Request, signal: AbortSignal): Promise<OwnerIdentity | null>;
}
const scope = "mcp:agent";
const grant = z.object({
  kind: z.enum(["core", "grant"]),
  token: z.string().min(1).max(512),
  project: z.string(),
  agent: z.string(),
});
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
function consentPage(details: ConsentDescription, handle: string, project: string) {
  // Outside the OS shell: inline token values from design/tokens.json, with system fonts only.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(brand.name)} authorization</title>
<style>
:root {
  color-scheme: light;
  --color-kumo-base: #fcfcfb;
  --color-kumo-elevated: #f8f8f7;
  --color-kumo-tint: #f3f3f1;
  --color-kumo-brand: #ff4801;
  --color-kumo-brand-hover: #e03f00;
  --color-kumo-line: #1411100f;
  --color-kumo-focus: oklch(15% 0 0);
  --color-kumo-warning-tint: oklch(92% 0.08 85);
  --text-color-kumo-default: #1c1a18;
  --text-color-kumo-strong: #100f0d;
  --text-color-kumo-subtle: oklch(52% 0.006 60);
  --text-color-kumo-inverse: #ffffff;
  --font-sans: "FT Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", sans-serif;
  --font-mono: "Apercu Mono Pro", "SF Mono", Menlo, Monaco, Consolas, monospace;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --spacing: 0.25rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-kumo-base: oklch(0.115 0.012 285);
    --color-kumo-elevated: oklch(0.155 0.011 285);
    --color-kumo-tint: oklch(0.225 0.025 285);
    --color-kumo-brand: #b84e00;
    --color-kumo-brand-hover: #a54200;
    --color-kumo-line: oklch(0.34 0.022 285);
    --color-kumo-focus: oklch(93.5% 0 0);
    --color-kumo-warning-tint: oklch(0.27 0.06 84.429);
    --text-color-kumo-default: oklch(0.92 0.01 285);
    --text-color-kumo-strong: oklch(0.92 0.01 285);
    --text-color-kumo-subtle: oklch(0.66 0.02 285);
    --text-color-kumo-inverse: #ffffff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: calc(var(--spacing) * 16) calc(var(--spacing) * 3);
  background: var(--color-kumo-elevated);
  color: var(--text-color-kumo-default);
  font: 14px/20px var(--font-sans);
}
.consent { max-width: 32rem; margin: 0 auto; }
.lockup {
  margin: 0 0 calc(var(--spacing) * 4);
  text-align: center;
  color: var(--text-color-kumo-subtle);
  font-size: 13px;
  font-weight: 500;
}
.card {
  padding: calc(var(--spacing) * 6);
  background: var(--color-kumo-base);
  border: 1px solid var(--color-kumo-line);
  border-radius: var(--radius-xl);
  overflow-wrap: anywhere;
}
h1 {
  margin: 0;
  color: var(--text-color-kumo-strong);
  font-size: 24px;
  line-height: 32px;
  font-weight: 600;
  letter-spacing: -0.025em;
}
p { margin: 0; }
.description {
  margin-top: calc(var(--spacing) * 2);
  color: var(--text-color-kumo-subtle);
  font-size: 13px;
  line-height: 18px;
  letter-spacing: -0.25px;
}
.permissions { margin-top: calc(var(--spacing) * 6); }
h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
ul { margin: calc(var(--spacing) * 2) 0; padding-left: calc(var(--spacing) * 5); }
.limits { color: var(--text-color-kumo-subtle); }
.warning {
  display: flex;
  gap: calc(var(--spacing) * 2);
  margin-top: calc(var(--spacing) * 6);
  padding: calc(var(--spacing) * 3);
  border-radius: var(--radius-lg);
  background: var(--color-kumo-warning-tint);
}
.warning svg { flex: none; margin-top: 2px; }
.warning p { min-width: 0; }
code { font-family: var(--font-mono); }
.context { margin-top: calc(var(--spacing) * 3); }
.scope { margin-top: calc(var(--spacing) * 6); }
.scope span { margin-right: calc(var(--spacing) * 2); font-size: 12px; color: var(--text-color-kumo-subtle); }
form { display: flex; justify-content: flex-end; gap: calc(var(--spacing) * 2); margin-top: calc(var(--spacing) * 6); }
button {
  height: 36px;
  padding: 0 calc(var(--spacing) * 4);
  border: 1px solid var(--color-kumo-line);
  border-radius: var(--radius-lg);
  background: var(--color-kumo-base);
  color: var(--text-color-kumo-default);
  font: 500 14px/20px var(--font-sans);
  cursor: pointer;
}
button:hover { background: var(--color-kumo-tint); }
button[value="approve"] { background: var(--color-kumo-brand); color: var(--text-color-kumo-inverse); border-color: var(--color-kumo-brand); }
button[value="approve"]:hover { background: var(--color-kumo-brand-hover); border-color: var(--color-kumo-brand-hover); }
button:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: 2px; }
@media (max-width: 639px) {
  body { padding-top: calc(var(--spacing) * 6); }
  .card { padding: calc(var(--spacing) * 4); }
}
</style></head><body>
<main class="consent">
<p class="lockup"><span aria-hidden="true">${escape(brand.mark)}</span> ${escape(brand.name)}</p>
<section class="card" aria-labelledby="consent-title">
<h1 id="consent-title">Allow ${escape(details.clientName)} to work on ${escape(project)}?</h1>
<p class="description">It will join as a new agent in this project.</p>
<div class="permissions">
<h2>It will be able to</h2>
<ul>${details.scope.includes(scope) ? "<li>read project state</li><li>create its own forks</li><li>claim packets</li><li>submit work and request review</li>" : ""}</ul>
<p class="limits">It can't approve or promote. Those stay with you.</p>
</div>
<div class="warning" role="note">
<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5 15 14H1Z" stroke-linejoin="round"/><path d="M8 5.5v4M8 11v.5"/></svg>
<p>The name &quot;${escape(details.clientName)}&quot; is self-reported by the app. After you choose, you return to <strong><code>${escape(details.redirectHost)}</code></strong>.</p>
</div>
${details.clientDomain ? `<p class="context">Client domain: <code>${escape(details.clientDomain)}</code></p>` : ""}
${details.redirectIsLoopback ? '<p class="context">This sends access to an app on your computer. Continue only if you started this login.</p>' : ""}
<p class="scope"><span>Scope</span> <code>${details.scope.map(escape).join(", ")}</code></p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve">Allow</button></form>
</section></main></body></html>`;
}

function configureOAuth(options: OAuthOptions) {
  // Only consent responses checked below may leave the wrapper as a 3xx.
  const consentResponses = new WeakSet<Response>();
  const config = endpointConfig(options);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.project) || options.project.length > 48)
    throw new Error("Invalid OAuth project.");
  const mcp = createMcpHandler(options);
  const configuration: OAuthProviderOptions<OAuthEnv> = {
    apiRoute: config.path,
    authorizeEndpoint: `${config.origin}/authorize`,
    tokenEndpoint: `${config.origin}/oauth/token`,
    clientRegistrationEndpoint: `${config.origin}/oauth/register`,
    resourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.origin],
      resource_name: brand.name,
      bearer_methods_supported: ["header"],
    },
    scopesSupported: [scope],
    requiredScopes: [scope],
    accessTokenTTL: 3600,
    refreshTokenTTL: 86400,
    clientRegistrationTTL: 86400,
    clientIdMetadataDocumentEnabled: false,
    allowTokenExchangeGrant: false,
    // Override the provider's default error logger and keep wire errors free of internal detail.
    onError: ({ status, code, headers }) =>
      Response.json(
        { error: code, error_description: "OAuth request refused." },
        { status, headers: { ...headers, "cache-control": "no-store" } },
      ),
    // Opaque core API credentials are validated independently; owner tokens must be refused.
    async resolveExternalToken({ token, request }) {
      return boundedCall(
        async (signal) => {
          const identity = await options.core.authenticate(token, signal);
          if (!identity || identity.project !== options.project) return null;
          return { audience: config.resource, props: { kind: "core", token, ...identity } };
        },
        config.timeoutMs,
        request.signal,
      );
    },
    apiHandler: {
      async fetch(request, _env, ctx) {
        const authContext = ctx as typeof ctx & { props: unknown; auth?: { scope: string[] } };
        const parsed = grant.safeParse(authContext.props);
        if (!parsed.success || parsed.data.project !== options.project)
          throw new PublicError(401, "Invalid authorization grant.");
        if (parsed.data.kind === "grant" && !authContext.auth?.scope.includes(scope))
          throw new PublicError(403, "Agent scope is required.");
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${parsed.data.token}`);
        // Revalidate the enrolled credential on every call, so core rotation revokes this grant's access.
        return mcp(new Request(request, { headers }));
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        if (new URL(request.url).pathname !== "/authorize")
          return new Response(null, { status: 404 });
        return boundedCall(
          async (signal) => {
            const owner = await options.authorizeOwner(request, signal);
            if (!owner?.subject) throw new PublicError(403, "Owner Access login is required.");
            const oauth = env.OAUTH_PROVIDER;
            if (request.method === "GET") {
              const auth = await oauth.parseAuthRequest(request);
              await requireRegisteredRedirect(oauth, auth);
              if (
                auth.codeChallengeMethod !== "S256" ||
                !auth.codeChallenge ||
                auth.scope.length !== 1 ||
                auth.scope[0] !== scope
              )
                throw new PublicError(400, "S256 PKCE and the agent scope are required.");
              const details = await oauth.describeConsent(auth);
              const consent = await oauth.beginConsent(auth);
              consent.headers.set("content-type", "text/html; charset=utf-8");
              return new Response(consentPage(details, consent.handle, options.project), {
                headers: consent.headers,
              });
            }
            if (request.method !== "POST")
              return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
            if (request.headers.get("origin") !== config.origin)
              throw new PublicError(403, "Consent origin is not allowed.");
            const form = await request.formData();
            const handle = form.get("handle");
            if (typeof handle !== "string" || handle.length > 1024)
              throw new PublicError(400, "Invalid consent handle.");
            if (form.get("decision") === "deny") {
              const denied = await oauth.denyConsent(request, handle);
              await requireRegisteredRedirect(oauth, denied.request);
              const response = consentRedirect(
                denied.request,
                denied.redirectTo,
                denied.headers,
                "deny",
              );
              consentResponses.add(response);
              return response;
            }
            if (form.get("decision") !== "approve")
              throw new PublicError(400, "An explicit consent decision is required.");
            const approved = await oauth.approveConsent(request, handle);
            await requireRegisteredRedirect(oauth, approved.request);
            if (
              approved.request.codeChallengeMethod !== "S256" ||
              approved.request.scope.length !== 1 ||
              approved.request.scope[0] !== scope
            )
              throw new PublicError(400, "Invalid authorization scope or PKCE.");
            signal.throwIfAborted();
            const agent = `oauth-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
            const enrolled = await options.core.enrollAgent(owner, options.project, agent, signal);
            if (enrolled.project !== options.project || enrolled.agent !== agent)
              throw new PublicError(502, "Core enrollment identity mismatch.");
            const props = grant.parse({
              kind: "grant",
              token: enrolled.apiToken,
              project: enrolled.project,
              agent: enrolled.agent,
            });
            signal.throwIfAborted();
            const { redirectTo } = await oauth.completeAuthorization({
              request: approved.request,
              userId: encodeURIComponent(owner.subject),
              metadata: { project: enrolled.project, agent: enrolled.agent },
              scope: [scope],
              props,
            });
            const response = consentRedirect(
              approved.request,
              redirectTo,
              approved.headers,
              "approve",
            );
            consentResponses.add(response);
            return response;
          },
          config.timeoutMs,
          request.signal,
        );
      },
    },
  };
  return { configuration, consentResponses };
}

/** Provider configuration for the single core Worker. No Worker entrypoint or deployment is created. */
export function createOAuthConfiguration(options: OAuthOptions): OAuthProviderOptions<OAuthEnv> {
  return configureOAuth(options).configuration;
}

/** Bounded facade for discovery, DCR, PKCE, consent, token exchange and authenticated MCP. */
export function createOAuthHandler(options: OAuthOptions) {
  const config = endpointConfig(options);
  const { configuration, consentResponses } = configureOAuth(options);
  const provider = new OAuthProvider<OAuthEnv>(configuration);
  return async (request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> => {
    try {
      return await boundedCall(
        async (signal) => {
          const url = new URL(request.url);
          if (url.origin !== config.origin) throw new PublicError(403, "Host is not allowed.");
          const origin = request.headers.get("origin");
          if (origin && ![config.origin, ...(options.allowedOrigins ?? [])].includes(origin))
            throw new PublicError(403, "Origin is not allowed.");
          const body = request.body
            ? await readBounded(request.body, MAX_BYTES - 1, signal)
            : undefined;
          const bounded = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body,
            redirect: "manual",
            signal,
          });
          // In-process dispatch: do not fetch the provider's returned Location.
          const response = await provider.fetch(bounded, env, ctx);
          if (response.status >= 300 && response.status < 400 && !consentResponses.has(response)) {
            void response.body?.cancel().catch(() => {});
            throw new PublicError(502, "OAuth redirect refused.");
          }
          const text = await readBounded(response.body, MAX_BYTES - 1, signal);
          const headers = new Headers(response.headers);
          headers.set("cache-control", "no-store");
          return new Response(text || null, { status: response.status, headers });
        },
        config.timeoutMs,
        request.signal,
      );
    } catch (error) {
      // Do not redirect untrusted OAuth error text or expose provider/internal credentials.
      return publicFailure(
        error instanceof AuthorizationError
          ? new PublicError(400, "Authorization request is invalid or expired.")
          : error,
      );
    }
  };
}
