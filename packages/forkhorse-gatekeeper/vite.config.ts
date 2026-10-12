import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

const brand = JSON.parse(readFileSync(new URL("../../brand.json", import.meta.url), "utf8"));
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
        for (const [name, entry] of Object.entries(bundle)) {
          if (entry.type === "chunk") scripts.push(entry.code);
          else if (name.endsWith(".css")) styles.push(String(entry.source));
          else throw new Error(`Unexpected external sidebar asset: ${name}`);
          delete bundle[name];
        }
        this.emitFile({
          type: "asset",
          fileName:
            mode === "picker"
              ? "picker.html"
              : mode === "configurator"
                ? "configurator.html"
                : "sidebar.html",
          source: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brand.name)}</title><script>document.documentElement.dataset.mode=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.style.colorScheme=document.documentElement.dataset.mode;</script><style>${styles.join("\n").replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="sidebar"></div><script>${scripts.join("\n").replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
        });
      },
    },
  ],
}));
