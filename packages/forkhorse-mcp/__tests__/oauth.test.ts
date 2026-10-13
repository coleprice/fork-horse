import { describe, expect, it } from "vitest";
import { createOAuthConfiguration, createOAuthHandler } from "../src/oauth";
import type { ConsentDescription, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthEnv } from "../src/oauth";
import { FixtureCore, fixtureContext, fixtureKv } from "./fixtures";

const origin = "https://mcp.idiot.tax";
const resource = `${origin}/mcp`;
const verifier = "fixture-pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
const redirect = "https://client.idiot.tax/callback";
async function setup() {
  const core = new FixtureCore();
  const env = { OAUTH_KV: fixtureKv() } as OAuthEnv;
  const handler = createOAuthHandler({
    core: core.client,
    publicOrigin: origin,
    project: "demo",
    authorizeOwner: async (request) =>
      request.headers.get("x-fixture-owner") === "verified" ? { subject: "fixture-owner" } : null,
  });
  const fetch = (request: Request) => handler(request, env, fixtureContext());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const registered = await fetch(
    new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>fixture</script>",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect(registered.status).toBe(201);
  const registration = (await registered.json()) as { client_id: string };
  const authorization = new URL(`${origin}/authorize`);
  authorization.search = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "mcp:agent",
    resource,
    state: "fixture-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { core, fetch, authorization, registration };
}
async function consent() {
  const setupResult = await setup();
  const page = await setupResult.fetch(
    new Request(setupResult.authorization, { headers: { "x-fixture-owner": "verified" } }),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { ...setupResult, html, handle: handle!, cookie, page };
}
function decision(handle: string, cookie: string, value = "approve", verified = true) {
  return new Request(`${origin}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie,
      ...(verified ? { "x-fixture-owner": "verified" } : {}),
    },
    body: new URLSearchParams({ handle, decision: value }),
  });
}
function tokenRequest(client: string, code: string, codeVerifier: string) {
  return new Request(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client,
      code,
      redirect_uri: redirect,
      code_verifier: codeVerifier,
      resource,
    }),
  });
}

describe("real OAuth provider with labeled in-memory fixtures", () => {
  it("serves RFC 9728 and authorization-server discovery with configured URLs and PKCE", async () => {
    const { fetch } = await setup();
    const metadata = await fetch(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    });
    const as = await fetch(new Request(`${origin}/.well-known/oauth-authorization-server`));
    expect(as.status).toBe(200);
    expect(await as.json()).toMatchObject({
      issuer: origin,
      registration_endpoint: `${origin}/oauth/register`,
      token_endpoint: `${origin}/oauth/token`,
      authorization_endpoint: `${origin}/authorize`,
      code_challenge_methods_supported: ["S256"],
    });
    const unauthorized = await fetch(new Request(resource));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });
  it("requires verified owner access before consent or enrollment, and escapes client metadata", async () => {
    const { fetch, authorization, core } = await setup();
    expect((await fetch(new Request(authorization))).status).toBe(403);
    expect(core.enrollments).toBe(0);
    const { html, handle, cookie, page } = await consent();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("client.idiot.tax");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(decision(handle, cookie, "approve", false))).status).toBe(403);
    expect(core.enrollments).toBe(0);
  });
  it("keeps the post form and explicit decisions while making denial the first control", async () => {
    const { html, page, core } = await consent();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('role="note"');
    expect(html).toContain("It can't approve or promote. Those stay with you.");
    expect(html).toContain("<ul><li>read project state</li>");
    const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html)!;
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(form[0].slice(0, form[0].indexOf(">") + 1)).toBe('<form method="post">');
    expect(form[1]!.match(/<input\b[^>]*>/g)).toEqual([
      expect.stringMatching(/^<input type="hidden" name="handle" value="[^"<>]+">$/),
    ]);
    expect(form[1]!.match(/<button\b[^>]*>[^<]*<\/button>/g)).toEqual([
      '<button type="submit" name="decision" value="deny">Deny</button>',
      '<button type="submit" name="decision" value="approve">Allow</button>',
    ]);
    expect(html).not.toMatch(/autofocus|<script\b|<link\b|@import|url\(/i);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(core.enrollments).toBe(0);
  });
  it("escapes every metadata and hidden-field context without rendering client URLs", async () => {
    const hostile = `&<img src=x onerror="fixture">'`;
    const escaped = "&#38;&#60;img src=x onerror=&#34;fixture&#34;&#62;&#39;";
    const core = new FixtureCore();
    const auth = {
      clientId: "fixture", redirectUri: redirect, responseType: "code",
      scope: ["mcp:agent"], codeChallenge: "A".repeat(43), codeChallengeMethod: "S256",
    };
    const details: ConsentDescription = {
      clientId: "fixture", clientName: hostile.repeat(40), clientDomain: hostile,
      redirectHost: hostile, redirectUri: redirect, redirectIsLoopback: true,
      scope: ["mcp:agent", hostile],
      clientUri: "https://untrusted.idiot.tax", logoUri: "https://untrusted.idiot.tax/logo",
    };
    // Labeled provider fixture lets impossible metadata test every escaping boundary directly.
    const oauth = {
      parseAuthRequest: async () => auth,
      lookupClient: async () => ({ redirectUris: [redirect] }),
      describeConsent: async () => details,
      beginConsent: async () => ({ handle: hostile, headers: new Headers() }),
    } as unknown as OAuthHelpers;
    const configuration = createOAuthConfiguration({
      core: core.client, publicOrigin: origin, project: "demo",
      authorizeOwner: async () => ({ subject: "fixture-owner" }),
    });
    const handler = configuration.defaultHandler as {
      fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response>;
    };
    const response = await handler.fetch(new Request(`${origin}/authorize`), {
      OAUTH_KV: fixtureKv(), OAUTH_PROVIDER: oauth,
    }, fixtureContext());
    const html = await response.text();
    expect(html).toContain(escaped.repeat(40));
    expect(html).toContain(`<strong><code>${escaped}</code></strong>`);
    expect(html).toContain(`Client domain: <code>${escaped}</code>`);
    expect(html).toContain(`name="handle" value="${escaped}"`);
    expect(html).toContain(`<code>mcp:agent, ${escaped}</code>`);
    expect(html).toContain("an app on your computer");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://untrusted.idiot.tax");
    expect(core.enrollments).toBe(0);
  });
  it("enforces PKCE, explicit scope, browser-bound consent, denial and replay protection", async () => {
    const { fetch, authorization, core } = await setup();
    for (const method of ["plain", ""]) {
      authorization.searchParams.set("code_challenge_method", method);
      expect(
        (await fetch(new Request(authorization, { headers: { "x-fixture-owner": "verified" } })))
          .status,
      ).toBe(400);
    }
    const c = await consent();
    expect((await c.fetch(decision(c.handle, ""))).status).toBe(400);
    expect(c.core.enrollments).toBe(0);
    const denied = await c.fetch(decision(c.handle, c.cookie, "deny"));
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
    expect((await c.fetch(decision(c.handle, c.cookie))).status).toBe(400);
    expect(c.core.enrollments).toBe(0);
    expect(core.enrollments).toBe(0);
  });
  it("maps an approved grant to new enrollment and passes only its core credential to MCP", async () => {
    const { fetch, handle, cookie, registration, core } = await consent();
    const approved = await fetch(decision(handle, cookie));
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin).toBe("https://client.idiot.tax");
    expect(location.searchParams.get("state")).toBe("fixture-state");
    expect(core.enrollments).toBe(1);
    const exchange = await fetch(
      tokenRequest(registration.client_id, location.searchParams.get("code")!, verifier),
    );
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();
    expect(JSON.stringify(tokens)).not.toContain("api_fixture_oauth");
    const response = await fetch(
      new Request(resource, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "status", arguments: { project: "demo" } },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.headers.get("authorization")).toBe("Bearer api_fixture_oauth_1");
    expect((await fetch(decision(handle, cookie))).status).toBe(400);
    // Revoking the enrolled core token immediately invalidates effective grant access.
    core.tokens.delete("api_fixture_oauth_1");
    const revoked = await fetch(
      new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
    );
    expect(revoked.status).toBe(401);
  });
  it("rejects a wrong PKCE verifier and unregistered redirect without leaking a credential", async () => {
    const { fetch, handle, cookie, registration, authorization } = await consent();
    const approved = await fetch(decision(handle, cookie));
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const bad = await fetch(tokenRequest(registration.client_id, code, "wrong".repeat(12)));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("api_fixture");
    authorization.searchParams.set("redirect_uri", "https://attacker.idiot.tax/callback");
    const redirectRejected = await fetch(
      new Request(authorization, { headers: { "x-fixture-owner": "verified" } }),
    );
    expect(redirectRejected.status).toBe(400);
    expect(redirectRejected.headers.get("location")).toBeNull();
  });
  it("accepts direct enrolled bearer tokens through the same OAuth facade", async () => {
    const { fetch } = await setup();
    const response = await fetch(
      new Request(resource, {
        method: "POST",
        headers: {
          authorization: "Bearer api_fixture_builder",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(7);
  });
});
