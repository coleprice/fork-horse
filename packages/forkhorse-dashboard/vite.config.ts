import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { fixtureMiddleware } from "./test/fixture-api.ts";

const brand = JSON.parse(readFileSync(new URL("../../brand.json", import.meta.url), "utf8"));
export default defineConfig(({ mode }) => ({
  base: mode === "fixture" ? "/" : "/app/",
  define: { __DASHBOARD_BRAND__: JSON.stringify({ name: brand.name, tagline: brand.tagline }) },
  build: {
    outDir: mode === "fixture" ? "dist-fixture" : "dist",
    rollupOptions: { input: mode === "fixture" ? "fixtures.html" : "index.html" },
  },
  plugins:
    mode === "fixture"
      ? [
          {
            name: "local-fixture-api",
            configureServer(server) {
              server.middlewares.use(fixtureMiddleware());
            },
          },
        ]
      : [],
}));
