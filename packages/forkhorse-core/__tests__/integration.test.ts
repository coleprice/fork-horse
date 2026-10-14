import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import brand from "../../../brand.json";
import { markIconUrl } from "../../forkhorse-dashboard/src/mark";
import type { StateSnapshot, WorkItem } from "../src/workflow-types";
import { BEFORE } from "./fixtures";

const origin = "https://api.idiot.tax";
const issuer = "https://fixture.cloudflareaccess.com";
const ownerToken = "offline-fixture-owner-token";
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let agentToken: string;
async function jwt(claims: Record<string, unknown> = {}, key = privateKey) {
  return new SignJWT({ email: "owner@idiot.tax", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "offline" })
    .setSubject("offline-owner")
    .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
    .setAudience(typeof claims.aud === "string" ? claims.aud : "offline-audience")
    .setIssuedAt(typeof claims.iat === "number" ? claims.iat : Math.floor(Date.now() / 1000))
    .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
    .sign(key);
}
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function rpc(token: string, method = "tools/list", params: unknown = {}) {
  return call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "offline", alg: "RS256", use: "sig" }],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected outbound request in offline test.");
    return Response.json(jwks);
  });
  const created = await call("/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ id: "mcp-fixture", agents: ["alpha"] }),
  });
  expect(created.status).toBe(201);
  agentToken = (await created.json<{ agents: { apiToken: string }[] }>()).agents[0]!.apiToken;
});
afterAll(() => vi.restoreAllMocks());

