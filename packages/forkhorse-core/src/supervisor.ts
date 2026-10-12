import { EventSubscriptions, publicEvents, registerEvents } from "./subscriptions";
import { CallerCredentials } from "./caller-credentials";
import { DurableObject } from "cloudflare:workers";
import { bearerHash, body, digest, equalHash, errorResponse, HttpError, json, operation, slug } from "./http";
import type { ErrorContext } from "./http";
import { changedPaths } from "./trees";
import { branchHead } from "./artifacts";
import type { Activity, Env, Project, PushEvent } from "./types";
import { WorkerGit } from "./git";
import type { GitOperations } from "./git";
import { Workflow, recordWorkflowPush } from "./workflow";

interface Agent {
  name: string;
  tokenHash: string;
}

function publicImportUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new HttpError(400, "sourceUrl must be a public HTTPS Git URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "sourceUrl must be a public HTTPS Git URL.");
  }
  // Import has no credentials or arbitrary headers. Block local names and IP literals;
  // Artifacts performs the actual public remote fetch and refuses private repositories.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":") ||
    /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)
  ) {
    throw new HttpError(
      400,
      "sourceUrl must be a public HTTPS Git URL without credentials or query parameters.",
    );
  }
  return url.href;
}

/** One durable coordinator per project; all operations share the same serialization gate. */
export class Supervisor extends DurableObject<Env> {
  protected gitOperations(): GitOperations {
    return new WorkerGit(this.env.ARTIFACTS);
  }

  private tail: Promise<void> = Promise.resolve();

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private isOwner(hash: string): boolean {
    return equalHash(hash, this.env.OWNER_API_TOKEN_HASH ?? "");
  }

  private async authorize(hash: string): Promise<{ owner: boolean; agent?: string }> {
    if (this.isOwner(hash)) return { owner: true };
    const agents = await this.ctx.storage.list<Agent>({ prefix: "agent:" });
    for (const agent of agents.values()) {
      if (equalHash(hash, agent.tokenHash)) return { owner: false, agent: agent.name };
    }
    throw new HttpError(403, "Token is not authorized for this project.");
  }

