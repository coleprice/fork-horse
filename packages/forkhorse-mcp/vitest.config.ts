import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "cloudflare:workers": new URL("./__tests__/runtime.ts", import.meta.url).pathname,
          },
        },
        test: {
          name: "node",
          include: ["__tests__/*.test.ts"],
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./__tests__/workerd/worker.ts",
            miniflare: {
              compatibilityDate: "2026-10-11",
              compatibilityFlags: ["nodejs_compat"],
              kvNamespaces: ["OAUTH_KV"],
            },
          }),
        ],
        test: { name: "workerd", include: ["__tests__/workerd/*.test.ts"] },
      },
    ],
  },
});
