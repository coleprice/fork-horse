import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import { textModules } from "./text-modules.ts";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
const port = process.env.FH_LOCAL_FIXTURE_PORT;
if (!port || !/^\d+$/.test(port)) throw new Error("Use test/local/run.ts to start the offline Git fixture.");
export default defineConfig({
  resolve: { dedupe: ["capnweb"], alias: { "@gadgets/typed-storage": resolve("../../cloudflare-os/packages/typed-storage/src/index.ts") } },
  plugins: [{ name: "local-generated-output", enforce: "pre", resolveId(source) {
    if (source.startsWith("./generated/")) return "\0local-generated:" + basename(source);
  }, load(id) {
    if (id.startsWith("\0local-generated:")) {
      const name = id.slice(17), content = readFileSync(resolve(process.env.FH_LOCAL_GENERATED_DIR!, name), "utf8");
      return name.endsWith(".txt") ? `export default ${JSON.stringify(content)}` : content;
    }
  } }, textModules(), capnwebValidate({ tsconfig: "./tsconfig.local.json" }), cloudflareTest({
    main: "./test/local/worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["experimental", "nodejs_compat", "allow_irrevocable_stub_storage"],
      bindings: { BASE_URL: "https://os.fixture.idiot.tax/gatekeeper/forkhorse", PUBLIC_BASE_URL: "https://os.fixture.idiot.tax/" },
      workerLoaders: { LOADER: {} },
      durableObjects: {
        TEST_OVERSEER: { className: "OverseerDurableObject", useSQLite: true },
        WORKSPACES: { className: "FixtureWorkspace", useSQLite: true },
        ACCOUNTS: { className: "UserAccount", useSQLite: true }, FORKS: { className: "ForkGatekeeper", useSQLite: true },
      },
      serviceBindings: {
        FIXTURE: { name: kCurrentWorker, entrypoint: "FixtureHarness" }, VENDOR_HTTP: kCurrentWorker,
        LOCAL_GIT: async (request) => {
          const url = new URL(request.url);
          return fetch(`http://127.0.0.1:${port}${url.pathname}`, { method: request.method,
            headers: request.headers, body: request.body, duplex: "half" } as RequestInit);
        },
      },
    },
  })],
  test: { include: ["test/local/*.test.ts"], setupFiles: ["../../cloudflare-os/scripts/assert-workerd.ts"], testTimeout: 30000 },
});
