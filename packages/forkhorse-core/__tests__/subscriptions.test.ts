import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { EventSubscriptions, type RepoEvents } from "../src/subscriptions";
import { TestSupervisor } from "./worker";

const TOKEN = "offline-event-secret-must-not-escape";
const ACCOUNT = "0".repeat(32);
const QUEUE = "1".repeat(32);
const OWNER = "offline-fixture-owner-token";
interface Subscription {
  id: string;
  name: string;
  enabled: boolean;
  source: { type: string; namespace: string; repo_name: string };
  destination: { type: string; queue_id: string };
  events: string[];
}
let subscriptions: Subscription[];
let requests: { method: string; page: number; body?: unknown }[];
let failList: boolean;
let uncertainPost: boolean;
let logs: unknown[][];
const stub = (id: string) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
const api = (path: string, data?: unknown, token = OWNER) => worker.fetch(new Request(`https://api.idiot.tax${path}`, {
  method: data === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: data === undefined ? undefined : JSON.stringify(data),
}), env);
async function setup() {
  const id = `events-${crypto.randomUUID().slice(0, 8)}`;
  await runInDurableObject(stub(id), (instance) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Fixture required");
    instance.configureEvents({ CF_ACCOUNT_ID: ACCOUNT, CF_EVENTS_API_TOKEN: TOKEN, PUSH_QUEUE_ID: QUEUE });
  });
  return id;
}
async function stored(id: string) {
  return runInDurableObject(stub(id), async (_, state) => ({
    records: [...(await state.storage.list<RepoEvents>({ prefix: "repoEvents:" })).values()],
    all: [...await state.storage.list()],
    alarm: await state.storage.getAlarm(),
  }));
}
async function retry(id: string) {
  await runInDurableObject(stub(id), async (_, state) => {
    for (const [key, value] of await state.storage.list<RepoEvents>({ prefix: "repoEvents:" })) {
      if (value.events === "pending") await state.storage.put(key, { ...value, retryAt: Date.now() - 1 });
    }
  });
  expect(await runDurableObjectAlarm(stub(id))).toBe(true);
}
beforeEach(() => {
  subscriptions = []; requests = []; logs = []; failList = false; uncertainPost = false;
  for (const method of ["log", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args); });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/event_subscriptions/subscriptions`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("manual");
    if (request.method === "GET") {
      expect(url.searchParams.get("queue_id")).toBe(QUEUE);
      expect(url.searchParams.get("per_page")).toBe("20");
      const page = Number(url.searchParams.get("page"));
      requests.push({ method: "GET", page });
      if (failList) return new Response(TOKEN, { status: 503 });
      return Response.json({ success: true, result: subscriptions.slice((page - 1) * 20, page * 20) });
    }
    const body = await request.json<Omit<Subscription, "id">>();
    requests.push({ method: request.method, page: 0, body });
    const subscription = { ...body, id: crypto.randomUUID() };
    subscriptions.push(subscription);
    if (uncertainPost) throw new Error(TOKEN);
    return Response.json({ success: true, result: subscription });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("per-repo subscription API and durable recovery in workerd (fixtures only)", () => {
  it("creates exact Wrangler subscriptions for canonical and every fork; hides secret everywhere", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const id = await setup();
    const created = await api("/projects", { id, agents: ["alpha", "beta"] });
    expect(created.status).toBe(201);
    const value = await created.json<{ agents: { apiToken: string }[]; project: { events: string } }>();
    expect(value.project.events).toBe("active");
    const replies = [JSON.stringify(value)];
    for (const agent of ["alpha", "beta", "alpha"]) {
      const joined = await api(`/projects/${id}/join`, { agent });
      expect(joined.status).toBe(201);
      const text = await joined.text(); replies.push(text);
      expect(JSON.parse(text).events).toBe("active");
    }
    expect(subscriptions.map((s) => s.source.repo_name)).toEqual([id, `${id}--alpha-1`, `${id}--beta-1`, `${id}--alpha-2`]);
    for (const subscription of subscriptions) {
      expect(subscription).toMatchObject({
        enabled: true, source: { type: "artifacts.repo", namespace: "fixture" },
        destination: { type: "queues.queue", queue_id: QUEUE }, events: ["pushed"],
      });
    }
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST", "GET", "POST", "GET", "POST", "GET", "POST"]);
    const me = await (await api(`/projects/${id}/me`, undefined, value.agents[0]!.apiToken)).json<{ forks: { events: string }[] }>();
    expect(me.forks).toHaveLength(2);
    expect(me.forks.every((f) => f.events === "active")).toBe(true);
    replies.push(JSON.stringify(me), await (await api(`/projects/${id}/state`)).text());
    const state = await stored(id);
    expect(state.alarm).toBeNull();
    expect(state.records.map((r) => r.subscriptionId).toSorted()).toEqual(subscriptions.map((s) => s.id).toSorted());
    expect(JSON.stringify([replies, state.all, logs])).not.toContain(TOKEN);
  });

  it("keeps create/join successful on failure, exposes pending, backs off, and recovers via real DO alarm", async () => {
    failList = true;
    const id = await setup();
    const created = await api("/projects", { id, agents: ["alpha"] });
    expect(created.status).toBe(201);
    const data = await created.json<{ project: { events: string } }>();
    expect(data.project.events).toBe("pending");
    const joined = await api(`/projects/${id}/join`, { agent: "alpha" });
    expect(joined.status).toBe(201);
    expect(await joined.text()).not.toContain(TOKEN);
    const state = await (await api(`/projects/${id}/state`)).json<{ project: { events: string }; forks: { events: string }[] }>();
    expect(state.project.events).toBe("pending");
    expect(state.forks[0]?.events).toBe("pending");
    expect(await (await api(`/projects/${id}/me`)).text()).toContain('"events":"pending"');
    const first = await stored(id);
    expect(first.alarm).not.toBeNull();
    await retry(id);
    const second = await stored(id);
    expect(second.records.every((r) => r.attempts === 2)).toBe(true);
    expect(second.records[0]!.retryAt - Date.now()).toBeGreaterThan(55_000);
    expect(subscriptions).toHaveLength(0);
    failList = false;
    await retry(id);
    const recovered = await stored(id);
    expect(recovered.records.every((r) => r.events === "active")).toBe(true);
    expect(recovered.alarm).toBeNull();
    expect(JSON.stringify([data, state, recovered.all, logs])).not.toContain(TOKEN);
  });

  it("adopts a successful but lost POST response after reconstructing the retry handler", async () => {
    uncertainPost = true;
    const id = await setup();
    expect((await api("/projects", { id, agents: ["alpha"] })).status).toBe(201);
    expect((await stored(id)).records[0]?.events).toBe("pending");
    expect(subscriptions).toHaveLength(1);
    uncertainPost = false;
    await runInDurableObject(stub(id), async (_, state) => {
      // New helper using only durable records simulates recovery without any in-memory result.
      await new EventSubscriptions(state.storage, { ...env, CF_ACCOUNT_ID: ACCOUNT, CF_EVENTS_API_TOKEN: TOKEN, PUSH_QUEUE_ID: QUEUE }).attempt(id);
    });
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect((await stored(id)).records[0]?.subscriptionId).toBe(subscriptions[0]?.id);
    expect(JSON.stringify([(await stored(id)).all, logs])).not.toContain(TOKEN);
  });

  it("lists all pages and rejects wrong repo, namespace, destination, event, or disabled matches", async () => {
    const id = await setup();
    const correct: Subscription = {
      id: crypto.randomUUID(), name: "fixture", enabled: true,
      source: { type: "artifacts.repo", namespace: "fixture", repo_name: id },
      destination: { type: "queues.queue", queue_id: QUEUE }, events: ["pushed"],
    };
    subscriptions = Array.from({ length: 20 }, () => ({ ...correct, enabled: false }));
    subscriptions.push(
      { ...correct, source: { ...correct.source, namespace: "wrong" } },
      { ...correct, source: { ...correct.source, repo_name: "wrong" } },
      { ...correct, destination: { type: "queues.queue", queue_id: "2".repeat(32) } },
      { ...correct, events: ["created"] },
      correct,
    );
    expect((await api("/projects", { id, agents: ["alpha"] })).status).toBe(201);
    expect(requests.map((r) => r.page)).toEqual([1, 2]);
    expect((await stored(id)).records[0]?.subscriptionId).toBe(correct.id);
    await runInDurableObject(stub(id), async (_, state) => {
      await new EventSubscriptions(state.storage, env).attempt(id);
    });
    expect(requests).toHaveLength(2); // Durable active state short-circuits retries.
  });

  it("missing configuration remains pending without a credential-bearing request", async () => {
    const id = `missing-${crypto.randomUUID().slice(0, 8)}`;
    expect((await api("/projects", { id, agents: ["alpha"] })).status).toBe(201);
    expect((await stored(id)).records[0]?.events).toBe("pending");
    expect(requests).toHaveLength(0);
  });
});
