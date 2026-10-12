import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

// Node strips TypeScript but cannot parse JSX. This hook is confined to DOM fixture tests;
// Workers still use the actual workerd suite, with FH-008b's real asset build prerequisite.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: transformSync(readFileSync(new URL(url), "utf8"), { loader: "tsx", jsx: "automatic" })
        .code,
    };
  },
});
