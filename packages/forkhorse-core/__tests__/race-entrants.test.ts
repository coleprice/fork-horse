import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type {
  Blocker,
  Claim,
  ClaimReleaseAudit,
  Packet,
  RaceState,
  WorkItem,
  Fork,
  LedgerEntry,
  ReconcilerAlert,
  Review,
} from "../src/workflow-types";
import type { PushEvent } from "../src/types";
import { openEntrants } from "../src/race-entrants";
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
  agents: { name: string; createdAt: string | null }[];
  packets: Packet[];
  races: RaceState[];
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
async function releases(id: string): Promise<ClaimReleaseAudit[]> {
  return runInDurableObject(stub(id), async (_instance, objectState) =>
    [...(await objectState.storage.list<ClaimReleaseAudit>({ prefix: "claimRelease:" })).values()],
  );
}
async function fixture(branch = "main", names = ["alpha", "beta", "gamma", "delta"]) {
  const id = `flow-${crypto.randomUUID().slice(0, 8)}`;
  await mutate(id, (instance) => {
    instance.fixture.defaultBranch = branch;
    instance.fixture.checks = JSON.stringify([{ name: "fixture", tier: "full", image: "default", run: "true" }]);
  });
  const response = await worker.fetch(
    new Request("https://api.idiot.tax/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ id, agents: names, requireReceipt: false }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  const created = await response.json<{ agents: { apiToken: string }[] }>();
  const tokens = created.agents.map(agent => agent.apiToken);
  const alpha = created.agents[0]!.apiToken,
    beta = created.agents[1]!.apiToken;
  for (const [index, agent] of names.entries()) {
    expect((await api(id, "/join", tokens[index]!, { agent })).status).toBe(201);
  }
  return { id, alpha, beta, tokens, a: `${id}--alpha-1`, b: `${id}--beta-1` };
}
async function packet(id: string, pid = "one", paths = ["src/**"], mode: "standard" | "race" = "race") {
  expect(
    (
      await api(id, "/packets", OWNER, {
        id: pid, mode,
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
async function review(id: string, token: string, repoName: string, pid = "one", sha = AFTER, approve = true) {
  await mutate(id, (instance) => {
    instance.fixture.heads.set(repoName, sha);
  });
  const response = await api(id, "/reviews", token, { repoName, packet: pid, sha });
  expect(response.status).toBe(201);
  const { review: requested } = await response.json<{ review: Review }>();
  expect(requested.receiptDigest).toBeNull();
  // Drain this offline background execution before approving its attached digest.
  await mutate(id, async (_instance, objectState) => {
    for (let i = 0; i < 100; i++) {
      const current = await objectState.storage.get<Review>(`review:${requested.id}`);
      if (current?.receipt?.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  });
  if (approve) expect((await api(id, `/reviews/${requested.id}/approve`, OWNER, {})).status).toBe(200);
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
    metadata: { eventTimestamp: new Date().toISOString() },
  };
}

// All providers and container executions below are explicitly offline fixtures in real workerd.
describe("FH-052 race entrants", () => {
  it("defaults and normalizes standard mode, validates owner-only opt-in, and keeps it immutable", async () => {
    const f = await fixture();
    const data = { id: "default", title: "Default", goal: "Goal", paths: ["src"], acceptance: ["check"] };
    expect((await api(f.id, "/packets", f.alpha, { ...data, mode: "race" })).status).toBe(403);
    for (const mode of [null, "other", 1])
      expect((await api(f.id, "/packets", OWNER, { ...data, mode })).status).toBe(400);
    expect((await api(f.id, "/packets", OWNER, data)).status).toBe(201);
    expect((await api(f.id, "/packets", OWNER, { ...data, mode: "race" })).status).toBe(409);
    await mutate(f.id, async (_instance, objectState) => {
      const stored = (await objectState.storage.get<Packet>("packet:default"))!;
      expect(stored.mode).toBe("standard");
      delete stored.mode;
      await objectState.storage.put("packet:default", stored);
    });
    expect((await state(f.id)).packets[0]?.mode).toBe("standard");
    expect((await (await api(f.id, "/packets")).json<{ packets: Packet[] }>()).packets[0]?.mode).toBe("standard");
    await claim(f.id, f.alpha, "default");
    expect((await state(f.id)).claims[0]).toEqual({ packet: "default", agent: "alpha", repoName: f.a, paths: ["src"], createdAt: expect.any(String) });
    expect((await state(f.id)).races).toEqual([]);
  });

  it("accepts two and three overlapping entrants, refuses a fourth distinct entrant, and never uses claim keys", async () => {
    const f = await fixture();
    await packet(f.id);
    for (const token of f.tokens.slice(0, 3)) expect((await claim(f.id, token)).status).toBe(201);
    expect((await claim(f.id, f.tokens[3]!)).status).toBe(409);
    const race = (await state(f.id)).races[0]!;
    expect(race).toMatchObject({ packet: "one", status: "open", finishedAt: null, winner: null, ledgerEntryId: null });
    expect(race.entrants.map(e => e.agent)).toEqual(["alpha", "beta", "gamma"]);
    for (const entrant of race.entrants) expect(entrant).toMatchObject({
      firstPushAt: null, reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null,
      promotedAt: null, place: null, closedAt: null, closedBy: null,
    });
    await mutate(f.id, async (_instance, objectState) => {
      expect(await objectState.storage.get("claim:one")).toBeUndefined();
      expect((await openEntrants(objectState.storage, "one")).length).toBe(3);
      expect((await openEntrants(objectState.storage)).length).toBe(3);
      expect([...(await objectState.storage.list({ prefix: "entrant:" })).keys()]).toEqual([
        "entrant:one:alpha", "entrant:one:beta", "entrant:one:gamma",
      ]);
    });
  });

  it("serializes concurrent cap checks and duplicate claims with immutable caller-owned bindings", async () => {
    const f = await fixture();
    await packet(f.id);
    expect((await claim(f.id, f.alpha, "one", { repoName: f.b })).status).toBe(403);
    expect((await claim(f.id, OWNER)).status).toBe(403);
    const responses = await Promise.all(f.tokens.map(token => claim(f.id, token)));
    expect(responses.map(r => r.status).toSorted()).toEqual([201, 201, 201, 409]);
    const entrant = (await state(f.id)).races[0]!.entrants[0]!;
    const token = f.tokens[["alpha", "beta", "gamma", "delta"].indexOf(entrant.agent)]!;
    const repeated = await Promise.all([claim(f.id, token), claim(f.id, token)]);
    expect(repeated.map(r => r.status)).toEqual([200, 200]);
    const joined = await api(f.id, "/join", token, { agent: entrant.agent });
    const fork = await joined.json<{ repoName: string }>();
    expect((await claim(f.id, token, "one", { repoName: fork.repoName })).status).toBe(409);
    expect((await state(f.id)).races[0]!.entrants).toHaveLength(3);
  });

  it("refuses cross-packet overlaps in both directions and between different races", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "standard", ["src/index.ts"], "standard");
    await packet(f.id, "other-race", ["src"]);
    await claim(f.id, f.alpha, "standard");
    expect((await claim(f.id, f.beta)).status).toBe(409);
    await api(f.id, "/packets/standard/claim", f.alpha, undefined, "DELETE");
    expect((await claim(f.id, f.beta)).status).toBe(201);
    expect((await claim(f.id, f.alpha, "standard")).status).toBe(409);
    expect((await claim(f.id, f.alpha, "other-race")).status).toBe(409);
    // Preserve the standard rule that an agent's own claims don't conflict.
    expect((await claim(f.id, f.beta, "standard")).status).toBe(201);
  });

  it.each(["agent", "owner"] as const)("%s release closes only the chosen entrant and preserves history and the lifetime cap", async role => {
    const f = await fixture();
    await packet(f.id);
    for (const token of f.tokens.slice(0, 3)) await claim(f.id, token);
    const a = await review(f.id, f.alpha, f.a);
    const b = await review(f.id, f.beta, f.b);
    const before = (await state(f.id)).races[0]!.entrants;
    if (role === "owner") expect((await api(f.id, "/packets/one/claim", OWNER, undefined, "DELETE")).status).toBe(400);
    const token = role === "owner" ? OWNER : f.alpha;
    // An agent-supplied target cannot close somebody else's entry.
    const data = role === "owner" ? { agent: "alpha" } : { agent: "beta" };
    expect((await api(f.id, "/packets/one/claim", token, data, "DELETE")).status).toBe(200);
    const closed = (await state(f.id)).races[0]!.entrants;
    expect(closed[0]).toMatchObject({ ...before[0], closedAt: expect.any(String), closedBy: role === "owner" ? "owner" : "release" });
    expect(closed.slice(1)).toEqual(before.slice(1));
    expect((await state(f.id)).reviews.find(r => r.id === a.id)?.stale).toBe(true);
    expect((await state(f.id)).reviews.find(r => r.id === b.id)?.stale).toBe(false);
    expect((await api(f.id, `/reviews/${b.id}/approve`, OWNER, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${a.id}/approve`, OWNER, {})).status).toBe(409);
    expect((await api(f.id, "/packets/one/claim", token, data, "DELETE")).status).toBe(200);
    expect((await state(f.id)).races[0]!.entrants).toEqual(closed);
    expect(await releases(f.id)).toHaveLength(1);
    expect((await claim(f.id, f.alpha)).status).toBe(409);
    expect((await claim(f.id, f.tokens[3]!)).status).toBe(409);
    await mutate(f.id, async (_instance, objectState) => {
      expect(await objectState.storage.get("entrant:one:alpha")).toBeDefined();
      expect((await openEntrants(objectState.storage, "one")).map(e => e.agent)).toEqual(["beta", "gamma"]);
    });
  });

  it("records each entrant's commit, review, passing receipt, approval and promote milestones independently", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    const body = { packet: "one", message: "Fixture change", files: [{ path: "src/index.ts", content: "fixture" }] };
    expect((await api(f.id, `/forks/${f.a}/commit`, f.beta, body)).status).toBe(403);
    expect((await api(f.id, `/forks/${f.a}/commit`, f.alpha, { ...body, files: [{ path: "outside", content: "fixture" }] })).status).toBe(403);
    expect((await api(f.id, `/forks/${f.a}/commit`, f.alpha, body)).status).toBe(201);
    const pushed = (await state(f.id)).races[0]!.entrants[0]!.firstPushAt;
    expect(pushed).toEqual(expect.any(String));
    const a = await review(f.id, f.alpha, f.a);
    const race = (await state(f.id)).races[0]!;
    expect(race.entrants[0]).toMatchObject({ firstPushAt: pushed, reviewRequestedAt: a.createdAt,
      receiptPassedAt: expect.any(String), approvedAt: expect.any(String), promotedAt: null });
    expect(race.entrants[1]).toMatchObject({ firstPushAt: null, reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null });
    expect((await api(f.id, `/reviews/${a.id}/promote`, OWNER, {})).status).toBe(200);
    const promoted = (await state(f.id)).races[0]!;
    expect(promoted.entrants[0]).toMatchObject({ promotedAt: expect.any(String), closedAt: null, place: null });
    expect(promoted.entrants[1]!.promotedAt).toBeNull();
    expect(promoted.status).toBe("open"); // FH-053 owns finish, closure and placings.
    expect((await state(f.id)).ledger).toHaveLength(1);
  });

  it("resolves each caller's entrant during competing approvals and promotions", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    const a = await review(f.id, f.alpha, f.a);
    const b = await review(f.id, f.beta, f.b, "one", "b".repeat(40));
    const responses = await Promise.all([a, b].map(r => api(f.id, `/reviews/${r.id}/promote`, OWNER, {})));
    expect(responses.map(r => r.status).toSorted()).toEqual([200, 409]);
    const snapshot = await state(f.id);
    const winner = snapshot.reviews.find(r => r.promoted)!;
    expect(snapshot.ledger).toHaveLength(1);
    expect(snapshot.races[0]!.entrants.filter(e => e.promotedAt !== null).map(e => e.agent)).toEqual([winner.agent]);
    expect(snapshot.races[0]!.entrants.every(e => e.closedAt === null && e.place === null)).toBe(true);
  });

  it("uses caller-owned race entries for /me with the existing next-step rules", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    const work = async (token: string) => (await (await api(f.id, "/me", token)).json<{ work: WorkItem[] }>()).work;
    expect(await work(f.alpha)).toMatchObject([{ repoName: f.a, next: "push" }]);
    expect(await work(f.beta)).toMatchObject([{ repoName: f.b, next: "push" }]);
    const a = await review(f.id, f.alpha, f.a);
    expect(await work(f.alpha)).toMatchObject([{ repoName: f.a, next: "wait_for_owner", review: { id: a.id } }]);
    await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE");
    expect(await work(f.alpha)).toEqual([]);
    expect(await work(f.beta)).toMatchObject([{ repoName: f.b, next: "push" }]);
  });

  it("exempts same-race bound forks from blockers but preserves outsider and out-of-race collisions", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts"]; });
    await stub(f.id).recordPush(push(f.a));
    expect((await state(f.id)).blockers).toEqual([]);
    expect((await state(f.id)).races[0]!.entrants[0]!.firstPushAt).toEqual(expect.any(String));
    expect((await state(f.id)).races[0]!.entrants[1]!.firstPushAt).toBeNull();
    await stub(f.id).recordPush(push(`${f.id}--gamma-1`));
    expect((await state(f.id)).blockers.map(b => b.claimingAgent).toSorted()).toEqual(["alpha", "beta"]);
    await packet(f.id, "docs", ["docs"], "standard");
    await claim(f.id, f.tokens[2]!, "docs");
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts", "docs/file.md"]; });
    await stub(f.id).recordPush(push(f.b));
    expect((await state(f.id)).blockers.filter(b => b.pushingAgent === "beta")).toMatchObject([{ packet: "docs", claimingAgent: "gamma" }]);
    // The same agent pushing an unbound second fork has no same-race exemption.
    await api(f.id, "/join", f.alpha, { agent: "alpha" });
    await stub(f.id).recordPush(push(`${f.id}--alpha-2`));
    expect((await state(f.id)).blockers.some(b => b.repoName === `${f.id}--alpha-2` && b.claimingAgent === "beta")).toBe(true);
  });

  it("keeps race collision keys distinct from standard packets containing the entrant's name", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await packet(f.id, "one-alpha", ["src"], "standard");
    expect((await claim(f.id, f.alpha, "one-alpha")).status).toBe(201);
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts"]; });
    await stub(f.id).recordPush(push(f.b));
    const blockers = (await state(f.id)).blockers;
    expect(blockers.map(b => b.packet).toSorted()).toEqual(["one", "one-alpha"]);
    expect(new Set(blockers.map(b => b.id)).size).toBe(2);
    expect(blockers.find(b => b.packet === "one-alpha")?.id).toBe("1-one-alpha");
  });

  it.each([0, 1, 2])("includes race entries in unique pushing-packet attribution (%s bindings)", async count => {
    const f = await fixture();
    await packet(f.id, "target", ["src"], "standard");
    await claim(f.id, f.tokens[2]!, "target");
    await packet(f.id, "one", ["docs"]);
    if (count >= 1) await claim(f.id, f.alpha);
    if (count >= 2) {
      await packet(f.id, "another", ["config"], "standard");
      await claim(f.id, f.alpha, "another");
    }
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts"]; });
    await stub(f.id).recordPush(push(f.a));
    expect((await state(f.id)).blockers).toMatchObject([{
      packet: "target", claimingAgent: "gamma", pushingAgent: "alpha", repoName: f.a,
      pushingPacket: count === 1 ? "one" : null, resolved: null,
    }]);
  });

  it("gates only the race entrant that trespasses and resolves only that pusher's collisions on close", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    await packet(f.id, "target", ["docs"], "standard");
    await claim(f.id, f.tokens[2]!, "target");
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts", "docs/file.md"]; });
    await stub(f.id).recordPush(push(f.a));
    const a = await review(f.id, f.alpha, f.a, "one", AFTER, false);
    const b = await review(f.id, f.beta, f.b);
    const claimant = await review(f.id, f.tokens[2]!, `${f.id}--gamma-1`, "target");
    const original = (await state(f.id)).blockers[0]!;
    expect(original).toMatchObject({ packet: "target", pushingPacket: "one", repoName: f.a, resolved: null });
    for (const operation of ["approve", "promote"])
      expect((await api(f.id, `/reviews/${a.id}/${operation}`, OWNER, {})).status).toBe(409);
    expect((await api(f.id, `/reviews/${b.id}/approve`, OWNER, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${claimant.id}/approve`, OWNER, {})).status).toBe(200);
    await api(f.id, "/packets/one/claim", OWNER, { agent: "beta" }, "DELETE");
    expect((await state(f.id)).blockers[0]).toEqual(original);
    expect((await api(f.id, `/reviews/${a.id}/approve`, OWNER, {})).status).toBe(409);
    await api(f.id, "/packets/one/claim", OWNER, { agent: "alpha" }, "DELETE");
    const snapshot = await state(f.id);
    const closed = snapshot.races[0]!.entrants.find(e => e.agent === "alpha")!;
    expect(snapshot.blockers[0]).toMatchObject({ ...original, resolved: { by: "release", at: closed.closedAt } });
  });

  it("keeps all three claimant collisions distinct and the outsider gated until the last claimant closes", async () => {
    const f = await fixture();
    await packet(f.id);
    for (const token of f.tokens.slice(0, 3)) await claim(f.id, token);
    await packet(f.id, "outside", ["docs"], "standard");
    await claim(f.id, f.tokens[3]!, "outside");
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["src/index.ts"]; });
    await stub(f.id).recordPush(push(`${f.id}--delta-1`));
    const outsider = await review(f.id, f.tokens[3]!, `${f.id}--delta-1`, "outside", AFTER, false);
    const original = (await state(f.id)).blockers;
    expect(original).toHaveLength(3);
    expect(new Set(original.map(b => b.id)).size).toBe(3);
    expect(original.every(b => b.pushingPacket === "outside")).toBe(true);
    for (const [index, agent] of ["alpha", "beta", "gamma"].entries()) {
      expect((await api(f.id, `/reviews/${outsider.id}/approve`, OWNER, {})).status).toBe(409);
      expect((await api(f.id, "/packets/one/claim", f.tokens[index]!, undefined, "DELETE")).status).toBe(200);
      const blockers = (await state(f.id)).blockers;
      expect(blockers.find(b => b.claimingAgent === agent)?.resolved?.by).toBe("release");
      expect(blockers.filter(b => !b.resolved)).toHaveLength(2 - index);
    }
    expect((await api(f.id, `/reviews/${outsider.id}/approve`, OWNER, {})).status).toBe(200);
  });

  it("preserves FH-048's fork-wide gate for ambiguous race plus standard bindings until owner resolution", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    await packet(f.id, "another", ["config"], "standard");
    await claim(f.id, f.alpha, "another");
    await packet(f.id, "target", ["docs"], "standard");
    await claim(f.id, f.tokens[2]!, "target");
    await mutate(f.id, instance => { instance.fixture.changedPaths = ["docs/file.md"]; });
    await stub(f.id).recordPush(push(f.a));
    const a = await review(f.id, f.alpha, f.a, "one", AFTER, false);
    const another = await review(f.id, f.alpha, f.a, "another", AFTER, false);
    const blocker = (await state(f.id)).blockers[0]!;
    expect(blocker.pushingPacket).toBeNull();
    for (const requested of [a, another])
      expect((await api(f.id, `/reviews/${requested.id}/approve`, OWNER, {})).status).toBe(409);
    await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE");
    expect((await state(f.id)).blockers[0]?.resolved).toBeNull();
    expect((await api(f.id, `/reviews/${another.id}/approve`, OWNER, {})).status).toBe(409);
    expect((await api(f.id, `/blockers/${blocker.id}/resolve`, OWNER, { reason: "Coordinated the collision." })).status).toBe(200);
    expect((await api(f.id, `/reviews/${another.id}/approve`, OWNER, {})).status).toBe(200);
  });

  it("rolls back entrant closure with its review and audit, and fences uncertain promotions", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await review(f.id, f.alpha, f.a);
    const before = await state(f.id);
    await mutate(f.id, (_instance, objectState) => {
      const transaction = objectState.storage.transaction.bind(objectState.storage);
      vi.spyOn(objectState.storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("claimRelease:"))
            throw new Error("Offline audit failure");
        });
        return callback(txn);
      }));
    });
    try {
      expect((await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE")).status).toBe(502);
      expect((await state(f.id)).races).toEqual(before.races);
      expect((await state(f.id)).reviews).toEqual(before.reviews);
      expect(await releases(f.id)).toEqual([]);
    } finally { vi.restoreAllMocks(); }
    await mutate(f.id, async (_instance, objectState) => { await objectState.storage.put("promotionPending", { review: "fixture" }); });
    for (const token of [f.alpha, OWNER])
      expect((await api(f.id, "/packets/one/claim", token, { agent: "alpha" }, "DELETE")).status).toBe(409);
    expect((await state(f.id)).races).toEqual(before.races);
  });

  it.each(["release", "generation"] as const)("rejects an entrant's late receipt after %s without affecting a peer", async reason => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    let unblock!: () => void;
    await mutate(f.id, instance => {
      instance.receiptBarrier = new Promise<void>(resolve => { unblock = resolve; });
      instance.fixture.heads.set(f.a, AFTER);
    });
    const response = await api(f.id, "/reviews", f.alpha, { packet: "one", repoName: f.a, sha: AFTER });
    const a = (await response.json<{ review: Review }>()).review;
    if (reason === "release") await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE");
    else await mutate(f.id, async (_instance, objectState) => {
      const current = (await objectState.storage.get<Review>(`review:${a.id}`))!;
      await objectState.storage.put(`review:${a.id}`, { ...current, receiptGeneration: "superseded" });
    });
    await mutate(f.id, async (instance, objectState) => {
      unblock();
      instance.receiptBarrier = undefined;
      for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect((await objectState.storage.get<Review>(`review:${a.id}`))!.receiptDigest).toBeNull();
    });
    await review(f.id, f.beta, f.b);
    const records = (await state(f.id)).races[0]!.entrants;
    expect(records[0]!.receiptPassedAt).toBeNull();
    expect(records[1]!.receiptPassedAt).toEqual(expect.any(String));
  });

  it("keeps failed checks out of the passing milestone and preserves first milestones on later reviews", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    await mutate(f.id, instance => { instance.receiptExitStatus = 1; });
    const first = await review(f.id, f.alpha, f.a, "one", AFTER, false);
    expect((await state(f.id)).races[0]!.entrants[0]!.receiptPassedAt).toBeNull();
    await mutate(f.id, instance => { instance.receiptExitStatus = 0; });
    await review(f.id, f.alpha, f.a);
    const passed = (await state(f.id)).races[0]!.entrants[0]!;
    expect(passed.reviewRequestedAt).toBe(first.createdAt);
    expect(passed.receiptPassedAt).toEqual(expect.any(String));
    await review(f.id, f.alpha, f.a);
    expect((await state(f.id)).races[0]!.entrants[0]).toEqual(passed);
  });

  it("ignores pre-claim and non-default pushes for milestones and never rewrites the first observed push", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const old = push(f.a);
    old.metadata.eventTimestamp = "2026-01-01T00:00:00Z";
    await stub(f.id).recordPush(old);
    await stub(f.id).recordPush(push(f.a, BEFORE, AFTER, "refs/heads/other"));
    expect((await state(f.id)).races[0]!.entrants[0]!.firstPushAt).toBeNull();
    const first = push(f.a, AFTER, BEFORE);
    await stub(f.id).recordPush(first);
    expect((await state(f.id)).races[0]!.entrants[0]!.firstPushAt).toBe(first.metadata.eventTimestamp);
    const later = push(f.a, BEFORE, AFTER);
    await stub(f.id).recordPush(later);
    expect((await state(f.id)).races[0]!.entrants[0]!.firstPushAt).toBe(first.metadata.eventTimestamp);
  });

  it("records enrollment timestamps, preserves them on rotation, and never backfills legacy agents", async () => {
    const f = await fixture();
    const initial = (await state(f.id)).agents;
    expect(initial).toHaveLength(4);
    for (const agent of initial) expect(agent.createdAt).toEqual(expect.any(String));
    expect(new Set(initial.map(agent => agent.createdAt)).size).toBe(1);
    await api(f.id, "/agents/alpha/rotate", OWNER, {});
    expect((await state(f.id)).agents).toEqual(initial);
    expect((await api(f.id, "/agents", OWNER, { agent: "new-agent" })).status).toBe(201);
    expect((await state(f.id)).agents.find(a => a.name === "new-agent")?.createdAt).toEqual(expect.any(String));
    await mutate(f.id, async (_instance, objectState) => {
      const agent = (await objectState.storage.get<Record<string, unknown>>("agent:beta"))!;
      delete agent.createdAt;
      await objectState.storage.put("agent:beta", agent);
    });
    await api(f.id, "/agents/beta/rotate", OWNER, {});
    expect((await state(f.id)).agents.find(a => a.name === "beta")).toEqual({ name: "beta", createdAt: null });
    expect(JSON.stringify((await state(f.id)).agents)).not.toContain("seq");
  });
});
