import { publicEvents } from "./subscriptions";
import { body, HttpError, json } from "./http";
import { branchHead } from "./artifacts";
import type { Env, Project } from "./types";
import type { Actor } from "./workflow";
import type { Fork } from "./workflow-types";

export interface TokenAudit {
  action: "issued" | "revoked";
  repoName: string;
  agent?: string;
  role: "owner" | "agent";
  scope?: "read" | "write";
  expiresAt?: string;
  revoked?: number;
  recordedAt: string;
}

/** Only invoked after authentication, inside the Supervisor's serialization gate. */
export class CallerCredentials {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
  ) {}

  private async fork(project: Project, repoName: string, actor: Actor): Promise<Fork> {
    if (repoName === project.repoName)
      throw new HttpError(403, "Canonical credentials are forbidden.");
    const fork = await this.storage.get<Fork>(`fork:${repoName}`);
    const owner = await this.storage.get<string | null>(`repo:${repoName}`);
    if (!fork || owner === undefined) throw new HttpError(404, "Fork not found.");
    if (
      !owner ||
      fork.repoName !== repoName ||
      fork.agent !== owner ||
      (!actor.owner && actor.agent !== owner)
    )
      throw new HttpError(403, "Caller does not own this registered fork.");
    return fork;
  }

  private async audit(entry: Omit<TokenAudit, "recordedAt">): Promise<void> {
    // Explicit fields only. Provider token objects and plaintext must never enter durable records.
    await this.storage.put(`tokenAudit:${crypto.randomUUID()}`, {
      ...entry,
      recordedAt: new Date().toISOString(),
    } satisfies TokenAudit);
  }

  async route(request: Request, project: Project, actor: Actor): Promise<Response | null> {
    const path = new URL(request.url).pathname.slice(`/projects/${project.id}`.length);
    if (path === "/me" && request.method === "GET") {
      const registered = await this.storage.list<string | null>({ prefix: "repo:" });
      const records = await this.storage.list<Fork>({ prefix: "fork:" });
      const forks = [];
      for (const [key, fork] of records) {
        const owner = registered.get(`repo:${fork.repoName}`);
        if (
          fork.repoName === project.repoName ||
          key !== `fork:${fork.repoName}` ||
          !owner ||
          owner !== fork.agent ||
          (!actor.owner && actor.agent !== owner)
        )
          continue;
        using repo = await this.env.ARTIFACTS.get(fork.repoName);
        const head = await branchHead(repo, project.defaultBranch);
        forks.push({
          ...await publicEvents(this.storage, fork.repoName),
          repoName: fork.repoName,
          remote: fork.remote,
          head,
          createdAt: fork.createdAt,
        });
      }
      return json({
        project: { repoName: project.repoName, ...await publicEvents(this.storage, project.repoName) },
        role: actor.owner ? "owner" : "agent",
        ...(!actor.owner && { agent: actor.agent }),
        forks,
      });
    }
    const issuing = /^\/forks\/([^/]+)\/token$/.exec(path);
    if (issuing && request.method === "POST") {
      if (actor.owner || !actor.agent) throw new HttpError(403, "An agent credential is required.");
      const fork = await this.fork(project, issuing[1]!, actor);
      const data = await body(request);
      if (data.scope !== "read" && data.scope !== "write")
        throw new HttpError(400, "scope must be read or write.");
      const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600)
        throw new HttpError(400, "ttlSeconds must be an integer from 60 to 3600.");
      const pending = `tokenRevocationPending:${fork.repoName}`;
      if (await this.storage.get(pending))
        throw new HttpError(409, "Fork token revocation must finish before issuance.");
      using repo = await this.env.ARTIFACTS.get(fork.repoName);
      const token = await repo.createToken(data.scope, ttl);
      try {
        await this.audit({
          action: "issued",
          repoName: fork.repoName,
          role: "agent",
          agent: actor.agent,
          scope: data.scope,
          expiresAt: token.expiresAt,
        });
      } catch (error) {
        // Never return an unaudited credential. If cleanup fails, fence later issuance until DELETE succeeds.
        try {
          await repo.revokeToken(token.id);
        } catch {
          await this.storage.put(pending, true);
        }
        throw error;
      }
      return json(
        {
          ...await publicEvents(this.storage, fork.repoName),
          repoName: fork.repoName,
          remote: fork.remote,
          token: token.plaintext,
          scope: data.scope,
          expiresAt: token.expiresAt,
        },
        201,
      );
    }
    const revoking = /^\/forks\/([^/]+)\/tokens$/.exec(path);
    if (revoking && request.method === "DELETE") {
      const fork = await this.fork(project, revoking[1]!, actor);
      const pending = `tokenRevocationPending:${fork.repoName}`;
      await this.storage.put(pending, true);
      using repo = await this.env.ARTIFACTS.get(fork.repoName);
      let revoked = 0;
      const seen = new Set<string>();
      // The binding has no cursor. Drain active pages, re-list to confirm completion,
      // and fail closed if a truncated/stale listing cannot demonstrate progress.
      for (let page = 0; page < 100; page++) {
        const listing = await repo.listTokens();
        const active = listing.tokens.filter((token) => token.state === "active");
        if (!active.length) {
          if (listing.total > listing.tokens.length) break;
          await this.storage.transaction(async () => {
            await this.audit({
              action: "revoked",
              repoName: fork.repoName,
              role: actor.owner ? "owner" : "agent",
              ...(!actor.owner && { agent: actor.agent }),
              revoked,
            });
            await this.storage.delete(pending);
          });
          return json({ repoName: fork.repoName, revoked });
        }
        if (active.some((token) => seen.has(token.id))) break;
        for (const token of active) {
          seen.add(token.id);
          if (await repo.revokeToken(token.id)) revoked++;
        }
      }
      throw new HttpError(503, "Revocation is incomplete; retry or ask the owner to inspect it.");
    }
    return null;
  }
}
