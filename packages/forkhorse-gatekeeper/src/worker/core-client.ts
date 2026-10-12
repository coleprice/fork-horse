import { readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { checkConnectionDraft, type ConnectionDraft } from "../configuration.ts";
import type { ProjectState } from "../../../forkhorse-dashboard/src/contracts.ts";
import { stateView } from "../../../forkhorse-dashboard/src/model.ts";

export interface AgentFork { repoName: string; remote: string; head: string; createdAt: string }
export interface AgentIdentity { role: "agent"; agent: string; forks: AgentFork[] }
export const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function publicUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid Git remote.");
  const url = new URL(value);
  checkConnectionDraft({ coreOrigin: url.origin, project: "validation", agentCredential: "fixture-validation-only" });
  if (url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
    throw new Error("Invalid Git remote.");
  }
  return url.href.replace(/\/$/, "");
}

/** Server-only client. Neither the enrolled credential nor minted tokens are returned by an RPC. */
export class CoreClient {
  constructor(private readonly draft: ConnectionDraft, private readonly expectedAgent?: string,
      private readonly guard: () => void = () => {}) {
    const checked = checkConnectionDraft(draft);
    this.draft = { ...draft, coreOrigin: checked.coreOrigin };
  }

  async #json(path: string, init: RequestInit = {}): Promise<any> {
    this.guard();
    let response: Response;
    try {
      response = await fetch(`${this.draft.coreOrigin}/projects/${this.draft.project}${path}`, {
        ...init, redirect: "manual", signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.draft.agentCredential}`, "content-type": "application/json" },
      });
    } catch { throw new Error("Core request unavailable."); }
    this.guard();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403 ? "Agent authorization unavailable." : "Core request failed.");
    }
    try {
      const value = JSON.parse(new TextDecoder().decode(await readBytesCapped(response, 2 << 20)));
      this.guard();
      return value;
    }
    catch { throw new Error("Invalid core response."); }
  }

  async identity(): Promise<AgentIdentity> {
    const me = await this.#json("/me");
    if (me.role !== "agent" || typeof me.agent !== "string" || !me.agent ||
        (this.expectedAgent && me.agent !== this.expectedAgent) || !Array.isArray(me.forks)) {
      throw new Error("An enrolled agent credential is required.");
    }
    const names = new Set<string>();
    const forks = me.forks.map((fork: AgentFork) => {
      if (typeof fork.repoName !== "string" || !/^[a-zA-Z0-9._-]{1,255}$/.test(fork.repoName) ||
          names.has(fork.repoName) || !oid(fork.head) || typeof fork.createdAt !== "string") {
        throw new Error("Invalid fork discovery response.");
      }
      names.add(fork.repoName);
      return { repoName: fork.repoName, remote: publicUrl(fork.remote), head: fork.head, createdAt: fork.createdAt };
    });
    return { role: "agent", agent: me.agent, forks };
  }

  async fork(repoName: string): Promise<AgentFork> {
    const fork = (await this.identity()).forks.find((f) => f.repoName === repoName);
    if (!fork) throw new Error("The connected agent does not own this fork.");
    return fork;
  }

  async state(): Promise<ProjectState> {
    await this.identity();
    const state = stateView(await this.#json("/state"));
    if (state.project.id !== this.draft.project) throw new Error("Unexpected project response.");
    return state;
  }

  async git(repoName: string, service: "upload-pack" | "receive-pack", body: BodyInit): Promise<Response> {
    const fork = await this.fork(repoName);
    const scope = service === "upload-pack" ? "read" : "write";
    const grant = await this.#json(`/forks/${encodeURIComponent(repoName)}/token`, {
      method: "POST", body: JSON.stringify({ scope, ttlSeconds: 60 }),
    });
    if (grant.repoName !== repoName || publicUrl(grant.remote) !== fork.remote || grant.scope !== scope ||
        typeof grant.token !== "string" || !grant.token || grant.token.length > 4096 ||
        !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() ||
        Date.parse(grant.expiresAt) > Date.now() + 90_000) {
      throw new Error("Invalid fork credential response.");
    }
    // Artifacts tokens append expiry metadata; the Basic password is the credential portion.
    const password = grant.token.split("?expires=")[0];
    this.guard();
    let response: Response;
    try {
      response = await fetch(`${fork.remote}/git-${service}`, {
        method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(30000),
        headers: {
          authorization: `Basic ${btoa(`x:${password}`)}`,
          "User-Agent": "git/2.0 (gatekeeper)",
          "content-type": `application/x-git-${service}-request`,
          accept: `application/x-git-${service}-result`,
          ...(service === "upload-pack" ? { "Git-Protocol": "version=2" } : {}),
        },
      });
    } catch { throw new Error("Git transport unavailable."); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Git transport refused."); }
    return response;
  }
}