  /** Private binding capability. The public Worker verifies Access before invoking this. */
  async ownerRequest(input: {
    url: string;
    method: string;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    const response = await this.dispatch(
      new Request(input.url, {
        method: input.method,
        body: input.body,
        headers: { "content-type": "application/json" },
      }),
      true,
    );
    return { status: response.status, body: await response.text() };
  }

  /** Private MCP authentication seam; an owner credential can never become an agent. */
  async authenticateAgent(token: string): Promise<{ project: string; agent: string } | null> {
    if (!token || token.length > 512) return null;
    return this.exclusive(async () => {
      try {
        const actor = await this.authorize(await digest(token));
        const project = await this.ctx.storage.get<Project>("project");
        return !actor.owner && actor.agent && project
          ? { project: project.id, agent: actor.agent }
          : null;
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return null;
        throw error;
      }
    });
  }

  async alarm(): Promise<void> {
    await this.exclusive(() => new EventSubscriptions(this.ctx.storage, this.env).alarm());
  }

  async fetch(request: Request): Promise<Response> {
    return this.dispatch(request, false);
  }

  private async dispatch(request: Request, trustedOwner: boolean): Promise<Response> {
    return this.exclusive(async () => {
      const diagnostic: ErrorContext = { op: operation(request) };
      try {
        const hash = trustedOwner ? "" : await bearerHash(request);
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/projects") {
          if (!trustedOwner && !this.isOwner(hash))
            throw new HttpError(403, "Only the owner can create projects.");
          return await this.create(await body(request));
        }
        const actor = trustedOwner ? { owner: true } : await this.authorize(hash);
        const project = await this.ctx.storage.get<Project>("project");
        if (!project) throw new HttpError(404, "Project not found.");
        if (url.pathname === `/projects/${project.id}/join` && request.method === "POST") {
          const data = await body(request);
          if (!slug(data.agent, 32))
            throw new HttpError(400, "agent must be a lowercase slug of at most 32 characters.");
          if (!actor.owner && actor.agent !== data.agent)
            throw new HttpError(403, "Token belongs to a different agent.");
          if (!(await this.ctx.storage.get<Agent>(`agent:${data.agent}`)))
            throw new HttpError(403, "Agent is not enrolled.");
          const ttl = data.ttlSeconds ?? 3600;
          if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
            throw new HttpError(400, "ttlSeconds must be an integer from 60 to 3600.");
          }
          return await this.join(project, data.agent, ttl);
        }
        if (url.pathname === `/projects/${project.id}/activity` && request.method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100
          ) {
            throw new HttpError(
              400,
              "after must be a nonnegative integer; limit must be 1 to 100.",
            );
          }
          const entries = await this.ctx.storage.list<Activity>({
            prefix: "activity:",
            startAfter: `activity:${String(after).padStart(16, "0")}`,
            limit,
          });
          const activity = [...entries.values()];
          return json({ activity, nextAfter: activity.at(-1)?.sequence ?? after });
        }
        const credentialResponse = await new CallerCredentials(this.ctx.storage, this.env).route(request, project, actor);
        if (credentialResponse) return credentialResponse;
        const response = await new Workflow(this.ctx.storage, this.env, this.gitOperations(), diagnostic).route(
          request,
          project,
          actor,
        );
        return response ?? json({ error: "Not found." }, 404);
      } catch (error) {
        return errorResponse(error, diagnostic);
      }
    });
  }

  private async create(data: Record<string, unknown>): Promise<Response> {
    if (!slug(data.id))
      throw new HttpError(400, "id must be a lowercase slug of at most 48 characters.");
    if (
      !Array.isArray(data.agents) ||
      data.agents.length < 1 ||
      data.agents.length > 50 ||
      !data.agents.every((agent): agent is string => slug(agent, 32)) ||
      new Set(data.agents).size !== data.agents.length
    ) {
      throw new HttpError(
        400,
        "agents must contain 1 to 50 unique lowercase slugs of at most 32 characters.",
      );
    }
    const sourceUrl = publicImportUrl(data.sourceUrl);
    if (await this.ctx.storage.get("project")) throw new HttpError(409, "Project already exists.");
    // Persist intent before the external create: after an uncertain outcome, never adopt
    // an unrelated existing repo or repeat a possibly successful import automatically.
    if (await this.ctx.storage.get("creationPending"))
      throw new HttpError(409, "Creation needs owner inspection before retry.");
    await this.ctx.storage.put("creationPending", true);
    const created = sourceUrl
      ? await this.env.ARTIFACTS.import({ source: { url: sourceUrl }, target: { name: data.id } })
      : await this.env.ARTIFACTS.create(data.id, { setDefaultBranch: "main" });
    using canonical = await this.env.ARTIFACTS.get(created.name);
    // create/import necessarily mints an initial provider token. Revoke it immediately;
    // no canonical write credential is persisted or included in an HTTP response.
    await canonical.revokeToken(created.token);
    const project: Project = {
      id: data.id,
      namespace: this.env.ARTIFACTS_NAMESPACE,
      repoName: created.name,
      remote: created.remote,
      defaultBranch: created.defaultBranch,
    };
    const credentials: { agent: string; apiToken: string }[] = [];
    const records: Record<string, Project | Agent | null> = {
      project,
      [`repo:${created.name}`]: null,
    };
    for (const name of data.agents) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const apiToken =
        "api_" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      records[`agent:${name}`] = { name, tokenHash: await digest(apiToken) };
      credentials.push({ agent: name, apiToken });
    }
    const canonicalHead = await branchHead(canonical, project.defaultBranch);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(records);
      await registerEvents(txn, project.namespace, project.repoName);
      await txn.put("canonicalHead", canonicalHead);
      await txn.delete("creationPending");
    });
    await new EventSubscriptions(this.ctx.storage, this.env).attempt(project.repoName);
    return json({ project: { ...project, ...await publicEvents(this.ctx.storage, project.repoName) }, agents: credentials }, 201);
  }

  private async join(project: Project, agent: string, ttl: number): Promise<Response> {
    const counterKey = `forkCounter:${agent}`;
    const number = ((await this.ctx.storage.get<number>(counterKey)) ?? 0) + 1;
    // Reserve names before remote I/O. Failed attempts leave gaps, never reuse forks.
    await this.ctx.storage.put(counterKey, number);
    const name = `${project.id}--${agent}-${number}`;
    using canonical = await this.env.ARTIFACTS.get(project.repoName);
    const fork = await canonical.fork(name);
    using repo = await this.env.ARTIFACTS.get(fork.name);
    await repo.revokeToken(fork.token);
    const token = await repo.createToken("write", ttl);
    try {
      await this.ctx.storage.transaction(async (txn) => {
        await registerEvents(txn, project.namespace, fork.name);
        await txn.put({
        [`repo:${fork.name}`]: agent,
        [`fork:${fork.name}`]: {
          repoName: fork.name,
          agent,
          remote: fork.remote,
          createdAt: new Date().toISOString(),
        },
        [`latestFork:${agent}`]: fork.name,
        });
      });
    } catch (error) {
      await repo.revokeToken(token.id);
      throw error;
    }
    await new EventSubscriptions(this.ctx.storage, this.env).attempt(fork.name);
    return json(
      {
        ...await publicEvents(this.ctx.storage, fork.name),
        project: project.id,
        agent,
        repoName: fork.name,
        remote: fork.remote,
        token: token.plaintext,
        scope: token.scope,
        expiresAt: token.expiresAt,
        ttlSeconds: ttl,
      },
      201,
    );
  }

  /** Called by the Queue consumer through a DO capability, never an HTTP endpoint. */
  async recordPush(event: PushEvent): Promise<boolean> {
    try {
      await this.exclusive(async () => {
        const project = await this.ctx.storage.get<Project>("project");
        if (!project || event.source.namespace !== project.namespace) return;
        const agent = await this.ctx.storage.get<string | null>(`repo:${event.source.repoName}`);
        if (agent === undefined) return; // Naming alone is never repository membership.
        const key =
          "seen:" +
          (await digest(
            JSON.stringify([
              event.source.namespace,
              event.source.repoName,
              event.payload.ref,
              event.payload.after,
              // Canonical ABA moves must not collapse into a previously seen head.
              ...(agent === null ? [event.payload.before, event.metadata.eventTimestamp] : []),
            ]),
          ));
        if (await this.ctx.storage.get(key)) return;
        using repo = await this.env.ARTIFACTS.get(event.source.repoName);
        const paths = await changedPaths(repo, event.payload.before, event.payload.after);
        await this.ctx.storage.transaction(async (txn) => {
          const sequence = ((await txn.get<number>("sequence")) ?? 0) + 1;
          const entry: Activity = {
            sequence,
            namespace: event.source.namespace,
            repoName: event.source.repoName,
            agent,
            ...event.payload,
            changedPaths: paths,
            eventTimestamp: event.metadata.eventTimestamp,
            recordedAt: new Date().toISOString(),
          };
          await recordWorkflowPush(txn, project, event, entry);
          await txn.put({
            [key]: true,
            sequence,
            [`activity:${String(sequence).padStart(16, "0")}`]: entry,
          });
        });
      });
      return true;
    } catch {
      // A false result asks the consumer to retry without allowing provider error
      // text to escape over RPC into automatic exception logs.
      return false;
    }
  }
}
