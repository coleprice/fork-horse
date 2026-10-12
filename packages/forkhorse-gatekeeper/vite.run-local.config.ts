import { defineConfig } from "vite";
import workerConfig from "./vite.worker.config.ts";
// A visibly separate output: deployment tooling only consumes dist/worker.js.
export default defineConfig({ ...workerConfig,
  build: { ...workerConfig.build, lib: { entry: "test/local/offline-worker.ts", formats: ["es"], fileName: () => "offline-worker.js" } },
});
