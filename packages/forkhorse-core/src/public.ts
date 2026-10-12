import { createCoreClient, createOAuthHandler, PublicError } from "forkhorse-mcp";
import type { OAuthEnv, OwnerIdentity } from "forkhorse-mcp";
import { dispatchApi } from "./api";
import { verifyOwner } from "./access";
import { errorResponse, HttpError, json, operation, slug } from "./http";
import type { Env } from "./types";
import brand from "../../../brand.json";
import { markIconUrl } from "../../forkhorse-dashboard/src/mark";

function settings(env: Env) {
  const origin = env.CORE_PUBLIC_ORIGIN;
  const path = env.MCP_PATH ?? "/mcp";
  const project = env.MCP_PROJECT;
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://") ||
    !/^\/[a-z0-9-]+$/.test(path) ||
    ["/app", "/projects", "/authorize", "/oauth"].includes(path) ||
    !slug(project)
  )
    throw new HttpError(503, "Public core configuration is incomplete.");
  return { origin, path, project };
}

function requireHost(request: Request, origin: string) {
  if (new URL(request.url).origin !== origin) throw new HttpError(403, "Host is not allowed.");
}

async function oauth(request: Request, env: Env, ctx: ExecutionContext) {
  const config = settings(env);
  if (!env.OAUTH_KV) throw new HttpError(503, "OAuth storage is not configured.");
  // This proof lives for one request; only the Access verifier can populate it.
  let verifiedOwner: OwnerIdentity | null = null;
  const core = createCoreClient({
    async authenticate(token, signal) {
      signal.throwIfAborted();
      const identity = await env.SUPERVISOR.get(
        env.SUPERVISOR.idFromName(config.project),
      ).authenticateAgent(token);
      signal.throwIfAborted();
      return identity;
    },
    fetch: (coreRequest) => dispatchApi(coreRequest, env),
    async enrollAgent(owner, project, agent, signal) {
      signal.throwIfAborted();
      if (!verifiedOwner || owner.subject !== verifiedOwner.subject || project !== config.project)
        throw new PublicError(403, "Owner authorization is required.");
      const response = await dispatchApi(
        new Request(`https://core.invalid/projects/${project}/agents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent }),
          signal,
        }),
        env,
        true,
      );
      if (response.status !== 201) throw new PublicError(502, "Agent enrollment failed.");
      const enrolled = await response.json<{ agent: string; apiToken: string }>();
      return { project, ...enrolled };
    },
  });
  const response = await createOAuthHandler({
    core,
    publicOrigin: config.origin,
    path: config.path,
    project: config.project,
    async authorizeOwner(ownerRequest, signal) {
      signal.throwIfAborted();
      verifiedOwner = await verifyOwner(ownerRequest, env);
      signal.throwIfAborted();
      return verifiedOwner;
    },
  })(request, { OAUTH_KV: env.OAUTH_KV } as unknown as OAuthEnv, ctx);
  // Add identity only to successful consent HTML; preserve redirects, cookies and auth checks.
  if (new URL(request.url).pathname === "/authorize" && request.method === "GET" &&
      response.status === 200 && response.headers.get("content-type")?.includes("text/html")) {
    return new HTMLRewriter().on("head", {
      element(element) {
        element.append(`<link rel="icon" type="image/svg+xml" href="${markIconUrl(brand.mark)}">`, { html: true });
      },
    }).transform(response);
  }
  return response;
}

async function dashboard(request: Request, env: Env): Promise<Response> {
  const config = settings(env);
  requireHost(request, config.origin);
  if (!(await verifyOwner(request, env)))
    throw new HttpError(401, "Owner Access authentication is required.");
  if (!["GET", "HEAD"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
  if (!env.ASSETS) throw new HttpError(503, "Dashboard assets are not configured.");
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/app\/?/, "/");
  if (url.pathname === "/") url.pathname = "/index.html";
  // The binding is reached only after verification, even for JS/CSS. Do not forward credentials.
  const asset = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  headers.delete("etag");
  let response = new Response(asset.body, { status: asset.status, headers });
  if (request.method === "GET" && asset.ok && headers.get("content-type")?.includes("text/html")) {
    const data = JSON.stringify({
      projects: [{ id: config.project, label: config.project }],
    }).replaceAll("<", "\\u003c");
    response = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.append(`<script id="dashboard-config" type="application/json">${data}</script>`, {
            html: true,
          });
        },
      })
      .transform(response);
  }
  return response;
}

export async function publicFetch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/app" || url.pathname.startsWith("/app/"))
      return await dashboard(request, env);
    if (
      url.pathname === (env.MCP_PATH ?? "/mcp") ||
      url.pathname === "/authorize" ||
      url.pathname.startsWith("/oauth/") ||
      url.pathname.startsWith("/.well-known/")
    ) {
      if (!ctx) throw new HttpError(503, "OAuth execution context is unavailable.");
      return await oauth(request, env, ctx);
    }
    if (url.pathname === "/projects" || url.pathname.startsWith("/projects/")) {
      // Browser owner authority comes from Access, never a client-selected identity/header.
      if (
        request.headers.has("origin") ||
        !request.headers.has("authorization") ||
        request.headers.has("cf-access-jwt-assertion")
      ) {
        const { origin } = settings(env);
        requireHost(request, origin);
        if (!(await verifyOwner(request, env)))
          throw new HttpError(401, "Owner Access authentication is required.");
        const suppliedOrigin = request.headers.get("origin");
        if (
          (suppliedOrigin && suppliedOrigin !== origin) ||
          (!["GET", "HEAD"].includes(request.method) &&
            (suppliedOrigin !== origin ||
              request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"))
        ) {
          throw new HttpError(403, "Owner request origin or content type is not allowed.");
        }
        return await dispatchApi(request, env, true);
      }
      return await dispatchApi(request, env);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    return errorResponse(error, { op: operation(request) });
  }
}
