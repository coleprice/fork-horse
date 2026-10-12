import type { BaseConfigs, DeploymentConfig, ProdWranglerConfig } from "./deployment-config.ts";

/** Optional public core; owner values belong only in deployment.local.jsonc. */
export interface CoreDeployment {
  enabled: boolean;
  workerName: string;
  hostname: string;
  mcpPath: string;
  project: string;
  artifactsNamespace: string;
  oauthKvNamespaceId: string | null;
  pushQueue: string;
  deadLetterQueue: string;
  access: { issuer: string; audience: string; owners: string[] };
}

export function validateCore(config: DeploymentConfig): void {
  const core = config.core;
  if (core === undefined) return;
  if (!core || typeof core.enabled !== "boolean")
    throw new Error("core.enabled must be a boolean.");
  if (!core.enabled) return;
  const name = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    ![core.workerName, core.pushQueue, core.deadLetterQueue].every(
      (value) => typeof value === "string" && name.test(value),
    )
  )
    throw new Error("core Worker and Queue names must use lowercase letters, numbers and hyphens.");
  if (
    Object.entries(config.workers).some(
      ([key, worker]) =>
        (key !== "errorReporter" || config.errorReporting.enabled) &&
        worker.name === core.workerName,
    )
  )
    throw new Error("core.workerName must be unique.");
  if (core.pushQueue === core.deadLetterQueue)
    throw new Error("core Queue and dead-letter Queue must differ.");
  if (
    typeof core.hostname !== "string" ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      core.hostname,
    ) ||
    core.hostname ===
      new URL(config.publicBaseUrl ?? `https://${config.workers.router.route.customDomain}`)
        .hostname
  )
    throw new Error(
      "core.hostname must be a lowercase custom hostname distinct from the OS router.",
    );
  if (
    typeof core.mcpPath !== "string" ||
    !/^\/[a-z0-9-]+$/.test(core.mcpPath) ||
    ["/app", "/projects", "/authorize", "/oauth"].includes(core.mcpPath)
  )
    throw new Error(
      "core.mcpPath must be one path segment, separate from app, projects and OAuth.",
    );
  if (
    typeof core.project !== "string" ||
    core.project.length > 48 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(core.project)
  )
    throw new Error("core.project must be a lowercase project slug of at most 48 characters.");
  if (
    typeof core.artifactsNamespace !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(core.artifactsNamespace)
  )
    throw new Error("core.artifactsNamespace must be a valid namespace.");
  if (
    core.oauthKvNamespaceId !== null &&
    (typeof core.oauthKvNamespaceId !== "string" ||
      !/^[a-f0-9]{32}$/i.test(core.oauthKvNamespaceId))
  )
    throw new Error("core.oauthKvNamespaceId must be null or a 32-hex namespace ID.");
  if (
    !core.access ||
    typeof core.access.issuer !== "string" ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(core.access.issuer) ||
    typeof core.access.audience !== "string" ||
    !core.access.audience ||
    core.access.audience.trim() !== core.access.audience ||
    !Array.isArray(core.access.owners) ||
    !core.access.owners.length ||
    !core.access.owners.every(
      (email) => typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email),
    )
  )
    throw new Error(
      "core.access requires an Access team issuer, application audience and owner emails.",
    );
}

export function coreConfig(
  config: DeploymentConfig,
  bases: BaseConfigs,
): ProdWranglerConfig | undefined {
  if (!config.core?.enabled) return undefined;
  if (!bases.core) throw new Error("Missing core base Wrangler config.");
  const core = config.core;
  return {
    ...structuredClone(bases.core),
    account_id: config.accountId,
    name: core.workerName,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: core.hostname, custom_domain: true }],
    vars: {
      ARTIFACTS_NAMESPACE: core.artifactsNamespace,
      CORE_PUBLIC_ORIGIN: `https://${core.hostname}`,
      MCP_PATH: core.mcpPath,
      MCP_PROJECT: core.project,
      CORE_ACCESS_ISSUER: core.access.issuer,
      CORE_ACCESS_AUDIENCE: core.access.audience,
      CORE_ACCESS_OWNERS: core.access.owners,
    },
    artifacts: [{ binding: "ARTIFACTS", namespace: core.artifactsNamespace }],
    kv_namespaces: [
      { binding: "OAUTH_KV", ...(core.oauthKvNamespaceId ? { id: core.oauthKvNamespaceId } : {}) },
    ],
    secrets: { required: ["OWNER_API_TOKEN_HASH"] },
    assets: {
      directory: "../forkhorse-dashboard/dist",
      binding: "ASSETS",
      run_worker_first: true,
      html_handling: "none",
      not_found_handling: "none",
    },
    queues: {
      consumers: [
        {
          queue: core.pushQueue,
          dead_letter_queue: core.deadLetterQueue,
          max_retries: 5,
          max_batch_size: 10,
        },
      ],
    },
  };
}
