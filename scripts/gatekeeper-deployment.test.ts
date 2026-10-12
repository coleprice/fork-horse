import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import { buildCommands, deploymentOrder, generateConfigs, validateConfig } from "./deploy.ts";
import type { BaseConfigs, DeploymentConfig, ProdWranglerConfig } from "./deployment-config.ts";

async function jsonc(path: string): Promise<any> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(new URL(path, import.meta.url), "utf8"), errors,
    { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  return result;
}

async function fixture(): Promise<DeploymentConfig> {
  const config = await jsonc("../deployment.jsonc") as DeploymentConfig;
  config.accountId = "0123456789abcdef0123456789abcdef";
  for (const [key, worker] of Object.entries(config.workers)) worker.name = `fixture-${key.toLowerCase()}`;
  config.workers.router.route = { customDomain: "os.idiot.tax" };
  config.access = { issuer: "https://fixture.cloudflareaccess.com", audience: "fixture", admins: ["owner@idiot.tax"] };
  config.customGatekeeper = { name: "Fixture", message: "Local fixture only" };
  config.forkhorseGatekeeper = { enabled: false, workerName: "fixture-agent-vendor" };
  return config;
}

async function bases(): Promise<BaseConfigs> {
  const paths = {
    router: "cloudflare-os/packages/router", workshop: "cloudflare-os/packages/workshop-backend",
    context: "cloudflare-os/packages/gatekeeper-context", scheduler: "cloudflare-os/packages/gatekeeper-scheduler",
    mcp: "cloudflare-os/packages/gatekeeper-mcp",
    customGatekeeper: "packages/custom-gatekeeper", errorReporter: "packages/error-reporter",
    forkhorseGatekeeper: "packages/forkhorse-gatekeeper",
  };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, dir]) =>
    [key, await jsonc(`../${dir}/wrangler.jsonc`) as ProdWranglerConfig],
  ))) as unknown as BaseConfigs;
}

test("disabled or absent vendor adds no Worker or sample fallback", async () => {
  const config = await fixture();
  const base = await bases();
  for (const value of [config.forkhorseGatekeeper, undefined]) {
    config.forkhorseGatekeeper = value;
    validateConfig(config);
    const generated = generateConfigs(config, base);
    assert.equal(generated.forkhorseGatekeeper, undefined);
    assert.ok(!("customGatekeeper" in generated));
    for (const host of [generated.router, generated.workshop]) {
      assert.ok(!host.services?.some((s) => s.binding === "GATEKEEPER_FORKHORSE"));
      assert.ok(!host.services?.some((s) => s.binding === "GATEKEEPER_CUSTOM"));
    }
    assert.ok(!buildCommands(config).some(({ args }) => args.includes("forkhorse-gatekeeper")));
  }
});

test("enabled vendor is private and bound through distinct HTTP and RPC entrypoints", async () => {
  const config = await fixture();
  config.forkhorseGatekeeper = { enabled: true, workerName: "fixture-agent-vendor" };
  validateConfig(config);
  const base = await bases();
  const before = structuredClone(base);
  const generated = generateConfigs(config, base);
  const worker = generated.forkhorseGatekeeper!;
  assert.equal(worker.name, "fixture-agent-vendor");
  assert.equal(worker.account_id, config.accountId);
  assert.equal(worker.workers_dev, false);
  assert.equal(worker.preview_urls, false);
  assert.equal(worker.routes, undefined);
  for (const key of ["secrets", "services", "artifacts"] as const) {
    assert.equal(worker[key], undefined, `wiring must not add ${key} authority`);
  }
  assert.deepEqual(worker.vars, { BASE_URL: "https://os.idiot.tax/gatekeeper/forkhorse" });
  assert.deepEqual(worker.durable_objects, base.forkhorseGatekeeper!.durable_objects);
  assert.deepEqual(generated.router.services?.filter((s) => s.binding === "GATEKEEPER_FORKHORSE"),
    [{ binding: "GATEKEEPER_FORKHORSE", service: worker.name }]);
  assert.deepEqual(generated.workshop.services?.filter((s) => s.binding === "GATEKEEPER_FORKHORSE"),
    [{ binding: "GATEKEEPER_FORKHORSE", service: worker.name, entrypoint: "GatekeeperVendor" }]);
  for (const host of [generated.router, generated.workshop]) {
    assert.ok(!host.services?.some(s => s.binding === "GATEKEEPER_CUSTOM"));
    assert.equal(host.services?.filter(s => s.binding === "GATEKEEPER_MCP").length, 1);
  }
  assert.deepEqual(deploymentOrder(config), ["errorReporter", "context", "scheduler", "mcp", "forkhorseGatekeeper", "workshop", "router"]);
  assert.ok(!buildCommands(config).some(({ args }) => args.includes("custom-gatekeeper")));
  assert.deepEqual(base, before);
  assert.ok(buildCommands(config).some(({ args }) => args.includes("forkhorse-gatekeeper") && args.includes("--no-cache")));
  delete base.forkhorseGatekeeper;
  assert.throws(() => generateConfigs(config, base), /Missing vendor base/);
});

test("vendor config rejects malformed switches and colliding Worker identities", async () => {
  for (const value of [null, { enabled: "true" }, { enabled: true, workerName: "Bad/name" },
    { enabled: true, workerName: "fixture-router" }, { enabled: true, workerName: "fixture-mcp" }]) {
    const config = await fixture();
    config.forkhorseGatekeeper = value as DeploymentConfig["forkhorseGatekeeper"];
    assert.throws(() => validateConfig(config));
  }
  const config = await fixture();
  config.forkhorseGatekeeper = { enabled: true, workerName: "fixture-core" };
  config.core = {
    enabled: true, workerName: "fixture-core", hostname: "core.idiot.tax", mcpPath: "/mcp", project: "fixture",
    artifactsNamespace: "fixture", oauthKvNamespaceId: null, pushQueue: "fixture-push", deadLetterQueue: "fixture-dlq",
    access: { issuer: "https://fixture.cloudflareaccess.com", audience: "fixture", owners: ["owner@idiot.tax"] },
  };
  assert.throws(() => validateConfig(config), /forkhorseGatekeeper.workerName must be unique/);
});

test("template selects the replacement and legacy sample placeholders grant no authority", async () => {
  const template = await jsonc("../deployment.jsonc");
  assert.equal(template.forkhorseGatekeeper.enabled, true);
  assert.equal(template.workers.customGatekeeper, undefined);
  const config = await fixture();
  config.forkhorseGatekeeper = { enabled: true, workerName: "fixture-agent-vendor" };
  config.workers.customGatekeeper = { name: "<RETIRED_SAMPLE>" };
  config.customGatekeeper = { name: "<RETIRED_NAME>", message: "<RETIRED_MESSAGE>" };
  validateConfig(config);
  const generated = generateConfigs(config, await bases());
  assert.ok(!("customGatekeeper" in generated));
  for (const host of [generated.router, generated.workshop]) {
    assert.equal(host.services?.filter(s => s.binding === "GATEKEEPER_FORKHORSE").length, 1);
    assert.equal(host.services?.filter(s => s.binding === "GATEKEEPER_CUSTOM").length, 0);
  }
});
