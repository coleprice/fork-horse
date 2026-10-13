import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Claim, Review, StateSnapshot, UsageSources } from "../src/workflow-types";
import { AFTER } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
const empty = { reported: null, metered: null };
function api(id: string, path: string, token = OWNER, data?: unknown, method?: string) {
  return worker.fetch(new Request(`https://api.idiot.tax/projects/${id}${path}`, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}` },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), env);
}
async function mutate(id: string, callback: (instance: TestSupervisor, state: DurableObjectState) => void | Promise<void>) {
  return runInDurableObject(env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id)), async (instance, state) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected fixture supervisor");
    await callback(instance, state);
  });
}
async function snapshotFor(id: string) { return (await api(id, "/state")).json<StateSnapshot>(); }
async function fixture(mode: "standard" | "race" = "standard", tokenBudget?: number) {
  const id = `usage-${crypto.randomUUID().slice(0, 8)}`;
  await mutate(id, instance => {
    instance.fixture.checks = JSON.stringify([{ name: "fixture", tier: "full", image: "default", run: "true" }]);
  });
  const created = await worker.fetch(new Request("https://api.idiot.tax/projects", {
    method: "POST", headers: { authorization: `Bearer ${OWNER}` },
    body: JSON.stringify({ id, agents: ["alpha", "beta"], requireReceipt: false }),
  }), env);
  expect(created.status).toBe(201);
  const { agents } = await created.json<{ agents: { apiToken: string }[] }>();
  const alpha = agents[0]!.apiToken, beta = agents[1]!.apiToken;
  for (const [agent, token] of [["alpha", alpha], ["beta", beta]] as const)
    expect((await api(id, "/join", token, { agent })).status).toBe(201);
  expect((await api(id, "/packets", OWNER, {
    id: "one", mode, tokenBudget, title: "Fixture", goal: "Test usage", paths: ["src/**"], acceptance: ["Fixture"],
  })).status).toBe(201);
  expect((await api(id, "/packets/one/claim", alpha, {})).status).toBe(201);
  return { id, alpha, beta, repoName: `${id}--alpha-1` };
}
const report = (id: string, token: string, inputTokens: number, outputTokens: number, model?: string) =>
  api(id, "/usage", token, { packet: "one", inputTokens, outputTokens, model });
async function review(f: Awaited<ReturnType<typeof fixture>>) {
  await mutate(f.id, instance => { instance.fixture.heads.set(f.repoName, AFTER); });
  const response = await api(f.id, "/reviews", f.alpha, { packet: "one", repoName: f.repoName, sha: AFTER });
  expect(response.status).toBe(201);
  const result = (await response.json<{ review: Review }>()).review;
  // Drain the explicitly mocked background receipt before checking immutable history.
  await mutate(f.id, async (_instance, state) => {
    for (let i = 0; i < 100; i++) {
      if ((await state.storage.get<Review>(`review:${result.id}`))?.receipt?.status !== "running") return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Fixture receipt did not settle");
  });
  expect((await api(f.id, `/reviews/${result.id}/approve`, OWNER, {})).status).toBe(200);
  return result;
}

// Real workerd HTTP routing and Durable Objects; Artifacts, Git and containers are OFFLINE fixtures.
describe("FH-060 usage and race token budgets", () => {
  it.each(["standard", "race"] as const)("records caller-bound cumulative %s usage and rejects decreases independently", async mode => {
    const f = await fixture(mode);
    expect((await report(f.id, f.alpha, 0, 0)).status).toBe(200);
    const response = await report(f.id, f.alpha, 10, 20, "fixture-model");
    expect(response.status).toBe(200);
    const { usage } = await response.json<{ usage: UsageSources }>();
    expect(usage).toEqual({ reported: {
      inputTokens: 10, outputTokens: 20, model: "fixture-model", source: "reported", at: expect.any(String),
    }, metered: null });
    expect(Number.isNaN(Date.parse(usage.reported!.at))).toBe(false);
    for (const [input, output] of [[9, 21], [11, 19]]) {
      const refused = await report(f.id, f.alpha, input!, output!);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "Reported token counts may not decrease." });
    }
    const snapshot = await snapshotFor(f.id);
    expect((mode === "race" ? snapshot.races[0]!.entrants[0] : snapshot.claims[0])!.usage).toEqual(usage);
    expect((await report(f.id, f.alpha, 10, 20)).status).toBe(200);
    expect((await report(f.id, f.alpha, 1_000_000_000, 1_000_000_000)).status).toBe(200);
  });

  it("validates counts/model, refuses authority spoofing, and exposes POST only", async () => {
    const f = await fixture();
    for (const value of [-1, 0.5, 1_000_000_001, "1", null]) {
      for (const key of ["inputTokens", "outputTokens"])
        expect((await api(f.id, "/usage", f.alpha, { packet: "one", inputTokens: 0, outputTokens: 0, [key]: value })).status).toBe(400);
    }
    for (const model of [null, 1, "", " ", "x".repeat(201)])
      expect((await api(f.id, "/usage", f.alpha, { packet: "one", inputTokens: 0, outputTokens: 0, model })).status).toBe(400);
    for (const extra of [{ source: "metered" }, { agent: "beta" }, { at: "2026-01-01" }, { repoName: f.repoName }])
      expect((await api(f.id, "/usage", f.alpha, { packet: "one", inputTokens: 0, outputTokens: 0, ...extra })).status).toBe(400);
    expect((await api(f.id, "/usage", f.alpha, { packet: "one", inputTokens: 0 })).status).toBe(400);
    expect((await api(f.id, "/usage", f.alpha)).status).toBe(405);
    expect((await report(f.id, OWNER, 0, 0)).status).toBe(403);
    expect((await report(f.id, f.beta, 0, 0)).status).toBe(409);
    expect((await api(f.id, "/usage", f.alpha, { packet: "missing", inputTokens: 0, outputTokens: 0 })).status).toBe(409);
    expect((await snapshotFor(f.id)).claims[0]!.usage).toEqual(empty);
  });

  it.each(["standard", "race"] as const)("snapshots %s usage and retains it after reports and release", async mode => {
    const f = await fixture(mode);
    await report(f.id, f.alpha, 25, 50, "fixture-model");
    const requested = await review(f);
    expect(requested.usageAtReview?.reported?.inputTokens).toBe(25);
    await report(f.id, f.alpha, 50, 100);
    expect((await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE")).status).toBe(200);
    expect((await report(f.id, f.alpha, 100, 100)).status).toBe(409);
    const snapshot = await snapshotFor(f.id);
    expect(snapshot.reviews[0]!.usageAtReview).toEqual(requested.usageAtReview);
    expect(snapshot.claims).toEqual([]);
    if (mode === "race") expect(snapshot.races[0]!.entrants[0]!.usage.reported?.inputTokens).toBe(50);
    else {
      expect((await api(f.id, "/packets/one/claim", f.alpha, {})).status).toBe(201);
      expect((await report(f.id, f.alpha, 0, 0)).status).toBe(200);
      expect((await snapshotFor(f.id)).reviews[0]!.usageAtReview).toEqual(requested.usageAtReview);
    }
  });

  it("isolates entrants and serializes concurrent cumulative reports", async () => {
    const f = await fixture("race", 100);
    expect((await api(f.id, "/packets/one/claim", f.beta, {})).status).toBe(201);
    await Promise.all([report(f.id, f.alpha, 10, 0), report(f.id, f.alpha, 20, 0)]);
    await report(f.id, f.beta, 5, 0);
    const entrants = (await snapshotFor(f.id)).races[0]!.entrants;
    expect(entrants.find(e => e.agent === "alpha")!.usage.reported!.inputTokens).toBe(20);
    expect(entrants.find(e => e.agent === "beta")!.usage.reported!.inputTokens).toBe(5);
  });

  it("exposes unchecked/within/near/over boundaries using the sum of both counts", async () => {
    const f = await fixture("race", 100);
    expect((await snapshotFor(f.id)).races[0]).toMatchObject({ tokenBudget: 100, entrants: [{ usage: empty, budget: "unchecked" }] });
    for (const [total, budget] of [[0, "within"], [79, "within"], [80, "near"], [100, "near"], [101, "over"]] as const) {
      await report(f.id, f.alpha, Math.floor(total / 2), Math.ceil(total / 2));
      expect((await snapshotFor(f.id)).races[0]!.entrants[0]!.budget).toBe(budget);
    }
    const small = await fixture("race", 3);
    await report(small.id, small.alpha, 2, 0);
    expect((await snapshotFor(small.id)).races[0]!.entrants[0]!.budget).toBe("within");
    await report(small.id, small.alpha, 3, 0);
    expect((await snapshotFor(small.id)).races[0]!.entrants[0]!.budget).toBe("near");
  });

  it("refuses missing/latest over-budget usage before canonical write tokens or pushes", async () => {
    const f = await fixture("race", 100);
    const requested = await review(f);
    const promote = () => api(f.id, `/reviews/${requested.id}/promote`, OWNER, {});
    const missing = await promote();
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "Report usage first: this race has a token budget." });
    await report(f.id, f.alpha, 101, 0);
    const over = await promote();
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "Over its token budget (reported)." });
    const snapshot = await snapshotFor(f.id);
    expect(snapshot.reviews[0]!.usageAtReview).toEqual(empty);
    expect(snapshot.ledger).toEqual([]);
    expect(snapshot.promotionPending).toBeNull();
    expect(snapshot.races[0]!.status).toBe("open");
    await mutate(f.id, instance => {
      expect(instance.gitFixture.pushes).toEqual([]);
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id && c.scope === "write")).toEqual([]);
    });
  });

  it.each([undefined, 100])("permits promotion at budget %s and retains snapshot after finish", async tokenBudget => {
    const f = await fixture("race", tokenBudget);
    if (tokenBudget) await report(f.id, f.alpha, 50, 50);
    const requested = await review(f);
    expect((await api(f.id, `/reviews/${requested.id}/promote`, OWNER, {})).status).toBe(200);
    const snapshot = await snapshotFor(f.id);
    expect(snapshot.races[0]).toMatchObject({ tokenBudget: tokenBudget ?? null, status: "finished" });
    expect(snapshot.races[0]!.entrants[0]!.budget).toBe(tokenBudget ? "near" : "unchecked");
    expect(snapshot.reviews[0]!.usageAtReview).toEqual(requested.usageAtReview);
    expect((await report(f.id, f.alpha, 100, 100)).status).toBe(409);
  });

  it("prefers future metered evidence for budget evaluation and snapshots both sources", async () => {
    const f = await fixture("race", 100);
    await report(f.id, f.alpha, 101, 0);
    const metered = { inputTokens: 40, outputTokens: 40, source: "metered" as const, at: "2026-01-01T00:00:00.000Z" };
    // Only a storage fixture can set metered usage; no agent API can do so.
    await mutate(f.id, async (_instance, state) => {
      const entrant = (await state.storage.get<Claim>("entrant:one:alpha"))!;
      await state.storage.put("entrant:one:alpha", { ...entrant, usage: { ...entrant.usage, metered } });
    });
    await report(f.id, f.alpha, 102, 0);
    expect((await snapshotFor(f.id)).races[0]!.entrants[0]).toMatchObject({ budget: "near", usage: { metered } });
    const requested = await review(f);
    expect(requested.usageAtReview).toMatchObject({ metered, reported: { inputTokens: 102 } });
    expect((await api(f.id, `/reviews/${requested.id}/promote`, OWNER, {})).status).toBe(200);
  });

  it.each(["standard", "race"] as const)("normalizes legacy %s claims/reviews without rewriting storage", async mode => {
    const f = await fixture(mode);
    const requested = await review(f);
    const key = mode === "race" ? "entrant:one:alpha" : "claim:one";
    await mutate(f.id, async (_instance, state) => {
      const claim = (await state.storage.get<Claim>(key))!;
      delete claim.usage;
      const stored = (await state.storage.get<Review>(`review:${requested.id}`))!;
      delete stored.usageAtReview;
      await state.storage.put({ [key]: claim, [`review:${requested.id}`]: stored });
    });
    const snapshot = await snapshotFor(f.id);
    expect((mode === "race" ? snapshot.races[0]!.entrants[0] : snapshot.claims[0])!.usage).toEqual(empty);
    expect(snapshot.reviews[0]!.usageAtReview).toEqual(empty);
    expect((await (await api(f.id, "/packets/one/claim", f.alpha, {})).json<{ claim: Claim }>()).claim.usage).toEqual(empty);
    await mutate(f.id, async (_instance, state) => {
      expect((await state.storage.get<Claim>(key))!.usage).toBeUndefined();
      expect((await state.storage.get<Review>(`review:${requested.id}`))!.usageAtReview).toBeUndefined();
    });
    expect((await report(f.id, f.alpha, 0, 0)).status).toBe(200);
  });

  it("accepts only positive safe integer race budgets and keeps packet creation immutable", async () => {
    const f = await fixture();
    const fields = { id: "budget", mode: "race", title: "Fixture", goal: "Fixture", paths: ["docs/**"], acceptance: ["Fixture"] };
    for (const tokenBudget of [0, -1, 0.5, null, "100", Number.MAX_SAFE_INTEGER + 1])
      expect((await api(f.id, "/packets", OWNER, { ...fields, tokenBudget })).status).toBe(400);
    for (const mode of [undefined, "standard"])
      expect((await api(f.id, "/packets", OWNER, { ...fields, mode, tokenBudget: 100 })).status).toBe(400);
    expect((await api(f.id, "/packets", OWNER, { ...fields, tokenBudget: 1 })).status).toBe(201);
    expect((await api(f.id, "/packets", OWNER, { ...fields, tokenBudget: 200 })).status).toBe(409);
    expect((await snapshotFor(f.id)).races.find(r => r.packet === "budget")!.tokenBudget).toBe(1);
  });
});
