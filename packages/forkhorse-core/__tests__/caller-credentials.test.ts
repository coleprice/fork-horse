import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { TokenAudit } from "../src/caller-credentials";
import { BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
function request(id: string, path: string, token: string, method = "GET", data?: unknown) {
  return new Request(`https://api.idiot.tax/projects/${id}${path}`, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}` },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
function api(id: string, path: string, token: string, method = "GET", data?: unknown) {
  return worker.fetch(request(id, path, token, method, data), env);
}
function stub(id: string) {
  return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
}
async function inside<T>(
  id: string,
  fn: (instance: TestSupervisor, storage: DurableObjectStorage) => Promise<T>,
) {
  return runInDurableObject(stub(id), async (instance, state) => {
    if (!(instance instanceof TestSupervisor))
      throw new Error("Expected offline fixture supervisor");
    return fn(instance, state.storage);
  });
}
async function setup() {
  const id = `cred-${crypto.randomUUID().slice(0, 8)}`;
  const created = await worker.fetch(
    new Request("https://api.idiot.tax/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ id, agents: ["alpha", "beta"] }),
    }),
    env,
  );
  expect(created.status).toBe(201);
  const agents = (await created.json<{ agents: { apiToken: string }[] }>()).agents;
  const alpha = agents[0]!.apiToken,
    beta = agents[1]!.apiToken;
  for (const [agent, token] of [
    ["alpha", alpha],
    ["beta", beta],
  ] as const)
    expect((await api(id, "/join", token, "POST", { agent })).status).toBe(201);
  return { id, alpha, beta, a: `${id}--alpha-1`, b: `${id}--beta-1` };
}
function issue(id: string, repo: string, token: string, data: unknown = { scope: "read" }) {
  return api(id, `/forks/${repo}/token`, token, "POST", data);
}
function revoke(id: string, repo: string, token: string) {
  return api(id, `/forks/${repo}/tokens`, token, "DELETE");
}
async function audit(id: string) {
  return inside(id, async (_, storage) => [
    ...(await storage.list<TokenAudit>({ prefix: "tokenAudit:" })).values(),
  ]);
}

describe("caller identity and fork credentials under workerd with offline Artifacts", () => {
  it("derives /me only from credentials, filters registered non-canonical forks and omits tokens", async () => {
    const f = await setup();
    await inside(f.id, async (_, storage) => {
      const fork = await storage.get(`fork:${f.a}`);
      await storage.put(`fork:${f.id}`, { ...fork!, repoName: f.id });
      await storage.put(`fork:orphan`, { ...fork!, repoName: "orphan" });
      await storage.put(`fork:inconsistent`, { ...fork!, repoName: "inconsistent" });
      await storage.put("repo:inconsistent", "beta");
    });
    const agent = await api(f.id, "/me?agent=beta&role=owner", f.alpha);
    expect(agent.status).toBe(200);
    const me = await agent.json<{
      role: string;
      agent: string;
      forks: { repoName: string; head: string; remote: string; createdAt: string }[];
    }>();
    expect(me).toMatchObject({
      role: "agent",
      agent: "alpha",
      forks: [{ repoName: f.a, head: BEFORE }],
    });
    expect(me.forks).toHaveLength(1);
    expect(Object.keys(me.forks[0]!).toSorted()).toEqual(["createdAt", "events", "head", "remote", "repoName"]);
    const owner = await (
      await api(f.id, "/me?agent=alpha", OWNER)
    ).json<{ role: string; agent?: string; forks: { repoName: string }[] }>();
    expect(owner.role).toBe("owner");
    expect(owner.agent).toBeUndefined();
    expect(owner.forks.map((fork) => fork.repoName).toSorted()).toEqual([f.a, f.b]);
    expect(JSON.stringify([me, owner])).not.toContain("scoped-");
    expect((await api(f.id, "/me", "wrong")).status).toBe(403);
    const other = await setup();
    expect((await api(f.id, "/me", other.alpha)).status).toBe(403);
  });
  it("denies foreign, canonical, unknown and owner issuance before contacting Artifacts", async () => {
    const f = await setup();
    await inside(f.id, async (instance) => {
      instance.fixture.calls.length = 0;
    });
    for (const [repo, token, status] of [
      [f.b, f.alpha, 403],
      [f.id, f.alpha, 403],
      ["unknown", f.alpha, 404],
      [f.a, OWNER, 403],
    ] as const)
      expect((await issue(f.id, repo, token, { scope: "write", agent: "beta" })).status).toBe(
        status,
      );
    expect((await revoke(f.id, f.b, f.alpha)).status).toBe(403);
    expect((await revoke(f.id, f.id, OWNER)).status).toBe(403);
    expect((await revoke(f.id, "unknown", OWNER)).status).toBe(404);
    expect(await inside(f.id, async (instance) => instance.fixture.calls.length)).toBe(0);
    for (const action of ["approve", "promote"])
      expect((await api(f.id, `/reviews/unknown/${action}`, f.alpha, "POST", {})).status).toBe(403);
  });
  it("validates TTL/scope, uses 900 seconds by default and writes only metadata to audit", async () => {
    const f = await setup();
    for (const ttlSeconds of [null, 0, 59, 3601, 1.5, "900"])
      expect((await issue(f.id, f.a, f.alpha, { scope: "read", ttlSeconds })).status).toBe(400);
    for (const scope of [undefined, "admin", null])
      expect((await issue(f.id, f.a, f.alpha, { scope })).status).toBe(400);
    for (const data of [
      { scope: "read" },
      { scope: "read", ttlSeconds: 60 },
      { scope: "write", ttlSeconds: 3600 },
    ]) {
      const response = await issue(f.id, f.a, f.alpha, data);
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json<{ token: string; expiresAt: string }>();
      expect(result.token).toContain(`scoped-${f.a}`);
      const records = await audit(f.id);
      expect(
        records.some(
          (entry) =>
            entry.action === "issued" &&
            entry.repoName === f.a &&
            entry.scope === data.scope &&
            entry.expiresAt === result.expiresAt,
        ),
      ).toBe(true);
      const stored = await inside(f.id, async (_, storage) =>
        JSON.stringify([...(await storage.list())]),
      );
      expect(stored).not.toContain(result.token);
      expect(stored).not.toContain('"plaintext"');
      expect(stored).not.toContain('"token"');
    }
    const ttls = await inside(f.id, async (instance) =>
      instance.fixture.calls
        .filter((c) => c.method === "createToken" && c.repo === f.a)
        .map((c) => c.ttl),
    );
    expect(ttls).toEqual([3600, 900, 60, 3600]);
    expect((await audit(f.id)).filter((entry) => entry.action === "issued")).toHaveLength(3);
  });
  it("revokes every active provider page including join tokens, supports owner and idempotent repeat", async () => {
    const f = await setup();
    for (let i = 0; i < 3; i++) expect((await issue(f.id, f.a, f.alpha)).status).toBe(201);
    await inside(f.id, async (instance) => {
      instance.fixture.tokenPageSize = 2;
    });
    const response = await revoke(f.id, f.a, f.alpha);
    expect(await response.json()).toEqual({ repoName: f.a, revoked: 4 });
    expect(await (await revoke(f.id, f.a, OWNER)).json()).toEqual({ repoName: f.a, revoked: 0 });
    expect(
      await inside(
        f.id,
        async (instance) =>
          [...instance.fixture.tokens.get(f.b)!.values()].filter((t) => t.state === "active")
            .length,
      ),
    ).toBe(1);
    expect((await revoke(f.id, f.b, OWNER)).status).toBe(200);
    expect((await issue(f.id, f.a, f.alpha)).status).toBe(201);
  });
  it("keeps failed/stale revocation pending, sanitizes failure and blocks issuance until retry completes", async () => {
    const f = await setup();
    await inside(f.id, async (instance) => {
      instance.fixture.failRevoke = true;
    });
    const failed = await revoke(f.id, f.a, f.alpha);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("fixture-provider-secret");
    expect((await issue(f.id, f.a, f.alpha)).status).toBe(409);
    await inside(f.id, async (instance) => {
      instance.fixture.failRevoke = false;
      instance.fixture.staleTokenListing = true;
    });
    expect((await revoke(f.id, f.a, OWNER)).status).toBe(503);
    await inside(f.id, async (instance) => {
      instance.fixture.staleTokenListing = false;
    });
    expect((await revoke(f.id, f.a, OWNER)).status).toBe(200);
    expect((await issue(f.id, f.a, f.alpha)).status).toBe(201);
  });
  it("serializes issuance and revocation so a concurrent revoke sees the newly minted token", async () => {
    const f = await setup();
    await inside(f.id, async (instance) => {
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      instance.fixture.beforeTokenCreate = async () => {
        started();
        await paused;
      };
      const issuing = instance.fetch(
        request(f.id, `/forks/${f.a}/token`, f.alpha, "POST", { scope: "read" }),
      );
      await entered;
      const revoking = instance.fetch(request(f.id, `/forks/${f.a}/tokens`, f.alpha, "DELETE"));
      await Promise.resolve();
      expect(instance.fixture.calls.some((call) => call.method === "listTokens")).toBe(false);
      release();
      expect((await issuing).status).toBe(201);
      expect(await (await revoking).json()).toEqual({ repoName: f.a, revoked: 2 });
      expect(
        [...instance.fixture.tokens.get(f.a)!.values()].some((token) => token.state === "active"),
      ).toBe(false);
      instance.fixture.beforeTokenCreate = undefined;
    });
  });
  it("returns no unaudited token when durable audit persistence fails", async () => {
    const f = await setup();
    await inside(f.id, async (instance, storage) => {
      const original = storage.put.bind(storage);
      const failure = vi.spyOn(storage, "put").mockImplementation(async (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("tokenAudit:"))
          throw new Error("offline audit failure");
        return (original as (...args: unknown[]) => Promise<void>)(...args);
      });
      try {
        const response = await instance.fetch(
          request(f.id, `/forks/${f.a}/token`, f.alpha, "POST", { scope: "write" }),
        );
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain("scoped-");
        expect(
          [...instance.fixture.tokens.get(f.a)!.values()].filter((t) => t.state === "active"),
        ).toHaveLength(1);
      } finally {
        failure.mockRestore();
      }
    });
  });
});
