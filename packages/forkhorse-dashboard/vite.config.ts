import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig, type ViteDevServer } from "vite-plus";
import { fixtureMiddleware } from "./test/fixture-api.ts";
import { markIconUrl } from "./src/mark.ts";

const brand = JSON.parse(readFileSync(new URL("../../brand.json", import.meta.url), "utf8"));
export default defineConfig(({ mode }) => ({
  base: mode === "fixture" ? "/" : "/app/",
  define: { __DASHBOARD_BRAND__: JSON.stringify({ name: brand.name, tagline: brand.tagline }) },
  build: {
    outDir: mode === "fixture" ? "dist-fixture" : "dist",
    rollupOptions: {
      onwarn(warning, warn) {
        // Kumo is client-only here; Rollup may safely remove its React server directive.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes("use client"))
          return;
        warn(warning);
      },
      input: mode === "fixture" ? "fixtures.html" : "index.html",
    },
  },
  esbuild: { jsx: "automatic" },
  plugins: [
    {
      name: "brand-favicon",
      transformIndexHtml() {
        return [{ tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: markIconUrl(brand.mark) }, injectTo: "head" }];
      },
    },
    tailwindcss(),
    ...(mode === "fixture"
      ? [
          {
            name: "local-fixture-api",
            configureServer(server: ViteDevServer) {
              server.middlewares.use(fixtureMiddleware());
            },
          },
        ]
      : []),
  ],
}));