describe("public core integration with offline signed JWTs, KV, DO and built dashboard assets", () => {
  it("gates HTML and assets before serving, injects project config and refuses root asset aliases", async () => {
    for (const path of ["/app", "/app/", "/app/assets/absent.js"]) {
      expect((await call(path)).status).toBe(401);
      expect((await call(path, { headers: { "cf-access-jwt-assertion": "forged" } })).status).toBe(
        401,
      );
    }
    const headers = { "cf-access-jwt-assertion": await jwt() };
    const page = await call("/app", { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${markIconUrl(brand.mark)}">`);
    expect(html.match(/rel="icon"/g)).toHaveLength(1);
    expect(html).toContain('id="dashboard"');
    expect(html).toContain('id="dashboard-config"');
    expect(html).toContain('"label":"mcp-fixture"');
    const assetPath = /src="(\/app\/assets\/[^"]+\.js)"/.exec(html)![1]!;
    expect((await call(assetPath, { headers })).status).toBe(200);
    expect((await call(assetPath)).status).toBe(401);
    expect((await call(assetPath.replace("/app", ""), { headers })).status).toBe(404);
    expect((await call("/app/missing", { headers })).status).toBe(404);
  });
  it("rejects bad signature, issuer, audience, time and non-owner identity", async () => {
    const tokens = [
      await jwt({}, otherKey),
      await jwt({ iss: "https://other.cloudflareaccess.com" }),
      await jwt({ aud: "other-application" }),
      await jwt({ exp: 1 }),
      await jwt({ iat: Math.floor(Date.now() / 1000) + 60 }),
      await jwt({ nbf: Math.floor(Date.now() / 1000) + 60 }),
      await jwt({ email: "agent@idiot.tax" }),
    ];
    for (const token of tokens)
      expect((await call("/app", { headers: { "cf-access-jwt-assertion": token } })).status).toBe(
        401,
      );
  });
  it("requires verified Access and exact browser origin for owner API mutations", async () => {
    const data = JSON.stringify({ id: "browser-owner", agents: ["alpha"] });
    expect(
      (
        await call("/projects", {
          method: "POST",
          headers: { origin, authorization: `Bearer ${ownerToken}` },
          body: data,
        })
      ).status,
    ).toBe(401);
    const proof = { cookie: `CF_Authorization=${await jwt()}`, "content-type": "application/json" };
    for (const extra of [{}, { origin: "https://other.idiot.tax" }] as Record<string, string>[]) {
      expect(
        (await call("/projects", { method: "POST", headers: { ...proof, ...extra }, body: data }))
          .status,
      ).toBe(403);
    }
    expect(
      (await call("/projects", { method: "POST", headers: { ...proof, origin }, body: data }))
        .status,
    ).toBe(201);
    expect((await call("/projects/browser-owner/state", { headers: proof })).status).toBe(200);
    expect(
      (await call("/projects/browser-owner/state", { headers: { "x-owner": "true" } })).status,
    ).toBe(401);
    expect(
      (
        await call("/projects/browser-owner/state", {
          headers: { cookie: "CF_Authorization=forged" },
        })
      ).status,
    ).toBe(401);
    const spoof = await worker.fetch(
      new Request("https://other.idiot.tax/app", { headers: proof }),
      env,
    );
    expect(spoof.status).toBe(403);
  });
  it("attributes settings changes to verified Access and refuses client-selected owner sources", async () => {
    const path = "/projects/mcp-fixture/settings";
    const headers = { origin, "content-type": "application/json", "cf-access-jwt-assertion": await jwt() };
    expect((await call(path, {
      method: "PATCH", headers: { origin, "content-type": "application/json", "x-owner": "true" },
      body: JSON.stringify({ requireReceipt: false }),
    })).status).toBe(401);
    expect((await call(path, {
      method: "PATCH", headers, body: JSON.stringify({ requireReceipt: false, via: "owner-api" }),
    })).status).toBe(400);
    const response = await call(path, { method: "PATCH", headers, body: JSON.stringify({ requireReceipt: false }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: { requireReceipt: false } });
    const snapshot = await (await call("/projects/mcp-fixture/state", { headers })).json<StateSnapshot>();
    expect(snapshot.project.settings).toEqual({ requireReceipt: false });
    expect(snapshot.settingsChanges).toEqual([{
      setting: "requireReceipt", before: true, after: false, by: "owner", via: "access",
      recordedAt: expect.any(String),
    }]);
    // Restore this shared offline project for the remaining OAuth tests.
    expect((await call(path, { method: "PATCH", headers, body: JSON.stringify({ requireReceipt: true }) })).status).toBe(200);
  });
  it("wraps tools/list in OAuth discovery/authentication and binds calls to enrolled identity", async () => {
    const anonymous = await call("/mcp");
    expect(anonymous.status, await anonymous.clone().text()).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const meta = await call("/.well-known/oauth-protected-resource/mcp");
    expect(await meta.json()).toMatchObject({ resource: `${origin}/mcp` });
    for (const token of [ownerToken, "wrong"]) expect((await rpc(token)).status).toBe(401);
    const listed = await rpc(agentToken);
    expect(listed.status).toBe(200);
    const result = await listed.json<{ result: { tools: { name: string }[] } }>();
    expect(result.result.tools.map((tool) => tool.name)).toEqual([
      "get_context",
      "status",
      "list_judge_races",
      "get_review",
      "get_review_diff",
      "submit_verdict",
      "refresh_token",
      "activity",
      "join",
      "claim",
      "report_usage",
      "request_review",
      "submit_work",
    ]);
    const state = await rpc(agentToken, "tools/call", {
      name: "status",
      arguments: { project: "mcp-fixture" },
    });
    const stateResult = await state.json<{ result: { isError?: boolean; content: { text: string }[] } }>();
    expect(stateResult.result.isError).not.toBe(true);
    expect(JSON.parse(stateResult.result.content[0]!.text)).toMatchObject({
      project: { id: "mcp-fixture" }, myWork: [],
    });

    // Exercise FH-041's real /me implementation, with only Artifacts remaining offline.
    // Create a real registered fork/claim through core; do not supply a hand-made work summary.
    const post = (path: string, token: string, data: unknown) => call(`/projects/mcp-fixture${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    expect((await post("/packets", ownerToken, {
      id: "resume", title: "Resume integration", goal: "Continue claimed work",
      paths: ["src/**"], acceptance: ["Check resume summary"],
    })).status).toBe(201);
    const joined = await post("/join", agentToken, { agent: "alpha" });
    expect(joined.status).toBe(201);
    const { repoName } = await joined.json<{ repoName: string }>();
    expect((await post("/packets/resume/claim", agentToken, { repoName })).status).toBe(201);
    const me = await call("/projects/mcp-fixture/me", {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(me.status).toBe(200);
    const { work } = await me.json<{ work: WorkItem[] }>();
    expect(work).toEqual([{
      packet: { id: "resume", title: "Resume integration" }, repoName,
      claimedAt: expect.any(String), forkHead: BEFORE, canonicalHead: BEFORE,
      review: null, next: "push", hint: "Push your changes to the claimed fork.",
    }]);
    for (const name of ["status", "get_context"]) {
      const resumed = await rpc(agentToken, "tools/call", { name, arguments: { project: "mcp-fixture" } });
      expect(resumed.status).toBe(200);
      const { result: summary } = await resumed.json<{ result: { isError?: boolean; content: { text: string }[] } }>();
      expect(summary.isError).not.toBe(true);
      expect(JSON.parse(summary.content[0]!.text)).toMatchObject({
        project: { id: "mcp-fixture" }, myWork: work,
      });
      expect(summary.content.slice(1)).toEqual([{
        type: "text", text: `resume on ${repoName} → next: push — ${work[0]!.hint}`,
      }]);
    }
    const denied = await rpc(agentToken, "tools/call", {
      name: "join",
      arguments: { project: "mcp-fixture", agent: "beta" },
    });
    expect(await denied.json()).toMatchObject({ result: { isError: true } });
  });
  it("completes real PKCE consent through Access and enrolls only the grant agent", async () => {
    const redirect = "https://client.idiot.tax/callback";
    const verifier = "offline-pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...digest))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const registration = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Offline fixture",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json<{ client_id: string }>();
    const authorize = `/authorize?${new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code", scope: "mcp:agent", resource: `${origin}/mcp`, state: "fixture", code_challenge: challenge, code_challenge_method: "S256" })}`;
    expect((await call(authorize)).status).toBe(403);
    const proof = { "cf-access-jwt-assertion": await jwt() };
    const page = await call(authorize, { headers: proof });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${markIconUrl(brand.mark)}">`);
    expect(html.match(/rel="icon"/g)).toHaveLength(1);
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    const cookie = page.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const consent = await call("/authorize", {
      method: "POST",
      headers: { ...proof, origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const exchanged = await call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json<{ access_token: string }>();
    expect((await rpc(tokens.access_token)).status).toBe(200);
    const snapshot = await call("/projects/mcp-fixture/state", { headers: proof });
    const agents = (await snapshot.json<{ agents: { name: string }[] }>()).agents;
    expect(agents.filter((agent) => agent.name.startsWith("oauth-"))).toHaveLength(1);
    // Rotation invalidates the provider grant on its next MCP request.
    const grantAgent = agents.find((agent) => agent.name.startsWith("oauth-"))!;
    expect(
      (
        await call(`/projects/mcp-fixture/agents/${grantAgent.name}/rotate`, {
          method: "POST",
          headers: { ...proof, origin, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect((await rpc(tokens.access_token)).status).toBe(401);
  });
});
