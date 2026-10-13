import { createCoreClient } from "../src/core";
import type { AgentIdentity, ClaimBinding, CoreClient } from "../src/core";

/** In-process, labeled FH-003/FH-005 fixture. It performs no provider calls. */
export class FixtureCore {
  tokens = new Map<string, AgentIdentity>([
    ["api_fixture_builder", { project: "demo", agent: "builder" }],
  ]);
  claims: ClaimBinding[] = [{ packet: "FH-004", agent: "builder", repoName: "demo--builder-1" }];
  work: unknown[] = [];
  requests: Pick<Request, "url" | "method" | "headers" | "json">[] = [];
  enrollments = 0;
  forks = 1;
  failure: number | undefined;
  payload: unknown;
  client: CoreClient = createCoreClient({
    authenticate: async (token) => this.tokens.get(token) ?? null,
    enrollAgent: async (_owner, project, agent) => {
      this.enrollments++;
      const apiToken = `api_fixture_oauth_${this.enrollments}`;
      this.tokens.set(apiToken, { project, agent });
      return { apiToken, project, agent };
    },
    fetch: async (request) => {
      this.requests.push(request.clone());
      if (this.failure)
        return Response.json(
          { secret: "provider_fixture_exception_do_not_echo" },
          { status: this.failure },
        );
      if (this.payload !== undefined) return Response.json(this.payload);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/me")) return Response.json({ work: this.work });
      if (path.endsWith("/state")) return Response.json({ claims: this.claims, fixture: true });
      if (path.endsWith("/join"))
        return Response.json({ repoName: `demo--builder-${++this.forks}`, fixture: true });
      if (path.endsWith("/claim")) {
        const input = (await request.json()) as { repoName?: string };
        const binding = {
          packet: "FH-004",
          agent: "builder",
          repoName: input.repoName ?? `demo--builder-${this.forks}`,
        };
        this.claims = [binding];
        return Response.json(binding);
      }
      return Response.json({ fixture: true, sha: "a".repeat(40) });
    },
  });
}

/** Minimal in-memory KV semantics used by the real OAuth library in these Node tests. */
export function fixtureKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string | { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return (typeof type === "string" ? type : type?.type) === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string }) {
      return {
        keys: [...values.keys()]
          .filter((key) => key.startsWith(options?.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
  } as unknown as KVNamespace;
}
export function fixtureContext(): ExecutionContext {
  return { props: {}, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}
