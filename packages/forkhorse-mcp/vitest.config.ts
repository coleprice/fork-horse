import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": new URL("./__tests__/runtime.ts", import.meta.url).pathname },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
