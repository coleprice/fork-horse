import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoreClient, PublicError } from "../../src/core";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { consentRedirect } from "../../src/consent";
import type { OAuthEnv } from "../../src/oauth";
import worker, { fixtureCalls, fixtureCore } from "./worker";

const origin = "https://mcp.fixture.idiot.tax";
function request(path: string, init?: RequestInit) {
  return worker.fetch(
    new Request(`${origin}${path}`, init),
    env as OAuthEnv,
    createExecutionContext(),
  );
}
function rpc(method: string, params?: unknown) {
  return request("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer api_fixture_builder",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function authorization(redirectUri: string, clientName = "Offline consent fixture") {
  const registered = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp:agent",
    resource: `${origin}/mcp`,
    state: "fixture-state",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
  });
  return { clientId, query };
}

// Every network destination remains blocked: all responses below are offline fixtures.
const outbound = vi.fn(async () => {
  throw new Error("Offline fixture blocks outbound fetch.");
});
beforeAll(() => {
  vi.stubGlobal("fetch", outbound);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(outbound).not.toHaveBeenCalled();
});

describe("offline workerd regression", () => {
  it("serves authenticated MCP tools/list through the OAuth facade", async () => {
    const response = await rpc("tools/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(body.result.tools.map((tool) => tool.name).toSorted()).toEqual([
      "activity",
      "claim",
      "get_context",
      "join",
      "refresh_token",
      "request_review",
      "status",
      "submit_work",
    ]);
    for (const tool of body.result.tools)
      expect(tool.annotations.readOnlyHint).toBe(
        ["activity", "get_context", "status"].includes(tool.name),
      );
    expect((await request("/mcp")).status).toBe(401);
  });

  it("serves discovery and registers a dynamic client against workerd KV", async () => {
    const discovery = await request("/.well-known/oauth-authorization-server");
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      registration_endpoint: `${origin}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
    const resource = await request("/.well-known/oauth-protected-resource/mcp");
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
    const registration = await request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Offline fixture",
        redirect_uris: ["https://client.fixture.idiot.tax/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    expect(await registration.json()).toMatchObject({ client_id: expect.any(String) });
  });

  it("renders escaped consent and the unchanged form under workerd, including the loopback warning", async () => {
    const clientName = `<img onerror="fixture">&'`;
    const { query } = await authorization("http://127.0.0.1:1234/callback", clientName);
    const page = await request(`/authorize?${query}`, {
      headers: { "x-fixture-owner": "verified" },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("&#60;img onerror=&#34;fixture&#34;&#62;&#38;&#39;");
    expect(html).not.toMatch(/<img|<script|autofocus|<link|@import|url\(/i);
    expect(html).toContain('<strong><code>127.0.0.1</code></strong>');
    expect(html).toContain("an app on your computer");
    expect(html).toContain('role="note"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('<form method="post"><input type="hidden" name="handle"');
    const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html)![1]!;
    expect(form.indexOf('value="deny"')).toBeLessThan(form.indexOf('value="approve"'));
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["approve", "deny"] as const)(
    "emits the %s consent response only to the exact registered callback",
    async (decision) => {
      const registeredUri = "https://client.fixture.idiot.tax/callback?mode=fixture";
      const { query } = await authorization(registeredUri);
      const page = await request(`/authorize?${query}`, {
        headers: { "x-fixture-owner": "verified" },
      });
      expect(page.status).toBe(200);
      const html = await page.text();
      const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
      expect(handle).toBeTruthy();
      const cookie = page.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const response = await request("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie,
          "x-fixture-owner": "verified",
        },
        body: new URLSearchParams({ handle: handle!, decision }),
      });
      expect(response.status).toBe(302);
      const target = new URL(response.headers.get("location")!);
      expect(target.searchParams.get("state")).toBe("fixture-state");
      expect(target.searchParams.get("iss")).toBe(origin);
      if (decision === "approve") {
        expect(target.searchParams.get("code")).toBeTruthy();
        target.searchParams.delete("code");
      } else {
        expect(target.searchParams.get("error")).toBe("access_denied");
        target.searchParams.delete("error");
      }
      target.searchParams.delete("state");
      target.searchParams.delete("iss");
      expect(target.href).toBe(registeredUri);
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["https://client.fixture.idiot.tax/callback", "https://other.fixture.idiot.tax/callback"],
    [
      "https://client.fixture.idiot.tax/callback",
      "https://client.fixture.idiot.tax/callback/extra",
    ],
    [
      "https://client.fixture.idiot.tax/callback?mode=fixture",
      "https://client.fixture.idiot.tax/callback?mode=other",
    ],
    ["http://127.0.0.1:1234/callback", "http://127.0.0.1:5678/callback"],
  ])(
    "rejects registered URI %s when the request instead uses %s",
    async (registeredUri, mismatchedUri) => {
      const { query } = await authorization(registeredUri);
      query.set("redirect_uri", mismatchedUri);
      const response = await request(`/authorize?${query}`, {
        headers: { "x-fixture-owner": "verified" },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain(mismatchedUri);
    },
  );

  it("rejects a wrapped provider redirect that was not a validated consent response", async () => {
    const provider = vi
      .spyOn(OAuthProvider.prototype, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.fixture.idiot.tax/callback" },
        }),
      );
    try {
      const response = await request("/.well-known/oauth-authorization-server");
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "OAuth redirect refused." });
      expect(response.headers.get("location")).toBeNull();
    } finally {
      provider.mockRestore();
    }
  });

  it("rejects changed callback targets and extra fields in provider-generated consent Locations", () => {
    const auth: AuthRequest = {
      clientId: "fixture",
      redirectUri: "https://client.fixture.idiot.tax/callback?mode=fixture",
      responseType: "code",
      scope: ["mcp:agent"],
      state: "fixture-state",
      issuer: origin,
    };
    const valid = new URL(auth.redirectUri);
    valid.searchParams.set("code", "fixture-code");
    valid.searchParams.set("state", auth.state);
    valid.searchParams.set("iss", origin);
    for (const mutate of [
      (url: URL) => {
        url.hostname = "other.fixture.idiot.tax";
      },
      (url: URL) => {
        url.pathname = "/other";
      },
      (url: URL) => {
        url.searchParams.set("mode", "other");
      },
      (url: URL) => {
        url.searchParams.set("extra", "unregistered");
      },
      (url: URL) => {
        url.searchParams.append("code", "duplicate");
      },
      (url: URL) => {
        url.hash = "unexpected";
      },
    ]) {
      const changed = new URL(valid);
      mutate(changed);
      expect(() => consentRedirect(auth, changed.href, new Headers(), "approve")).toThrow(
        "OAuth consent redirect refused.",
      );
    }
  });

  it("refuses the fixture core's 302 without following or leaking its target", async () => {
    fixtureCalls.length = 0;
    const response = await rpc("tools/call", { name: "status", arguments: { project: "demo" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "Core redirect refused." }] },
    });
    expect(fixtureCalls).toEqual([{ path: "/projects/demo/state", redirect: "manual" }]);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399])(
    "refuses upstream status %i with a sanitized error",
    async (status) => {
      const calls: RequestRedirect[] = [];
      const core = createCoreClient({
        authenticate: fixtureCore.authenticate,
        enrollAgent: fixtureCore.enrollAgent,
        fetch: async (req) => {
          calls.push(req.redirect);
          return new Response(null, {
            status,
            headers: { location: "https://redirect.fixture.idiot.tax/private" },
          });
        },
      });
      await expect(
        core.execute(
          "api_fixture_builder",
          { kind: "state", project: "demo" },
          new AbortController().signal,
        ),
      ).rejects.toEqual(new PublicError(502, "Core redirect refused."));
      expect(calls).toEqual(["manual"]);
    },
  );
});
