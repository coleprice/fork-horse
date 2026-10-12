import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        // Native workerd fetch reaches this offline peer after RequestInit validation.
        outboundService: "git-http-fixture",
        workers: [{
          name: "git-http-fixture",
          modules: true,
          scriptPath: new URL("./__tests__/git-http-fixture.js", import.meta.url).pathname,
          compatibilityDate: "2026-10-11",
        }],
        compatibilityDate: "2026-10-11",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { SUPERVISOR: { className: "TestSupervisor", useSQLite: true } },
        assets: {
          directory: "../forkhorse-dashboard/dist", binding: "ASSETS", run_worker_first: true,
          assetConfig: { html_handling: "none", not_found_handling: "none" },
        },
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          CORE_PUBLIC_ORIGIN: "https://api.idiot.tax",
          MCP_PROJECT: "mcp-fixture",
          CORE_ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          CORE_ACCESS_AUDIENCE: "offline-audience",
          CORE_ACCESS_OWNERS: ["owner@idiot.tax"],
          ARTIFACTS_NAMESPACE: "fixture",
          // SHA-256 of the test-only owner credential; no live secret is used.
          OWNER_API_TOKEN_HASH: "b8ed8496f402d68f4717b805970c4e2c30fa0c618d0549be45ed5c1b7eebd1e5",
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
