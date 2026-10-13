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
  RaceEntrant,
  RaceResult,
  WorkItem,
  Fork,
  LedgerEntry,
  ReconcilerAlert,
  Review,
} from "../src/workflow-types";
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

const promote = (id: string, reviewId: string) => api(id, `/reviews/${reviewId}/promote`, OWNER, {});
async function start(count = 3) {
  const f = await fixture();
  await packet(f.id);
  for (const token of f.tokens.slice(0, count)) expect((await claim(f.id, token)).status).toBe(201);
  return f;
}
async function patchEntrant(id: string, agent: string, patch: Partial<RaceEntrant>) {
  await mutate(id, async (_instance, objectState) => {
    const key = `entrant:one:${agent}`;
    const entrant = (await objectState.storage.get<RaceEntrant>(key))!;
    await objectState.storage.put(key, { ...entrant, ...patch });
  });
}

// Real workerd Durable Objects; Git, Artifacts and container execution are OFFLINE fixtures.
describe("FH-053 race finish", () => {
  it.each([2, 3])("finishes a %i-way race, links the ledger, releases claims and refuses later entrants", async count => {
    const f = await start(count);
    const a = await review(f.id, f.alpha, f.a);
    const sibling = await review(f.id, f.alpha, f.a);
    const b = await review(f.id, f.beta, f.b, "one", "b".repeat(40));
    expect((await promote(f.id, a.id)).status).toBe(200);
    const snapshot = await state(f.id), race = snapshot.races[0]!;
    const ledger = snapshot.ledger[0]!;
    expect(race).toMatchObject({ status: "finished", winner: "alpha", finishedAt: expect.any(String),
      ledgerEntryId: ledger.id, places: [{ agent: "alpha", place: 1 }, { agent: "beta", place: 2 },
        ...(count === 3 ? [{ agent: "gamma", place: 3 }] : [])] });
    expect(typeof race.ledgerEntryId).toBe("string");
    expect(Date.parse(race.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(ledger.recordedAt));
    expect(snapshot.ledger).toHaveLength(1);
    expect(ledger).toMatchObject({ race: "one", review: a.id, before: BEFORE, after: AFTER });
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.promotionPending).toBeNull();
    expect(race.entrants).toHaveLength(count);
    for (const entrant of race.entrants) expect(entrant).toMatchObject({
      place: entrant.agent === "alpha" ? 1 : entrant.agent === "beta" ? 2 : 3,
      closedAt: race.finishedAt, closedBy: "race-finished", promoteRejected: null,
      promotedAt: entrant.agent === "alpha" ? race.finishedAt : null,
    });
    expect(snapshot.reviews.find(r => r.id === a.id)).toMatchObject({ promoted: true, stale: false });
    for (const other of [sibling, b])
      expect(snapshot.reviews.find(r => r.id === other.id)).toMatchObject({ promoted: false, stale: true });
    const audits = await releases(f.id);
    expect(audits).toHaveLength(count);
    expect(audits.find(audit => audit.agent === "alpha")).toMatchObject({ releasedBy: "promote", review: a.id });
    for (const audit of audits.filter(item => item.agent !== "alpha"))
      expect(audit).toMatchObject({ releasedBy: "race-finished", recordedAt: race.finishedAt });
    await mutate(f.id, async (_instance, objectState) => {
      expect(await openEntrants(objectState.storage, "one")).toEqual([]);
      expect(await objectState.storage.get<RaceResult>("race:one")).toEqual({
        winner: race.winner, places: race.places, finishedAt: race.finishedAt, ledgerEntryId: ledger.id,
      });
    });
    for (const token of [f.alpha, f.beta, f.tokens[3]!]) {
      const refused = await claim(f.id, token);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "Race finished." });
    }
    for (const token of [f.alpha, f.beta])
      expect((await (await api(f.id, "/me", token)).json<{ work: WorkItem[] }>()).work).toEqual([]);
    await api(f.id, "/packets/one/claim", OWNER, { agent: "beta" }, "DELETE");
    expect((await promote(f.id, a.id)).status).toBe(409);
    expect(await releases(f.id)).toEqual(audits);
    expect((await state(f.id)).races).toEqual(snapshot.races);
  });

  it("photo finish: two approved reviews yield one winner and a first-only rejection for second place", async () => {
    const f = await start(2);
    const reviews = [await review(f.id, f.alpha, f.a), await review(f.id, f.beta, f.b, "one", "b".repeat(40))];
    const responses = await Promise.all(reviews.map(r => promote(f.id, r.id)));
    expect(responses.map(r => r.status).toSorted()).toEqual([200, 409]);
    const loserIndex = responses.findIndex(r => r.status === 409), loser = reviews[loserIndex]!;
    expect(await responses[loserIndex]!.json()).toEqual({ error: "stale base, rebase" });
    const snapshot = await state(f.id), race = snapshot.races[0]!;
    const winner = reviews.find(r => r.agent !== loser.agent)!;
    expect(race.winner).toBe(winner.agent);
    expect(race.places).toEqual([{ agent: winner.agent, place: 1 }, { agent: loser.agent, place: 2 }]);
    const rejection = race.entrants.find(e => e.agent === loser.agent)!.promoteRejected;
    expect(rejection).toEqual({ at: expect.any(String), expected: loser.base, found: winner.sha });
    // A later canonical head and a repeated request cannot rewrite the photo finish.
    await mutate(f.id, instance => { instance.fixture.heads.set(f.id, "e".repeat(40)); });
    const repeated = await promote(f.id, loser.id);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toEqual({ error: "stale base, rebase" });
    expect((await state(f.id)).races).toEqual(snapshot.races);
    expect((await state(f.id)).ledger).toEqual(snapshot.ledger);
  });

  it.each([
    ["firstPushAt", "createdAt"], ["reviewRequestedAt", "firstPushAt"],
    ["receiptPassedAt", "reviewRequestedAt"], ["approvedAt", "receiptPassedAt"],
  ] as const)("places %s ahead of %s regardless of the earlier lower milestone", async (higher, lower) => {
    const f = await start();
    const a = await review(f.id, f.alpha, f.a);
    await patchEntrant(f.id, "beta", { [lower]: "2026-01-01T00:00:00.000Z" });
    await patchEntrant(f.id, "gamma", { [higher]: "2026-01-02T00:00:00.000Z" });
    expect((await promote(f.id, a.id)).status).toBe(200);
    expect((await state(f.id)).races[0]!.places).toEqual([
      { agent: "alpha", place: 1 }, { agent: "gamma", place: 2 }, { agent: "beta", place: 3 },
    ]);
  });

  it.each(["createdAt", "firstPushAt", "reviewRequestedAt", "receiptPassedAt", "approvedAt"] as const)(
    "breaks ties by the earliest time at %s, then agent name for exact ties", async milestone => {
      const f = await start();
      const a = await review(f.id, f.alpha, f.a);
      await patchEntrant(f.id, "beta", { [milestone]: "2026-01-01T00:00:02.000Z" });
      await patchEntrant(f.id, "gamma", { [milestone]: "2026-01-01T00:00:01.000Z" });
      expect((await promote(f.id, a.id)).status).toBe(200);
      expect((await state(f.id)).races[0]!.places.map(p => p.agent)).toEqual(["alpha", "gamma", "beta"]);
      const tied = await start();
      const winner = await review(tied.id, tied.alpha, tied.a);
      for (const agent of ["beta", "gamma"])
        await patchEntrant(tied.id, agent, { [milestone]: "2026-01-01T00:00:01.000Z" });
      expect((await promote(tied.id, winner.id)).status).toBe(200);
      expect((await state(tied.id)).races[0]!.places.map(p => p.agent)).toEqual(["alpha", "beta", "gamma"]);
    },
  );

  it.each(["release", "owner"] as const)("ranks a previous %s behind running entrants and preserves withdrawal history", async closedBy => {
    const f = await start();
    const a = await review(f.id, f.alpha, f.a);
    await review(f.id, f.beta, f.b);
    await api(f.id, "/packets/one/claim", closedBy === "owner" ? OWNER : f.beta, { agent: "beta" }, "DELETE");
    const before = (await state(f.id)).races[0]!.entrants.find(e => e.agent === "beta")!;
    const audit = (await releases(f.id))[0]!;
    expect((await promote(f.id, a.id)).status).toBe(200);
    const race = (await state(f.id)).races[0]!;
    expect(race.places.map(p => p.agent)).toEqual(["alpha", "gamma", "beta"]);
    expect(race.entrants.find(e => e.agent === "beta")).toEqual({ ...before, place: 3 });
    expect(before.closedBy).toBe(closedBy);
    expect((await releases(f.id)).find(item => item.agent === "beta")).toEqual(audit);
  });

  it.each(["preflight", "after-prepare", "transport-cas"] as const)("records a %s miss without finishing or releasing the race", async stage => {
    const f = await start(2);
    const a = await review(f.id, f.alpha, f.a);
    const found = "f".repeat(40);
    await mutate(f.id, instance => {
      if (stage === "preflight") instance.fixture.heads.set(f.id, found);
      if (stage === "transport-cas") instance.gitFixture.raceBeforePush = true;
      if (stage === "after-prepare") {
        const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
        vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
          const prepared = await prepare(...args);
          instance.fixture.heads.set(f.id, found);
          return prepared;
        });
      }
    });
    try {
      const response = await promote(f.id, a.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "stale base, rebase" });
      const snapshot = await state(f.id), race = snapshot.races[0]!;
      expect(race).toMatchObject({ status: "open", winner: null, places: [], ledgerEntryId: null });
      expect(race.entrants.find(e => e.agent === "alpha")).toMatchObject({
        promoteRejected: { at: expect.any(String), expected: BEFORE, found }, closedAt: null, place: null,
      });
      await mutate(f.id, async (_instance, objectState) => {
        expect(await openEntrants(objectState.storage, "one")).toHaveLength(2);
      });
      expect(snapshot.ledger).toEqual([]);
      expect(snapshot.promotionPending).toBeNull();
      expect(await releases(f.id)).toEqual([]);
      await mutate(f.id, instance => {
        expect(instance.gitFixture.pushes).toEqual([]);
        expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id && c.scope === "write"))
          .toHaveLength(stage === "transport-cas" ? 1 : 0);
      });
    } finally { vi.restoreAllMocks(); }
  });

  it.each(["claimRelease:", "race:"])("rolls back every finish write on %s failure and retains the uncertain-push fence", async prefix => {
    const f = await start();
    const a = await review(f.id, f.alpha, f.a);
    await review(f.id, f.beta, f.b);
    const before = await state(f.id);
    await mutate(f.id, (_instance, objectState) => {
      const transaction = objectState.storage.transaction.bind(objectState.storage);
      vi.spyOn(objectState.storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith(prefix)) throw new Error("Offline finish write failure");
        });
        return callback(txn);
      }));
    });
    try {
      expect((await promote(f.id, a.id)).status).toBe(502);
      const snapshot = await state(f.id);
      expect(snapshot.races).toEqual(before.races);
      expect(snapshot.claims).toEqual(before.claims);
      expect(snapshot.reviews).toEqual(before.reviews);
      expect(snapshot.ledger).toEqual([]);
      expect(snapshot.promotionPending).toMatchObject({ review: a.id, race: "one" });
      expect(await releases(f.id)).toEqual([]);
      expect((await promote(f.id, a.id)).status).toBe(409);
      await mutate(f.id, async (instance, objectState) => {
        expect(instance.fixture.heads.get(f.id)).toBe(AFTER);
        expect(await objectState.storage.get("race:one")).toBeUndefined();
      });
    } finally { vi.restoreAllMocks(); }
  });

  it("keeps the definite 409 when separate rejection persistence fails", async () => {
    const f = await start(2);
    const a = await review(f.id, f.alpha, f.a);
    const b = await review(f.id, f.beta, f.b);
    expect((await promote(f.id, a.id)).status).toBe(200);
    const before = await state(f.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mutate(f.id, (_instance, objectState) => {
      vi.spyOn(objectState.storage, "transaction").mockRejectedValueOnce(new Error("Offline diagnostic write failure"));
    });
    try {
      const refused = await promote(f.id, b.id);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "stale base, rebase" });
      expect((await state(f.id)).races).toEqual(before.races);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "race.promote-rejection-unrecorded" }));
    } finally { vi.restoreAllMocks(); }
  });

  it("does not record approval or ancestry refusals as canonical CAS misses", async () => {
    const f = await start(2);
    const a = await review(f.id, f.alpha, f.a, "one", BEFORE, false);
    expect((await promote(f.id, a.id)).status).toBe(409);
    expect((await api(f.id, `/reviews/${a.id}/approve`, OWNER, {})).status).toBe(200);
    // Fixture preparePromote refuses a no-op SHA == base, without a canonical race.
    expect((await promote(f.id, a.id)).status).toBe(409);
    expect((await state(f.id)).races[0]!.entrants.every(e => e.promoteRejected === null)).toBe(true);
    expect(await releases(f.id)).toEqual([]);
  });

  it("keeps uncertain transport failures fenced without a finish or photo-finish rejection", async () => {
    const f = await start(2);
    const a = await review(f.id, f.alpha, f.a);
    const before = await state(f.id);
    await mutate(f.id, instance => { instance.gitFixture.failPush = true; });
    expect((await promote(f.id, a.id)).status).toBe(502);
    const snapshot = await state(f.id);
    expect(snapshot.races).toEqual(before.races);
    expect(snapshot.ledger).toEqual([]);
    expect(snapshot.promotionPending).toMatchObject({ review: a.id, race: "one" });
    expect(await releases(f.id)).toEqual([]);
  });

  it("limits release, review staleness and blocker resolution to the finished race's bindings", async () => {
    const f = await start(2);
    await packet(f.id, "other", ["docs/**"], "race");
    await packet(f.id, "standard", ["tests/**"], "standard");
    await claim(f.id, f.tokens[2]!, "other");
    await claim(f.id, f.beta, "standard");
    const a = await review(f.id, f.alpha, f.a);
    await review(f.id, f.beta, f.b);
    const other = await review(f.id, f.tokens[2]!, `${f.id}--gamma-1`, "other");
    const standard = await review(f.id, f.beta, f.b, "standard");
    // Bounded fixtures: these collisions do not block the winning alpha review.
    const makeBlocker = (id: string, packetId: string, claimingAgent: string, pushingPacket: string | null): Blocker => ({
      id, packet: packetId, claimingAgent, pushingAgent: "delta", repoName: `${f.id}--delta-1`,
      pushingPacket, paths: ["src/index.ts"], sha: AFTER, at: null, resolved: null,
    });
    const within = makeBlocker("within", "one", "beta", null);
    const elsewhere = makeBlocker("elsewhere", "other", "gamma", null);
    await mutate(f.id, async (_instance, objectState) => {
      await objectState.storage.put({ "blocker:within": within, "blocker:elsewhere": elsewhere });
    });
    const before = await state(f.id);
    expect((await promote(f.id, a.id)).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.claims.map(c => c.packet)).toEqual(["standard"]);
    await mutate(f.id, async (_instance, objectState) => {
      expect((await openEntrants(objectState.storage)).map(e => e.packet)).toEqual(["other"]);
    });
    expect(snapshot.races.find(r => r.packet === "other")).toEqual(before.races.find(r => r.packet === "other"));
    for (const requested of [other, standard])
      expect(snapshot.reviews.find(r => r.id === requested.id)).toEqual(before.reviews.find(r => r.id === requested.id));
    expect(snapshot.blockers.find(b => b.id === "within")?.resolved).toMatchObject({ by: "race-finished" });
    expect(snapshot.blockers.find(b => b.id === "elsewhere")).toEqual(elsewhere);
  });

  it("allows only the winning review's late advisory receipt without changing final placings", async () => {
    const f = await start(2);
    let unblock!: () => void;
    await mutate(f.id, instance => {
      instance.receiptBarrier = new Promise<void>(resolve => { unblock = resolve; });
      instance.fixture.heads.set(f.a, AFTER);
      instance.fixture.heads.set(f.b, "b".repeat(40));
    });
    const reviews: Review[] = [];
    for (const [token, repoName, sha] of [[f.alpha, f.a, AFTER], [f.beta, f.b, "b".repeat(40)]]) {
      const response = await api(f.id, "/reviews", token, { packet: "one", repoName, sha });
      expect(response.status).toBe(201);
      const r = (await response.json<{ review: Review }>()).review;
      reviews.push(r);
      expect((await api(f.id, `/reviews/${r.id}/approve`, OWNER, {})).status).toBe(200);
    }
    try {
      expect((await promote(f.id, reviews[0]!.id)).status).toBe(200);
      const before = await state(f.id);
      await mutate(f.id, async (_instance, objectState) => {
        unblock();
        for (let i = 0; i < 100; i++) {
          if ((await objectState.storage.get<Review>(`review:${reviews[0]!.id}`))?.receiptDigest) break;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      });
      const after = await state(f.id);
      expect(after.reviews.find(r => r.id === reviews[0]!.id)?.receipt?.status).toBe("passed");
      expect(after.reviews.find(r => r.id === reviews[1]!.id)?.receiptDigest).toBeNull();
      expect(after.races).toEqual(before.races);
    } finally { unblock(); }
  });

  it("takes the finish snapshot after push, including milestones reached while Git was in flight", async () => {
    const f = await start();
    const a = await review(f.id, f.alpha, f.a);
    let unblock!: () => void;
    await mutate(f.id, instance => {
      instance.receiptBarrier = new Promise<void>(resolve => { unblock = resolve; });
      instance.fixture.heads.set(f.b, "b".repeat(40));
    });
    const requested = await api(f.id, "/reviews", f.beta, { packet: "one", repoName: f.b, sha: "b".repeat(40) });
    expect(requested.status).toBe(201);
    const b = (await requested.json<{ review: Review }>()).review;
    await mutate(f.id, (instance, objectState) => {
      const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
      vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        return { ...prepared, push: async (...pushArgs) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          unblock();
          for (let i = 0; i < 100; i++) {
            if ((await objectState.storage.get<Review>(`review:${b.id}`))?.receiptDigest) break;
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          await prepared.push(...pushArgs);
        } };
      });
    });
    try {
      expect((await promote(f.id, a.id)).status).toBe(200);
      const snapshot = await state(f.id), race = snapshot.races[0]!;
      const passedAt = race.entrants.find(e => e.agent === "beta")!.receiptPassedAt;
      expect(passedAt).toEqual(expect.any(String));
      expect(Date.parse(passedAt!)).toBeGreaterThan(Date.parse(snapshot.ledger[0]!.recordedAt));
      expect(Date.parse(race.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(passedAt!));
      expect(race.places.map(p => p.agent)).toEqual(["alpha", "beta", "gamma"]);
    } finally { unblock(); vi.restoreAllMocks(); }
  });
});
