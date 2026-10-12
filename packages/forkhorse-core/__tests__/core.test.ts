import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { digest } from "../src/http";
import { ZERO_SHA } from "../src/trees";
import type { Activity, Env as CoreEnv, Project, PushEvent } from "../src/types";
import { AFTER, BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends CoreEnv {}
  }
}

const OWNER = "offline-fixture-owner-token";
let count = 0;
function projectId(): string {
  return `test-${++count}-${crypto.randomUUID().slice(0, 8)}`;
}
function api(path: string, token: string | null = OWNER, data?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.idiot.tax${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: token
        ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
        : {},
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    env,
  );
}
interface Created {
  project: Project;
  agents: { agent: string; apiToken: string }[];
}
async function create(id = projectId()): Promise<Created> {
  const response = await api("/projects", OWNER, { id, agents: ["alpha", "beta"] });
  expect(response.status).toBe(201);
  return response.json<Created>();
}
function supervisor(id: string) {
  return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
}
async function inspect(id: string) {
  return runInDurableObject(supervisor(id), async (instance, state) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected test supervisor");
    return { calls: instance.fixture.calls, storage: [...(await state.storage.list()).entries()] };
  });
}
function event(repoName: string, overrides: Partial<PushEvent["payload"]> = {}): PushEvent {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { namespace: "fixture", repoName },
    payload: { ref: "refs/heads/main", before: BEFORE, after: AFTER, ...overrides },
    metadata: { eventTimestamp: "2026-10-11T12:00:00.000Z" },
  };
}
async function consume(events: unknown[]) {
  const batch = createMessageBatch(
    "fixture-pushes",
    events.map((body, i) => ({
      id: `message-${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}
async function activity(id: string, token = OWNER): Promise<Activity[]> {
  const response = await api(`/projects/${id}/activity`, token);
  expect(response.status).toBe(200);
  return (await response.json<{ activity: Activity[] }>()).activity;
}

describe("core Worker and real supervisor Durable Objects with offline Artifacts fixtures", () => {
  it("runs in workerd", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("creates canonical, returns agent credentials once, and persists only their hashes", async () => {
    const created = await create();
    expect(created.project.repoName).toBe(created.project.id);
    expect(JSON.stringify(created)).not.toContain("initial-");
    const stored = await inspect(created.project.id);
    expect(stored.calls).toContainEqual({ method: "revokeToken", repo: created.project.id });
    expect(stored.calls.some((call) => call.method === "createToken")).toBe(false);
    for (const agent of created.agents) {
      expect(JSON.stringify(stored.storage)).not.toContain(agent.apiToken);
      expect(stored.storage).toContainEqual([
        `agent:${agent.agent}`,
        { name: agent.agent, tokenHash: await digest(agent.apiToken) },
      ]);
    }
    const duplicate = await api("/projects", OWNER, { id: created.project.id, agents: ["alpha"] });
    expect(duplicate.status).toBe(409);
  });

  it("imports a public HTTPS source through the binding", async () => {
    const id = projectId();
    const response = await api("/projects", OWNER, {
      id,
      agents: ["alpha"],
      sourceUrl: "https://git.idiot.tax/public/repo.git",
    });
    expect(response.status).toBe(201);
    expect((await inspect(id)).calls).toContainEqual({
      method: "import",
      repo: id,
      sourceUrl: "https://git.idiot.tax/public/repo.git",
    });
  });

  it("rejects unsafe imports and reserved project delimiters before Artifacts", async () => {
    for (const sourceUrl of [
      "http://git.idiot.tax/repo.git",
      "https://user:pass@git.idiot.tax/repo.git",
      "https://127.0.0.1/repo.git",
      "https://localhost/repo.git",
      "https://git.idiot.tax/repo?token=bad",
    ]) {
      const id = projectId();
      expect((await api("/projects", OWNER, { id, agents: ["alpha"], sourceUrl })).status).toBe(
        400,
      );
      expect((await inspect(id)).calls).toEqual([]);
    }
    expect((await api("/projects", OWNER, { id: "bad--id", agents: ["alpha"] })).status).toBe(400);
  });

  it("returns only fork-scoped write tokens with a one-hour default and unique concurrent names", async () => {
    const created = await create();
    const id = created.project.id;
    const token = created.agents[0]!.apiToken;
    const responses = await Promise.all([
      api(`/projects/${id}/join`, token, { agent: "alpha" }),
      api(`/projects/${id}/join`, token, { agent: "alpha", ttlSeconds: 600 }),
    ]);
    const forks = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(201);
        return response.json<{
          repoName: string;
          token: string;
          scope: string;
          ttlSeconds: number;
        }>();
      }),
    );
    expect(forks.map((fork) => fork.repoName).toSorted()).toEqual([
      `${id}--alpha-1`,
      `${id}--alpha-2`,
    ]);
    for (const fork of forks) {
      expect(fork.token).toBe(`scoped-${fork.repoName}`);
      expect(fork.scope).toBe("write");
    }
    expect(forks.map((fork) => fork.ttlSeconds).toSorted()).toEqual([3600, 600]);
    const minted = (await inspect(id)).calls.filter((call) => call.method === "createToken");
    expect(
      minted.every((call) => call.repo.startsWith(`${id}--alpha-`) && call.scope === "write"),
    ).toBe(true);
    expect(
      (await api(`/projects/${id}/join`, token, { agent: "alpha", ttlSeconds: 3601 })).status,
    ).toBe(400);
  });

  it("rejects missing, wrong, cross-project and wrong-agent credentials without minting", async () => {
    const id = projectId();
    expect((await api("/projects", null, { id, agents: ["alpha"] })).status).toBe(401);
    expect((await api("/projects", "wrong", { id, agents: ["alpha"] })).status).toBe(403);
    expect((await inspect(id)).calls).toEqual([]);
    const a = await create();
    const b = await create();
    const token = a.agents[0]!.apiToken;
    expect((await api(`/projects/${a.project.id}/join`, token, { agent: "beta" })).status).toBe(
      403,
    );
    expect((await api(`/projects/${b.project.id}/join`, token, { agent: "alpha" })).status).toBe(
      403,
    );
    expect((await api(`/projects/${a.project.id}/activity`, "wrong")).status).toBe(403);
    expect((await api(`/projects/${a.project.id}/activity`, null)).status).toBe(401);
    expect((await api("/projects", token, { id: projectId(), agents: ["alpha"] })).status).toBe(
      403,
    );
    expect((await inspect(a.project.id)).calls.some((call) => call.method === "fork")).toBe(false);
    expect((await api(`/projects/${a.project.id}/activity`, token)).status).toBe(200);
  });

  it("records nested changes, removals and mode changes exactly once for duplicate deliveries", async () => {
    const { project } = await create();
    const push = event(project.id);
    const results = await Promise.all([consume([push, push]), consume([push])]);
    for (const result of results) expect(result.retryMessages).toEqual([]);
    const entries = await activity(project.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      repoName: project.id,
      agent: null,
      before: BEFORE,
      after: AFTER,
      changedPaths: ["added.txt", "mode.sh", "removed.txt", "src/index.ts"],
    });
    expect(
      (await inspect(project.id)).calls.filter((call) => call.method === "readCommit"),
    ).toHaveLength(2);
  });

  it("keys idempotency by repo, ref, and after, with the namespace fence", async () => {
    const { project } = await create();
    await api(`/projects/${project.id}/join`, OWNER, { agent: "alpha" });
    await consume([
      event(project.id),
      event(project.id, { ref: "refs/heads/topic" }),
      event(`${project.id}--alpha-1`),
      { ...event(project.id), source: { namespace: "other", repoName: project.id } },
    ]);
    const entries = await activity(project.id);
    expect(entries).toHaveLength(3);
    expect(entries[2]?.agent).toBe("alpha");
  });

  it("ignores deletion, unrelated event types and unregistered lookalike repos", async () => {
    const { project } = await create();
    const result = await consume([
      event(project.id, { after: ZERO_SHA }),
      { type: "cf.artifacts.repo.created" },
      event(`${project.id}--unknown-1`),
    ]);
    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(3);
    expect(await activity(project.id)).toEqual([]);
    expect((await inspect(project.id)).calls.some((call) => call.method === "readCommit")).toBe(
      false,
    );
  });

  it("treats new refs as an empty before tree and diffs force pushes without ancestry assumptions", async () => {
    const { project } = await create();
    await consume([
      event(project.id, { before: ZERO_SHA }),
      event(project.id, { before: AFTER, after: BEFORE }),
    ]);
    const entries = await activity(project.id);
    expect(entries[0]?.changedPaths).toEqual(["added.txt", "mode.sh", "same.txt", "src/index.ts"]);
    expect(entries[1]?.changedPaths).toEqual([
      "added.txt",
      "mode.sh",
      "removed.txt",
      "src/index.ts",
    ]);
  });

  it("retries failed tree reads without writing activity or poisoning idempotency", async () => {
    const { project } = await create();
    await runInDurableObject(supervisor(project.id), (instance) => {
      if (instance instanceof TestSupervisor) instance.fixture.failTree = true;
    });
    const result = await consume([event(project.id)]);
    expect(result.retryMessages).toHaveLength(1);
    expect(await activity(project.id)).toEqual([]);
    await runInDurableObject(supervisor(project.id), (instance) => {
      if (instance instanceof TestSupervisor) instance.fixture.failTree = false;
    });
    await consume([event(project.id)]);
    expect(await activity(project.id)).toHaveLength(1);
  });

  it("paginates activity in receive order", async () => {
    const { project } = await create();
    await consume([event(project.id), event(project.id, { ref: "refs/heads/topic" })]);
    const response = await api(`/projects/${project.id}/activity?limit=1&after=1`);
    const page = await response.json<{ activity: Activity[]; nextAfter: number }>();
    expect(page.activity.map((entry) => entry.sequence)).toEqual([2]);
    expect(page.nextAfter).toBe(2);
  });

  it("sanitizes provider errors and fences uncertain creation", async () => {
    const id = projectId();
    await runInDurableObject(supervisor(id), (instance) => {
      if (instance instanceof TestSupervisor) instance.fixture.failCreate = true;
    });
    const response = await api("/projects", OWNER, { id, agents: ["alpha"] });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fixture-provider-secret");
    expect((await api("/projects", OWNER, { id, agents: ["alpha"] })).status).toBe(409);
  });
});
