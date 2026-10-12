import { defineConfig } from "vite";
import capnwebValidate from "capnweb-validate/vite";
import { textModules } from "./text-modules.ts";
export default defineConfig({
  plugins: [textModules(), capnwebValidate({ tsconfig: "./tsconfig.worker.json" })],
  build: {
    outDir: "dist", emptyOutDir: false, target: "esnext", minify: false,
    lib: { entry: "src/worker/index.ts", formats: ["es"], fileName: () => "worker.js" },
    rollupOptions: { external: [/^cloudflare:/, /^node:/], output: { inlineDynamicImports: true } },
  },
});
