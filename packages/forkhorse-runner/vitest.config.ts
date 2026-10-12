import { defineConfig } from "vitest/config";

// Pure offline tests: no workerd container binding, Docker, or provider calls.
export default defineConfig({ test: { include: ["__tests__/*.test.ts"], environment: "node" } });
