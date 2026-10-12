import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Activity, PushEvent } from "../src/types";
import type { StoredActivity } from "../src/activity";
import type { Blocker } from "../src/workflow-types";
import { AFTER, BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
function paths(count: number) {
  return Array.from({ length: count }, (_, i) => `file-${String(i + 1).padStart(3, "0")}.ts`);
}
function api(path: string, data?: unknown, token = OWNER) {
  return worker.fetch(new Request(`https://api.idiot.tax${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), env);
}
function stub(id: string) {
  return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
}
async function create() {
  const id = `activity-${crypto.randomUUID().slice(0, 8)}`;
  const response = await api("/projects", { id, agents: ["alpha", "beta"] });
  expect(response.status).toBe(201);
  const created = await response.json<{ agents: { apiToken: string }[] }>();
  return { id, alpha: created.agents[0]!.apiToken, beta: created.agents[1]!.apiToken };
}
async function mutate(id: string, callback: (instance: TestSupervisor, state: DurableObjectState) => Promise<void> | void) {
  return runInDurableObject(stub(id), async (instance, state) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected offline fixture supervisor");
    await callback(instance, state);
  });
}
async function read(id: string, endpoint: string, token = OWNER) {
  const response = await api(`/projects/${id}/${endpoint}`, undefined, token);
  expect(response.status).toBe(200);
  return response.json<{ activity: Activity[]; nextAfter?: number; blockers?: Blocker[] }>();
}
function push(repoName: string): PushEvent {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { namespace: "fixture", repoName },
    payload: { ref: "refs/heads/main", before: BEFORE, after: AFTER },
    metadata: { eventTimestamp: "2026-10-12T12:00:00Z" },
  };
}

describe("activity cap in workerd with offline Artifacts fixtures", () => {
  it.each([0, 3, 50, 51, 400])("stores and serves the original total for a %i-path push", async (count) => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const { id, alpha } = await create();
    const fullPaths = paths(count);
    await mutate(id, (instance) => { instance.fixture.changedPaths = fullPaths; });
    expect(await stub(id).recordPush(push(id))).toBe(true);
    const expected = {
      changedPaths: fullPaths.slice(0, 50),
      changedPathCount: count,
      changedPathsTruncated: count > 50,
    };
    await mutate(id, async (_instance, state) => {
      const entries = [...(await state.storage.list<Activity>({ prefix: "activity:" })).values()];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject(expected);
    });
    for (const endpoint of ["activity", "state"])
      expect((await read(id, endpoint, alpha)).activity[0]).toMatchObject(expected);
  });

  it("detects a collision only at path 120 of 400 before capping storage", async () => {
    const { id, alpha, beta } = await create();
    for (const [agent, token] of [["alpha", alpha], ["beta", beta]])
      expect((await api(`/projects/${id}/join`, { agent }, token)).status).toBe(201);
    expect((await api(`/projects/${id}/packets`, {
      id: "collision", title: "Fixture collision", goal: "Test the full push diff",
      paths: ["file-120.ts"], acceptance: ["A blocker includes path 120"],
    })).status).toBe(201);
    expect((await api(`/projects/${id}/packets/collision/claim`, {
      repoName: `${id}--alpha-1`,
    }, alpha)).status).toBe(201);
    await mutate(id, (instance) => { instance.fixture.changedPaths = paths(400); });
    expect(await stub(id).recordPush(push(`${id}--beta-1`))).toBe(true);
    const snapshot = await read(id, "state", beta);
    expect(snapshot.activity[0]?.changedPaths).not.toContain("file-120.ts");
    expect(snapshot.activity[0]?.changedPathCount).toBe(400);
    expect(snapshot.blockers).toHaveLength(1);
    expect(snapshot.blockers?.[0]).toMatchObject({ packet: "collision", paths: ["file-120.ts"] });
  });

  it("caps legacy 205-path reads without migration and preserves already capped totals", async () => {
    const { id, alpha } = await create();
    const legacy: StoredActivity = {
      sequence: 1, namespace: "fixture", repoName: id, agent: null,
      ref: "refs/heads/main", before: BEFORE, after: AFTER, changedPaths: paths(205),
      eventTimestamp: "2026-10-12T12:00:00Z", recordedAt: "2026-10-12T12:00:01Z",
    };
    const capped: Activity = {
      ...legacy, sequence: 2, changedPaths: paths(50), changedPathCount: 400, changedPathsTruncated: true,
    };
    await mutate(id, async (_instance, state) => {
      await state.storage.put({ "activity:0000000000000001": legacy, "activity:0000000000000002": capped });
    });
    for (const endpoint of ["activity", "state"]) {
      const entries = (await read(id, endpoint, alpha)).activity;
      expect(entries[0]).toEqual({ ...legacy, changedPaths: paths(50), changedPathCount: 205, changedPathsTruncated: true });
      expect(entries[1]).toEqual(capped);
    }
    const page = await read(id, "activity?after=1&limit=1", alpha);
    expect(page.activity).toEqual([capped]);
    expect(page.nextAfter).toBe(2);
    await mutate(id, async (_instance, state) => {
      expect(await state.storage.get("activity:0000000000000001")).toEqual(legacy);
    });
  });
});
