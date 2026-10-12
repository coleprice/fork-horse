import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type {
  Blocker,
  Claim,
  Fork,
  LedgerEntry,
  ReconcilerAlert,
  Review,
} from "../src/workflow-types";
import type { PushEvent } from "../src/types";
import { AFTER, BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
function api(id: string, path: string, token = OWNER, data?: unknown, method?: string) {
  return worker.fetch(
    new Request(`https://api.idiot.tax/projects/${id}${path}`, {
      method: method ?? (data === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}` },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    env,
  );
}
function stub(id: string) {
  return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
}
async function mutate(
  id: string,
  callback: (instance: TestSupervisor, state: DurableObjectState) => void | Promise<void>,
) {
  return runInDurableObject(stub(id), async (instance, objectState) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected fixture supervisor");
    await callback(instance, objectState);
  });
}
interface State {
  claims: Claim[];
  forks: (Fork & { head: string })[];
  reviews: Review[];
  ledger: LedgerEntry[];
  reconcilerAlerts: ReconcilerAlert[];
  blockers: Blocker[];
  promotionPending: LedgerEntry | null;
}
async function state(id: string) {
  return (await api(id, "/state")).json<State>();
}
async function fixture() {
  const id = `flow-${crypto.randomUUID().slice(0, 8)}`;
  const response = await worker.fetch(
    new Request("https://api.idiot.tax/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ id, agents: ["alpha", "beta"] }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  const created = await response.json<{ agents: { apiToken: string }[] }>();
  const alpha = created.agents[0]!.apiToken,
    beta = created.agents[1]!.apiToken;
  for (const [agent, token] of [
    ["alpha", alpha],
    ["beta", beta],
  ]) {
    expect((await api(id, "/join", token, { agent })).status).toBe(201);
  }
  return { id, alpha, beta, a: `${id}--alpha-1`, b: `${id}--beta-1` };
}
async function packet(id: string, pid = "one", paths = ["src/**"]) {
  expect(
    (
      await api(id, "/packets", OWNER, {
        id: pid,
        title: pid,
        goal: "Fixture goal",
        paths,
        acceptance: ["Fixture check"],
      })
    ).status,
  ).toBe(201);
}
async function claim(id: string, token: string, pid = "one", data: unknown = {}) {
  return api(id, `/packets/${pid}/claim`, token, data);
}
async function review(id: string, token: string, repoName: string, pid = "one", sha = AFTER) {
  await mutate(id, (instance) => {
    instance.fixture.heads.set(repoName, sha);
  });
  const response = await api(id, "/reviews", token, { repoName, packet: pid, sha });
  expect(response.status).toBe(201);
  const { review: requested } = await response.json<{ review: Review }>();
  expect(requested.receiptDigest).toBeNull();
  expect((await api(id, `/reviews/${requested.id}/approve`, OWNER, {})).status).toBe(200);
  return requested;
}
function push(
  repoName: string,
  before = BEFORE,
  after = AFTER,
  ref = "refs/heads/main",
): PushEvent {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { namespace: "fixture", repoName },
    payload: { ref, before, after },
    metadata: { eventTimestamp: "2026-10-12T00:00:00Z" },
  };
}

describe("workflow in real Durable Objects, with explicitly offline Git/Artifacts fixtures", () => {
  it("binds explicit and latest successful forks once; later joins and counter gaps cannot redirect claims", async () => {
    const f = await fixture();
    await packet(f.id);
    await mutate(f.id, (instance) => {
      instance.fixture.failCreate = true;
    });
    expect((await api(f.id, "/join", f.alpha, { agent: "alpha" })).status).toBe(502);
    await mutate(f.id, async (instance, storage) => {
      instance.fixture.failCreate = false;
      await storage.storage.put("forkCounter:alpha", 8);
    });
    expect((await claim(f.id, f.alpha)).status).toBe(201);
    expect((await state(f.id)).claims[0]?.repoName).toBe(f.a);
    expect((await api(f.id, "/join", f.alpha, { agent: "alpha" })).status).toBe(201);
    expect((await claim(f.id, f.alpha)).status).toBe(200);
    expect((await claim(f.id, f.alpha, "one", { repoName: `${f.id}--alpha-9` })).status).toBe(409);
    expect((await state(f.id)).claims[0]?.repoName).toBe(f.a);
    expect((await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE")).status).toBe(200);
    expect((await claim(f.id, f.alpha, "one", { repoName: `${f.id}--alpha-9` })).status).toBe(201);
    expect((await state(f.id)).claims[0]?.repoName).toBe(`${f.id}--alpha-9`);
  });

  it("rejects overlapping claims and records another agent's push conflict atomically and once", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "two", ["src/index.ts"]);
    expect((await claim(f.id, f.alpha)).status).toBe(201);
    expect((await claim(f.id, f.beta, "two")).status).toBe(409);
    expect(await stub(f.id).recordPush(push(f.b))).toBe(true);
    expect(await stub(f.id).recordPush(push(f.b))).toBe(true);
    expect((await state(f.id)).blockers).toMatchObject([
      { packet: "one", claimingAgent: "alpha", pushingAgent: "beta", paths: ["src/index.ts"] },
    ]);
    expect((await state(f.id)).blockers).toHaveLength(1);
    await stub(f.id).recordPush(push(f.a));
    expect((await state(f.id)).blockers).toHaveLength(1);
  });

  it("allows sibling paths and rejects canonical/foreign fork selection", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "two", ["src-other"]);
    expect((await claim(f.id, f.alpha, "one", { repoName: f.id })).status).toBe(403);
    expect((await claim(f.id, f.alpha, "one", { repoName: f.b })).status).toBe(403);
    expect((await claim(f.id, f.alpha)).status).toBe(201);
    expect((await claim(f.id, f.beta, "two")).status).toBe(201);
  });

  it("enrolls and rotates tokens without exposing hashes; old credentials stop working", async () => {
    const f = await fixture();
    expect((await api(f.id, "/agents", f.alpha, { agent: "gamma" })).status).toBe(403);
    const enrollment = await api(f.id, "/agents", OWNER, { agent: "gamma" });
    expect(enrollment.status).toBe(201);
    const old = await enrollment.json<{ apiToken: string }>();
    expect((await api(f.id, "/state", old.apiToken)).status).toBe(200);
    const rotation = await api(f.id, "/agents/gamma/rotate", OWNER, {});
    expect(rotation.status).toBe(200);
    const fresh = await rotation.json<{ apiToken: string }>();
    expect((await api(f.id, "/state", old.apiToken)).status).toBe(403);
    const response = await api(f.id, "/state", fresh.apiToken);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain(fresh.apiToken);
  });

  it("commits only inside a live caller-owned binding and revokes the internal write token", async () => {
    const f = await fixture();
    await packet(f.id);
    const data = {
      packet: "one",
      files: [{ path: "src/index.ts", content: "fixture" }],
      message: "Fixture commit",
    };
    expect((await api(f.id, `/forks/${f.a}/commit`, f.alpha, data)).status).toBe(409);
    await claim(f.id, f.alpha);
    expect((await api(f.id, `/forks/${f.id}/commit`, f.alpha, data)).status).toBe(403);
    expect((await api(f.id, `/forks/${f.b}/commit`, f.alpha, data)).status).toBe(403);
    expect((await api(f.id, `/forks/${f.a}/commit`, OWNER, data)).status).toBe(403);
    expect(
      (
        await api(f.id, `/forks/${f.a}/commit`, f.alpha, {
          ...data,
          files: [{ path: "elsewhere", content: "x" }],
        })
      ).status,
    ).toBe(403);
    const response = await api(f.id, `/forks/${f.a}/commit`, f.alpha, data);
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain("scoped-");
    await mutate(f.id, (instance) => {
      expect(instance.gitFixture.pushes).toHaveLength(1);
      expect(
        instance.fixture.calls
          .filter((call) => call.repo === f.a && call.method === "createToken")
          .at(-1)?.ttl,
      ).toBe(60);
      expect(
        instance.fixture.calls.filter((call) => call.repo === f.a && call.method === "revokeToken"),
      ).toHaveLength(2);
    });
  });

  it("bounds the wire body, file count, path grammar and duplicate paths before Git", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const commit = (files: unknown[]) =>
      api(f.id, `/forks/${f.a}/commit`, f.alpha, { packet: "one", files, message: "Fixture" });
    expect((await commit([{ path: "src/a", content: "x".repeat(1024 * 1024) }])).status).toBe(413);
    expect(
      (await commit(Array.from({ length: 201 }, (_, i) => ({ path: `src/${i}`, content: "x" }))))
        .status,
    ).toBe(400);
    for (const path of ["src/../x", "src/.git/config", "/src/x", "src\\x", "src//x", "src/a\u0000"])
      expect((await commit([{ path, content: "x" }])).status).toBe(400);
    expect(
      (
        await commit([
          { path: "src/a", content: "x" },
          { path: "src/a", content: "y" },
        ])
      ).status,
    ).toBe(400);
    await mutate(f.id, (instance) => {
      expect(instance.gitFixture.pushes).toHaveLength(0);
    });
  });

  it("refuses a stale approval even before a push notification arrives", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (instance) => {
      instance.fixture.heads.set(f.a, "d".repeat(40));
    });
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
    expect((await state(f.id)).reviews[0]?.stale).toBe(true);
    await mutate(f.id, (instance) => {
      expect(
        instance.fixture.calls.some((call) => call.repo === f.id && call.method === "createToken"),
      ).toBe(false);
    });
  });

  it("invalidates approval when its receipt digest changes or its claim is released", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, async (_instance, storage) => {
      await storage.storage.put(`review:${r.id}`, {
        ...r,
        approval: { sha: r.sha, receiptDigest: null },
        receiptDigest: "e".repeat(64),
      });
    });
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
    expect((await api(f.id, `/reviews/${r.id}/approve`, OWNER, {})).status).toBe(200);
    await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE");
    await claim(f.id, f.alpha);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
  });

  it("serializes competing reviews from the same base: exactly one lands", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "two", ["docs"]);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta, "two");
    const a = await review(f.id, f.alpha, f.a),
      b = await review(f.id, f.beta, f.b, "two", "b".repeat(40));
    const responses = await Promise.all([
      api(f.id, `/reviews/${a.id}/promote`, OWNER, {}),
      api(f.id, `/reviews/${b.id}/promote`, OWNER, {}),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    expect(await responses.find((r) => r.status === 409)!.json()).toEqual({
      error: "stale base, rebase",
    });
    const snapshot = await state(f.id);
    expect(snapshot.ledger).toHaveLength(1);
    expect(snapshot.reviews.filter((r) => r.promoted)).toHaveLength(1);
    expect(snapshot.promotionPending).toBeNull();
    await mutate(f.id, (instance) => {
      expect(instance.gitFixture.pushes).toHaveLength(1);
    });
  });

  it("serializes duplicate promote requests: exactly one lands and the credential is revoked", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    const responses = await Promise.all([
      api(f.id, `/reviews/${r.id}/promote`, OWNER, {}),
      api(f.id, `/reviews/${r.id}/promote`, OWNER, {}),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    await mutate(f.id, (instance) => {
      expect(instance.gitFixture.pushes).toHaveLength(1);
      expect(
        instance.fixture.calls.filter(
          (call) => call.repo === f.id && call.method === "createToken",
        ),
      ).toHaveLength(1);
      expect(
        instance.fixture.calls.filter(
          (call) => call.repo === f.id && call.method === "revokeToken",
        ),
      ).toHaveLength(2);
    });
  });

  it("rejects an external head race at push, without a success ledger entry", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (instance) => {
      instance.gitFixture.raceBeforePush = true;
    });
    const response = await api(f.id, `/reviews/${r.id}/promote`, OWNER, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale base, rebase" });
    expect((await state(f.id)).ledger).toHaveLength(0);
  });

  it("fences uncertain promotion outcomes and revokes tokens without exposing provider errors", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (instance) => {
      instance.gitFixture.failPush = true;
    });
    const response = await api(f.id, `/reviews/${r.id}/promote`, OWNER, {});
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fixture-secret");
    expect((await state(f.id)).promotionPending).not.toBeNull();
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
    await mutate(f.id, (instance) => {
      expect(
        instance.fixture.calls.filter(
          (call) => call.repo === f.id && call.method === "revokeToken",
        ),
      ).toHaveLength(2);
    });
  });

  it("recognizes exact ledger transitions and alerts on out-of-ledger moves, even to a previously merged SHA", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(200);
    await stub(f.id).recordPush(push(f.id));
    expect((await state(f.id)).reconcilerAlerts).toEqual([]);
    await stub(f.id).recordPush(push(f.id, AFTER, BEFORE));
    expect((await state(f.id)).reconcilerAlerts).toHaveLength(1);
    await stub(f.id).recordPush(push(f.id, BEFORE, AFTER, "refs/heads/unmanaged"));
    expect((await state(f.id)).reconcilerAlerts).toHaveLength(2);
    const replayedTransition = push(f.id);
    replayedTransition.metadata.eventTimestamp = "2026-10-12T00:01:00Z";
    await stub(f.id).recordPush(replayedTransition);
    expect((await state(f.id)).reconcilerAlerts).toHaveLength(3);
  });
});
