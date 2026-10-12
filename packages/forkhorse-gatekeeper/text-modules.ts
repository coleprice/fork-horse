import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** The Worker embeds built frames and self-contained API types as text, matching Wrangler. */
export function textModules(): Plugin {
  return {
    name: "worker-text-modules", enforce: "pre",
    resolveId(source, importer) {
      if (importer && /\.(html|txt)$/.test(source)) return `\0worker-text:${resolve(dirname(importer), source)}?module`;
    },
    load(id) {
      if (id.startsWith("\0worker-text:")) {
        return `export default ${JSON.stringify(readFileSync(id.slice(13, -7), "utf8"))};`;
      }
    },
  };
}
