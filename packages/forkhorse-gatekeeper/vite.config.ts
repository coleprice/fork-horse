import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { markIconUrl } from "../forkhorse-dashboard/src/mark.ts";

const brand = JSON.parse(readFileSync(new URL("../../brand.json", import.meta.url), "utf8"));
const vars = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

/** A network-free iframe file. Fixture host/data are separate and never in this build graph. */
export default defineConfig(({ mode }) => ({
  // Library builds retain this React switch by default; the iframe has no Node globals.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { dedupe: ["capnweb"] },
  build: {
    outDir: "dist",
    emptyOutDir: mode !== "configurator" && mode !== "picker",
    lib: {
      entry:
        mode === "picker"
          ? "app/picker.ts"
          : mode === "configurator"
            ? "app/configurator.ts"
            : "app/main.ts",
      name: "SidebarApp",
      formats: ["iife"],
    },
    cssCodeSplit: false,
    rollupOptions: {
      onwarn(warning, warn) {
        // Kumo is client-only here; Rollup may safely remove its React server directive.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes("use client"))
          return;
        warn(warning);
      },
      output: { inlineDynamicImports: true },
    },
  },
  esbuild: { jsx: "automatic" },
  plugins: [
    tailwindcss(),
    {
      name: "sidebar-single-file",
      enforce: "post",
      generateBundle(_options, bundle) {
        const scripts: string[] = [];
        const styles: string[] = [];
        // Seed reviewed host variables before any JS mounts or host theme arrives.
        const tokens = JSON.parse(
          readFileSync(
            new URL("../forkhorse-dashboard/src/host-tokens.json", import.meta.url),
            "utf8",
          ),
        );
        for (const [name, entry] of Object.entries(bundle)) {
          if (entry.type === "chunk") scripts.push(entry.code);
          else if (name.endsWith(".css")) styles.push(String(entry.source));
          else throw new Error(`Unexpected external sidebar asset: ${name}`);
          delete bundle[name];
        }
        // Host variables follow Kumo CSS, matching the palette applied after mount.
        styles.push(
          `:root{${vars({ ...tokens.shared, ...tokens.light })}}[data-mode="dark"]{${vars(tokens.dark)}}`,
        );
        styles.push(
          `.loading-panel{display:none}@media(min-width:1280px){.loading-panel{display:block;flex:0 0 var(--layout-activity-panel)}}.loading-caption{margin:0}`,
        );
        this.emitFile({
          type: "asset",
          fileName:
            mode === "picker"
              ? "picker.html"
              : mode === "configurator"
                ? "configurator.html"
                : "sidebar.html",
          source: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brand.name)}</title><link rel="icon" type="image/svg+xml" href="${markIconUrl(brand.mark)}"><script>document.documentElement.dataset.mode=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.style.colorScheme=document.documentElement.dataset.mode;</script><style>${styles.join("\n").replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="sidebar">${mode === "picker" || mode === "configurator" ? "" : `<div class="app-shell"><main class="main-pane"><div class="main-container"><header class="page-header"><p role="status" class="caption muted loading-caption">Loading ${escape(brand.slug)}…</p></header></div></main><div class="loading-panel" aria-hidden="true"></div></div>`}</div><script>${scripts.join("\n").replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
        });
      },
    },
  ],
}));
