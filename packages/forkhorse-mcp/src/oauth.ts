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
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(brand.name)} authorization</title></head><body>
<h1>Allow ${escape(details.clientName)} to work on ${escape(project)}?</h1>
<p>This enrolls a new agent with permission to read project state, create its own forks, claim packets, submit work and request review.</p>
<p>Client names from dynamic registration are self-asserted. Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.clientDomain ? `<p>Client domain: ${escape(details.clientDomain)}</p>` : ""}
${details.redirectIsLoopback ? "<p>This sends access to an app on your computer. Continue only if you started this login.</p>" : ""}
<p>Scope: ${details.scope.map(escape).join(", ")}</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form></body></html>`;
}

/** Provider configuration for the single core Worker. No Worker entrypoint or deployment is created. */
export function createOAuthConfiguration(options: OAuthOptions): OAuthProviderOptions<OAuthEnv> {
  const config = endpointConfig(options);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.project) || options.project.length > 48)
    throw new Error("Invalid OAuth project.");
  const mcp = createMcpHandler(options);
  return {
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
              return new Response(null, { status: 302, headers: denied.headers });
            }
            if (form.get("decision") !== "approve")
              throw new PublicError(400, "An explicit consent decision is required.");
            const approved = await oauth.approveConsent(request, handle);
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
            approved.headers.set("location", redirectTo);
            return new Response(null, { status: 302, headers: approved.headers });
          },
          config.timeoutMs,
          request.signal,
        );
      },
    },
  };
}

/** Bounded facade for discovery, DCR, PKCE, consent, token exchange and authenticated MCP. */
export function createOAuthHandler(options: OAuthOptions) {
  const config = endpointConfig(options);
  const provider = new OAuthProvider<OAuthEnv>(createOAuthConfiguration(options));
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
            redirect: "error",
            signal,
          });
          const response = await provider.fetch(bounded, env, ctx);
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
