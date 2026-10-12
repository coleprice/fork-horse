import { createCoreClient } from "../../src/core";
import { createOAuthHandler } from "../../src/oauth";
import type { OAuthEnv } from "../../src/oauth";

/** Offline core fixture. No production adapter, credentials or provider traffic. */
export const fixtureCalls: { path: string; redirect: RequestRedirect }[] = [];
export const fixtureCore = createCoreClient({
  authenticate: async (token) =>
    token === "api_fixture_builder" ? { project: "demo", agent: "builder" } : null,
  enrollAgent: async (_owner, project, agent) => ({
    project,
    agent,
    apiToken: "api_fixture_enrolled",
  }),
  fetch: async (request) => {
    fixtureCalls.push({ path: new URL(request.url).pathname, redirect: request.redirect });
    return new Response("fixture upstream detail must not leak", {
      status: 302,
      headers: { location: "https://redirect.fixture.idiot.tax/private?fixture=do-not-echo" },
    });
  },
});
const handler = createOAuthHandler({
  core: fixtureCore,
  publicOrigin: "https://mcp.fixture.idiot.tax",
  project: "demo",
  // This test-only flag stands in for the FH-012 owner verifier; it is not production auth.
  authorizeOwner: async (request) =>
    request.headers.get("x-fixture-owner") === "verified" ? { subject: "fixture-owner" } : null,
});

/** Test-only entrypoint exercises actual workerd APIs and local KV, with no Node runtime shim. */
export default {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext) {
    return handler(request, env, ctx);
  },
};
