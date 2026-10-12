import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { textModules } from "./text-modules.ts";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [textModules(), capnwebValidate({ tsconfig: "./tsconfig.worker.json" }), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
      bindings: { BASE_URL: "https://os.fixture.idiot.tax/gatekeeper/forkhorse" },
      durableObjects: { WORKSPACES: { className: "FixtureWorkspace", useSQLite: true }, ACCOUNTS: { className: "UserAccount", useSQLite: true }, FORKS: { className: "ForkGatekeeper", useSQLite: true } },
      serviceBindings: {
        FIXTURE: { name: kCurrentWorker, entrypoint: "FixtureHarness" },
        VENDOR: { name: kCurrentWorker, entrypoint: "GatekeeperVendor" },
        VENDOR_HTTP: kCurrentWorker,
        CONNECT_CALLBACK: { name: kCurrentWorker, entrypoint: "FixtureConnectCallback" },
      },
    },
  })],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../cloudflare-os/scripts/assert-workerd.ts"],
  },
});
