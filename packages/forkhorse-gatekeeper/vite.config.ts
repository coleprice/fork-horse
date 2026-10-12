import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

const brand = JSON.parse(readFileSync(new URL("../../brand.json", import.meta.url), "utf8"));
const escape = (text: string) => text.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** A network-free iframe file. Fixture host/data are separate and never in this build graph. */
export default defineConfig(({ mode }) => ({
  resolve: { dedupe: ["capnweb"] },
  build: {
    outDir: "dist",
    emptyOutDir: mode !== "configurator",
    lib: { entry: mode === "configurator" ? "app/configurator.ts" : "app/main.ts", name: "SidebarApp", formats: ["iife"] },
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  plugins: [{
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
        fileName: mode === "configurator" ? "configurator.html" : "sidebar.html",
        source: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brand.name)}</title><style>${styles.join("\n").replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="sidebar"></div><script>${scripts.join("\n").replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
      });
    },
  }],
}));
