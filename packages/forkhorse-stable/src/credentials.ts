import { isHttpsOrigin, isProjectSlug } from "./address.ts";

/** Trusted HTTP destination, supplied by the adapter rather than model input. */
export interface CredentialCall {
  origin: string;
  project: string;
}

export type BearerAuthorization = `Bearer ${string}`;

/** Server-only capability. Never expose this interface through RPC/MCP or a UI. */
export interface CredentialProvider {
  /** Use the result only in the HTTP Authorization header for this call. */
  getBearer(call: CredentialCall): Promise<BearerAuthorization>;
}

/** Same fields as the existing gatekeeper ConnectionDraft; never a public record. */
export interface StoredAgentCredentials {
  coreOrigin: string;
  project: string;
  agentCredential: string;
}

export type ReadStoredAgentCredentials = () =>
  StoredAgentCredentials | null | undefined |
  Promise<StoredAgentCredentials | null | undefined>;

/**
 * v0 adapter for the connected account's stored key. Reads on every call so a
 * rotation or removed connection is observed; construction does no storage I/O.
 * The HTTP layer must still guard revocation across queued/in-flight operations.
 */
export function storedAgentKeyProvider(read: ReadStoredAgentCredentials): CredentialProvider {
  return Object.freeze({
    async getBearer(call: CredentialCall): Promise<BearerAuthorization> {
      try {
        const { origin, project } = call;
        if (!isHttpsOrigin(origin) || !isProjectSlug(project)) throw new Error();
        const stored = await read();
        if (!stored || stored.coreOrigin !== origin || stored.project !== project ||
            typeof stored.agentCredential !== "string" ||
            !/^[A-Za-z0-9_-]{16,256}$/.test(stored.agentCredential) ||
            /[^A-Za-z0-9_-]/.test(stored.agentCredential)) throw new Error();
        return `Bearer ${stored.agentCredential}`;
      } catch {
        // Storage exceptions can contain keys. Never log, attach a cause, or echo
        // caller values. Key material is returned only to the trusted HTTP layer.
        throw new Error("Agent authorization unavailable.");
      }
    },
  });
}
