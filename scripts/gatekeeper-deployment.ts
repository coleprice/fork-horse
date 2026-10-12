import type { DeploymentConfig } from "./deployment-config.ts";

/** Optional private vendor. This switch wires the Worker; it does not enable accounts. */
export interface ForkhorseGatekeeperDeployment {
  enabled: boolean;
  workerName: string;
}

export function validateForkhorseGatekeeper(config: DeploymentConfig): void {
  const gatekeeper = config.forkhorseGatekeeper;
  if (gatekeeper === undefined) return;
  if (!gatekeeper || typeof gatekeeper.enabled !== "boolean") {
    throw new Error("forkhorseGatekeeper.enabled must be a boolean.");
  }
  if (!gatekeeper.enabled) return;
  if (typeof gatekeeper.workerName !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(gatekeeper.workerName)) {
    throw new Error("forkhorseGatekeeper.workerName must use lowercase letters, numbers and hyphens.");
  }
  const names = Object.entries(config.workers)
    .filter(([key]) => key !== "customGatekeeper")
    .filter(([key]) => key !== "errorReporter" || config.errorReporting.enabled)
    .map(([, worker]) => worker.name);
  if (config.core?.enabled) names.push(config.core.workerName);
  if (names.includes(gatekeeper.workerName)) {
    throw new Error("forkhorseGatekeeper.workerName must be unique.");
  }
}
