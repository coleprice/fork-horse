import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { PushEvent } from "../src/types";
import type { RaceVerdict, Review, StateSnapshot } from "../src/workflow-types";
import type { StoredReceipt } from "../../forkhorse-runner/src/types";
import { AFTER, BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
const RACE = "demo-race";
const names = ["alpha", "beta", "gamma", "delta"] as const;
const stub = (id: string) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));

async function api(id: string, path: string, token = OWNER, data?: unknown, method?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.idiot.tax/projects${id ? `/${id}` : ""}${path}`, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function inspect<T>(id: string, fn: (instance: TestSupervisor, state: DurableObjectState) => T | Promise<T>) {
  return runInDurableObject(stub(id), async (instance, state) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected offline fixture supervisor");
    return fn(instance, state);
  });
}

async function snapshot(id: string) {
  const response = await api(id, "/state");
  expect(response.status).toBe(200);
  return response.json<StateSnapshot>();
}

async function requestReview(id: string, token: string, repoName: string, sha: string) {
  const response = await api(id, "/reviews", token, { packet: RACE, repoName, sha });
  expect(response.status, await response.clone().text()).toBe(201);
  const { review } = await response.json<{ review: Review }>();
  await inspect(id, async (_instance, state) => {
    for (let i = 0; i < 200; i++) {
      const current = await state.storage.get<Review>(`review:${review.id}`);
      if (current?.receipt?.status !== "running") {
        expect(current?.receipt).toMatchObject({ status: "passed", checks: [{ tier: "quick", runtime: "dynamic-worker" }] });
        expect(current?.receiptDigest).toEqual(expect.any(String));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Offline review receipt did not settle");
  });
  return review;
}

async function refusal(response: Response, message: string) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: message });
}

// HTTP, KV, Durable Objects and quick checks execute in real workerd. Artifacts and
// Git transport are OFFLINE fixtures; this scenario is not live provider acceptance.
describe("FH-066 end-to-end race regression in workerd with offline Git/Artifacts", () => {
  it("gates entrants, usage, trespass and stale bases, then promotes, stamps and archives the winner", async () => {
    const started = Date.now();
    const id = `race-e2e-${crypto.randomUUID().slice(0, 8)}`;
    await inspect(id, instance => {
      // Quick-only receipts need no fabricated container evidence: the native runner
      // invokes a sealed Dynamic Worker against fixture repository files.
      instance.useRpcRunner = true;
      instance.fixture.checks = JSON.stringify([{ name: "quick", tier: "quick", module: ".forkhorse/quick/check.js" }]);
      instance.fixture.quickSource = 'export default async ctx => ({ok:(await ctx.list(".forkhorse/quick")).includes(".forkhorse/quick/check.js")});';
      instance.fixture.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
      instance.fixture.reviewBlobs.set("8".repeat(40), new Blob(["after\n"]));
    });
    const created = await api("", "", OWNER, { id, agents: [...names, "judge"], requireReceipt: false });
    expect(created.status).toBe(201);
    const { agents } = await created.json<{ agents: { apiToken: string }[] }>();
    const tokens = agents.map(agent => agent.apiToken);
    const judgeToken = tokens[4]!;
    const forks: string[] = [];
    for (const [index, agent] of names.entries()) {
      const joined = await api(id, "/join", tokens[index]!, { agent });
      expect(joined.status).toBe(201);
      forks.push((await joined.json<{ repoName: string }>()).repoName);
    }
    expect(new Set(forks).size).toBe(4);
    expect((await api(id, "/packets", OWNER, {
      id: RACE, mode: "race", tokenBudget: 100, judge: "judge", title: "Demo race", goal: "Exercise the complete race workflow",
      paths: ["src/**"], acceptance: ["One CAS winner with retained history"],
    })).status).toBe(201);
    expect((await api(id, "/packets", OWNER, {
      id: "standard", title: "Protected documentation", goal: "Exercise trespass resolution",
      paths: ["docs/**"], acceptance: ["Owner resolves the blocker"],
    })).status).toBe(201);
    await refusal(await api(id, `/packets/${RACE}/claim`, judgeToken, {}), "The judge can't race.");
    for (const index of [0, 1, 2])
      expect((await api(id, `/packets/${RACE}/claim`, tokens[index]!, { repoName: forks[index] })).status).toBe(201);
    expect((await api(id, `/packets/${RACE}/claim`, tokens[3]!, { repoName: forks[3] })).status).toBe(409);
    expect((await api(id, "/packets/standard/claim", tokens[3]!, { repoName: forks[3] })).status).toBe(201);
    await refusal(await api(id, `/packets/${RACE}/archive`, OWNER, {}, "POST"), "Packet has a live claim.");
    expect((await snapshot(id)).packets.find(p => p.id === RACE)!.archived).toBeNull();

    expect((await api(id, "/usage", tokens[0]!, { packet: RACE, inputTokens: 40, outputTokens: 20, model: "fixture" })).status).toBe(200);
    expect((await api(id, "/usage", tokens[1]!, { packet: RACE, inputTokens: 90, outputTokens: 11, model: "fixture" })).status).toBe(200);
    const entered = (await snapshot(id)).races[0]!;
    expect(entered).toMatchObject({ tokenBudget: 100, judge: "judge", verdict: null, status: "open", winner: null, ledgerEntryId: null });
    expect(entered.entrants.map(e => ({ agent: e.agent, repoName: e.repoName, budget: e.budget }))).toEqual([
      { agent: "alpha", repoName: forks[0], budget: "within" },
      { agent: "beta", repoName: forks[1], budget: "over" },
      { agent: "gamma", repoName: forks[2], budget: "unchecked" },
    ]);
    expect(entered.entrants[2]!.usage).toEqual({ reported: null, metered: null });

    await inspect(id, instance => { instance.fixture.changedPaths = ["src/index.ts", "docs/file.md"]; });
    const push: PushEvent = {
      type: "cf.artifacts.repo.pushed", source: { namespace: "fixture", repoName: forks[0]! },
      payload: { ref: "refs/heads/main", before: BEFORE, after: AFTER },
      metadata: { eventTimestamp: new Date().toISOString() },
    };
    expect(await stub(id).recordPush(push)).toBe(true);
    await inspect(id, instance => {
      instance.fixture.changedPaths = undefined;
      for (const [index, sha] of [AFTER, "b".repeat(40), "c".repeat(40)].entries())
        instance.fixture.heads.set(forks[index]!, sha);
    });
    const observed = await snapshot(id);
    expect(observed.blockers).toHaveLength(1);
    const blocker = observed.blockers[0]!;
    expect(blocker).toMatchObject({ packet: "standard", claimingAgent: "delta", pushingAgent: "alpha",
      pushingPacket: RACE, repoName: forks[0], paths: ["docs/file.md"], resolved: null });
    expect(observed.races[0]!.entrants[0]!.firstPushAt).toEqual(expect.any(String));

    const reviews = [];
    for (const [index, sha] of [AFTER, "b".repeat(40), "c".repeat(40)].entries())
      reviews.push(await requestReview(id, tokens[index]!, forks[index]!, sha));
    for (const review of reviews)
      expect((await api(id, `/reviews/${review.id}`, judgeToken)).status).toBe(200);
    expect((await api(id, `/reviews/${reviews[0]!.id}/diff?path=src%2Findex.ts`, judgeToken)).status).toBe(200);
    // The judge prefers beta; advice neither finishes the race nor overrides the
    // usage/blocker/CAS gates or the owner's eventual choice of alpha.
    const advice = { ranking: ["beta", "alpha", "gamma"], rationale: "Beta leads the code review; the owner must still enforce usage and promotion gates." };
    for (const token of [OWNER, tokens[0]!])
      expect((await api(id, `/races/${RACE}/verdict`, token, advice)).status).toBe(403);
    const judged = await api(id, `/races/${RACE}/verdict`, judgeToken, advice);
    expect(judged.status).toBe(200);
    const { verdict } = await judged.json<{ verdict: RaceVerdict }>();
    expect(verdict).toEqual({ ...advice, at: expect.any(String) });
    const advised = await snapshot(id);
    expect(advised.races[0]).toMatchObject({ judge: "judge", verdict, status: "open", winner: null, places: [], ledgerEntryId: null });
    expect(advised.ledger).toEqual([]);
    for (const review of reviews.slice(1))
      expect((await api(id, `/reviews/${review.id}/approve`, OWNER, {})).status).toBe(200);
    const trespassError = "This fork pushed into paths another agent has claimed. The owner must resolve the blocker first.";
    await refusal(await api(id, `/reviews/${reviews[0]!.id}/approve`, OWNER, {}), trespassError);
    await refusal(await api(id, `/reviews/${reviews[0]!.id}/promote`, OWNER, {}), trespassError);
    const reason = "Owner reconciled the documentation trespass before promotion.";
    expect((await api(id, `/blockers/${blocker.id}/resolve`, OWNER, { reason })).status).toBe(200);
    expect((await snapshot(id)).blockers[0]!.resolved).toEqual({ at: expect.any(String), by: "owner", reason });
    expect((await api(id, `/reviews/${reviews[0]!.id}/approve`, OWNER, {})).status).toBe(200);

    await refusal(await api(id, `/reviews/${reviews[2]!.id}/promote`, OWNER, {}), "Report usage first: this race has a token budget.");
    await refusal(await api(id, `/reviews/${reviews[1]!.id}/promote`, OWNER, {}), "Over its token budget (reported).");
    await inspect(id, instance => {
      expect(instance.gitFixture.pushes).toEqual([]);
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === id && c.scope === "write")).toEqual([]);
      // Simulate a competing canonical write at the transport's old-SHA check.
      instance.gitFixture.raceBeforePush = true;
    });
    await refusal(await api(id, `/reviews/${reviews[0]!.id}/promote`, OWNER, {}), "stale base, rebase");
    const missed = await snapshot(id);
    expect(missed.ledger).toEqual([]);
    expect(missed.promotionPending).toBeNull();
    expect(missed.races[0]).toMatchObject({ verdict, status: "open", winner: null, places: [], ledgerEntryId: null });
    expect(missed.races[0]!.entrants[0]).toMatchObject({ closedAt: null, place: null,
      promoteRejected: { at: expect.any(String), expected: BEFORE, found: "f".repeat(40) } });

    // Recover through a new review on the new canonical base, without rewriting
    // stored claims, reviews or race records. Only provider/Git fixtures are changed.
    const winnerSha = "e".repeat(40);
    await inspect(id, async instance => {
      expect(instance.gitFixture.pushes).toEqual([]);
      instance.gitFixture.raceBeforePush = false;
      instance.fixture.heads.set(forks[0]!, winnerSha);
      const repo = await instance.fixture.get(forks[0]!);
      using repository = repo;
      const commit = (await repository.readCommit(winnerSha))!;
      instance.fixture.reviewCommits.set(winnerSha, { ...commit, parents: ["f".repeat(40)] });
    });
    const winnerReview = await requestReview(id, tokens[0]!, forks[0]!, winnerSha);
    expect(winnerReview.base).toBe("f".repeat(40));
    expect((await api(id, `/reviews/${winnerReview.id}/approve`, OWNER, {})).status).toBe(200);
    expect((await api(id, "/settings", OWNER, { requireReceipt: true }, "PATCH")).status).toBe(200);
    expect((await api(id, `/reviews/${winnerReview.id}/promote`, tokens[0]!, {})).status).toBe(403);
    expect((await api(id, `/reviews/${winnerReview.id}/promote`, judgeToken, {})).status).toBe(403);
    const promoted = await api(id, `/reviews/${winnerReview.id}/promote`, OWNER, {});
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    const finished = await snapshot(id);
    expect(finished.ledger).toHaveLength(1);
    const ledger = finished.ledger[0]!;
    expect(ledger).toMatchObject({ review: winnerReview.id, race: RACE, repoName: id,
      before: "f".repeat(40), after: winnerSha, requireReceipt: true, receiptDigest: expect.any(String) });
    expect(finished.races[0]).toMatchObject({ judge: "judge", verdict, status: "finished", winner: "alpha", ledgerEntryId: ledger.id,
      finishedAt: expect.any(String), places: [{ agent: "alpha", place: 1 }, { agent: "beta", place: 2 }, { agent: "gamma", place: 3 }] });
    for (const entrant of finished.races[0]!.entrants)
      expect(entrant).toMatchObject({ closedAt: finished.races[0]!.finishedAt, closedBy: "race-finished",
        place: entrant.agent === "alpha" ? 1 : entrant.agent === "beta" ? 2 : 3,
        promotedAt: entrant.agent === "alpha" ? finished.races[0]!.finishedAt : null });
    expect(finished.claims.map(c => c.packet)).toEqual(["standard"]);
    expect(finished.promotionPending).toBeNull();
    expect(finished.reviews.find(r => r.id === winnerReview.id)).toMatchObject({ promoted: true, stale: false,
      receipt: { status: "passed", trigger: "before-promote", checks: [{ tier: "quick", runtime: "dynamic-worker" }] } });
    for (const review of reviews)
      expect(finished.reviews.find(r => r.id === review.id)).toMatchObject({ promoted: false, stale: true });
    const receiptResponse = await api(id, `/reviews/${winnerReview.id}/receipt`);
    expect(receiptResponse.status).toBe(200);
    const receipt = await receiptResponse.json<StoredReceipt>();
    expect(receipt.receipt).toMatchObject({ evidence: "dynamic-worker", commit: winnerSha, trigger: "before-promote" });
    expect(receipt.digest).toBe(ledger.receiptDigest);
    await refusal(await api(id, `/races/${RACE}/verdict`, judgeToken, advice), "Race finished.");
    await inspect(id, instance => {
      expect(instance.gitFixture.pushes).toEqual([{ remote: `https://git.idiot.tax/fixture/${id}.git`, expected: "f".repeat(40), sha: winnerSha }]);
      expect(instance.fixture.heads.get(id)).toBe(winnerSha);
      expect(instance.receiptRuns).toEqual(["review-created", "review-created", "review-created", "review-created", "before-promote"]);
    });

    expect((await api(id, "/settings", OWNER, { requireReceipt: false }, "PATCH")).status).toBe(200);
    const toggled = await snapshot(id);
    expect(toggled.project.settings.requireReceipt).toBe(false);
    expect(toggled.ledger).toEqual(finished.ledger);
    expect(toggled.settingsChanges.map(c => ({ before: c.before, after: c.after }))).toEqual([
      { before: false, after: true }, { before: true, after: false },
    ]);
    const archived = await api(id, `/packets/${RACE}/archive`, OWNER, {}, "POST");
    expect(archived.status, await archived.clone().text()).toBe(200);
    const history = await snapshot(id);
    expect(history.packets.find(p => p.id === RACE)!.archived).toEqual({ at: expect.any(String), by: "owner" });
    expect(history.races).toEqual(toggled.races);
    expect(history.ledger).toEqual(finished.ledger);
    expect(history.reviews).toEqual(toggled.reviews);
    expect(history.blockers).toEqual(toggled.blockers);
    await refusal(await api(id, `/packets/${RACE}/claim`, tokens[3]!, { repoName: forks[3] }), "Packet is archived.");
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 60_000);
});
