import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Actual workerd with mocked ContainerPort; no Docker or provider calls.
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: {
    compatibilityDate: "2026-10-11", compatibilityFlags: ["nodejs_compat"],
  } })],
  test: { include: ["__tests__/*.test.ts"] },
});
