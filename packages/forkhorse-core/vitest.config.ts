import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-11",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { SUPERVISOR: { className: "TestSupervisor", useSQLite: true } },
        bindings: {
          ARTIFACTS_NAMESPACE: "fixture",
          // SHA-256 of the test-only owner credential; no live secret is used.
          OWNER_API_TOKEN_HASH: "b8ed8496f402d68f4717b805970c4e2c30fa0c618d0549be45ed5c1b7eebd1e5",
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
