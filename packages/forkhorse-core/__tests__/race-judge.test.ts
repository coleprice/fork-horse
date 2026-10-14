import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { RaceRecord, Review, StateSnapshot } from "../src/workflow-types";
import { AFTER } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
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
const state = async (id: string) => (await api(id, "/state")).json<StateSnapshot>();
const packetBody = (id = "one", extra: Record<string, unknown> = {}) => ({
  id, mode: "race", judge: "judge", title: "Fixture race", goal: "Compare fixture work",
  paths: ["src"], acceptance: ["Fixture check"], ...extra,
});
async function fixture() {
  const id = `judge-${crypto.randomUUID().slice(0, 8)}`;
  await mutate(id, instance => {
    instance.fixture.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
    instance.fixture.reviewBlobs.set("8".repeat(40), new Blob(["after\n"]));
  });
  const names = ["alpha", "beta", "judge", "outsider"];
  const response = await worker.fetch(new Request("https://api.idiot.tax/projects", {
    method: "POST", headers: { authorization: `Bearer ${OWNER}` },
    body: JSON.stringify({ id, agents: names, requireReceipt: false }),
  }), env);
  expect(response.status).toBe(201);
  const { agents } = await response.json<{ agents: { apiToken: string }[] }>();
  const tokens: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    tokens[name] = agents[index]!.apiToken;
    expect((await api(id, "/join", tokens[name], { agent: name })).status).toBe(201);
  }
  return { id, tokens, judge: tokens.judge!, alpha: tokens.alpha!, beta: tokens.beta!, outsider: tokens.outsider! };
}
async function createRace(id: string, extra: Record<string, unknown> = {}) {
  expect((await api(id, "/packets", OWNER, packetBody("one", extra))).status).toBe(201);
}
async function claim(id: string, token: string, packet = "one") {
  expect((await api(id, `/packets/${packet}/claim`, token, {})).status).toBe(201);
}
async function review(id: string, token: string, agent: string, packet = "one") {
  const repoName = `${id}--${agent}-1`;
  await mutate(id, instance => { instance.fixture.heads.set(repoName, AFTER); });
  const response = await api(id, "/reviews", token, { packet, repoName, sha: AFTER });
  expect(response.status).toBe(201);
  const { review: result } = await response.json<{ review: Review }>();
  await mutate(id, async (_instance, objectState) => {
    for (let i = 0; i < 100; i++) {
      if ((await objectState.storage.get<Review>(`review:${result.id}`))?.receipt?.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  });
  return result;
}
const advice = (ranking = ["alpha", "beta"], rationale = "Best fit for the acceptance checks.") => ({ ranking, rationale });

describe("advisory race judge in workerd (offline Artifacts fixtures)", () => {
  it("validates an enrolled race-only judge and keeps the creation field immutable", async () => {
    const f = await fixture();
    for (const judge of [null, "", 3, "unknown", "Judge", {}, ["judge"]])
      expect((await api(f.id, "/packets", OWNER, packetBody("invalid", { judge }))).status).toBe(400);
    for (const mode of ["standard", undefined])
      expect((await api(f.id, "/packets", OWNER, packetBody("invalid", { mode }))).status).toBe(400);
    await createRace(f.id);
    expect((await state(f.id)).packets[0]?.judge).toBe("judge");
    expect((await state(f.id)).races[0]).toMatchObject({ judge: "judge", verdict: null, status: "open" });
    expect((await api(f.id, "/packets", OWNER, packetBody("one", { judge: "outsider" }))).status).toBe(409);
    expect((await api(f.id, "/packets/one", OWNER, { judge: "outsider" }, "PATCH")).status).toBe(404);
    expect((await state(f.id)).packets[0]?.judge).toBe("judge");
    await createRace(f.id, { id: "unjudged", judge: undefined });
    expect((await state(f.id)).races.find(r => r.packet === "unjudged")).toMatchObject({ judge: null, verdict: null });
    expect((await api(f.id, "/races/unjudged/verdict", f.judge, advice([]))).status).toBe(403);
  });

  it("always refuses the judge's claim with the exact 409, without forbidding other races", async () => {
    const f = await fixture();
    await createRace(f.id);
    const denied = await api(f.id, "/packets/one/claim", f.judge, {});
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "The judge can't race." });
    expect((await state(f.id)).claims).toEqual([]);
    await createRace(f.id, { id: "other", judge: "outsider", paths: ["docs"] });
    await claim(f.id, f.judge, "other");
  });

  it("allows only exact entrants' review detail and diffs, with no other judge privileges", async () => {
    const f = await fixture();
    await createRace(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, "alpha");
    const foreign = await fixture();
    expect((await api(f.id, `/reviews/${r.id}`, foreign.judge)).status).toBe(403);
    for (const suffix of ["", "/diff?path=src%2Findex.ts"]) {
      for (const token of [f.judge, f.alpha, OWNER])
        expect((await api(f.id, `/reviews/${r.id}${suffix}`, token)).status).toBe(200);
      for (const token of [f.beta, f.outsider])
        expect((await api(f.id, `/reviews/${r.id}${suffix}`, token)).status).toBe(403);
    }
    for (const operation of ["approve", "promote", "return"])
      expect((await api(f.id, `/reviews/${r.id}/${operation}`, f.judge, { reason: "Advice only." })).status).toBe(403);
    expect((await api(f.id, `/reviews/${r.id}/receipt`, f.judge)).status).toBe(403);
    expect((await api(f.id, `/forks/${r.repoName}/token`, f.judge, {})).status).toBe(403);
    for (const mode of ["standard", "race"]) {
      const pid = `other-${mode}`;
      expect((await api(f.id, "/packets", OWNER, packetBody(pid, { mode, judge: undefined, paths: ["docs"] }))).status).toBe(201);
      await claim(f.id, f.alpha, pid);
      const other = await review(f.id, f.alpha, "alpha", pid);
      for (const suffix of ["", "/diff?path=src%2Findex.ts"])
        expect((await api(f.id, `/reviews/${other.id}${suffix}`, f.judge)).status).toBe(403);
    }
    // A review naming the packet is insufficient without its exact historical fork binding.
    await mutate(f.id, async (_instance, objectState) => {
      await objectState.storage.put(`review:${r.id}`, { ...r, repoName: `${f.id}--alpha-2` });
    });
    for (const suffix of ["", "/diff?path=src%2Findex.ts"])
      expect((await api(f.id, `/reviews/${r.id}${suffix}`, f.judge)).status).toBe(403);
    await mutate(f.id, async (_instance, objectState) => {
      await objectState.storage.put(`review:${r.id}`, r);
      await objectState.storage.delete("entrant:one:alpha");
    });
    for (const suffix of ["", "/diff?path=src%2Findex.ts"])
      expect((await api(f.id, `/reviews/${r.id}${suffix}`, f.judge)).status).toBe(403);
  });

  it("validates an exact roster permutation and 1–2000 character rationale; only the judge may replace it", async () => {
    const f = await fixture();
    await createRace(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    for (const data of [
      {}, { rationale: "reason" }, { ranking: ["alpha", "beta"] },
      advice([]), advice(["alpha"]), advice(["alpha", "alpha"]), advice(["beta", "outsider"]),
      advice(["alpha", "beta", "judge"]), { ...advice(), ranking: "alpha,beta" },
      { ...advice(), ranking: ["alpha", 1] },
      advice(["alpha", "beta"], ""), advice(["alpha", "beta"], "   "),
      advice(["alpha", "beta"], "x".repeat(2001)), { ...advice(), rationale: 1 },
    ]) expect((await api(f.id, "/races/one/verdict", f.judge, data)).status).toBe(400);
    for (const token of [OWNER, f.alpha, f.beta, f.outsider])
      expect((await api(f.id, "/races/one/verdict", token, advice())).status).toBe(403);
    expect((await api(f.id, "/races/one/verdict", f.judge)).status).toBe(405);
    expect((await api(f.id, "/races/missing/verdict", f.judge, advice())).status).toBe(403);
    expect((await state(f.id)).races[0]?.verdict).toBeNull();
    for (const [ranking, rationale] of [ [["alpha", "beta"], "x"], [["beta", "alpha"], "x".repeat(2000)] ] as const) {
      const response = await api(f.id, "/races/one/verdict", f.judge, { ranking, rationale });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { verdict } = await response.json<{ verdict: unknown }>();
      expect(verdict).toEqual({ ranking, rationale, at: expect.any(String) });
      expect((await state(f.id)).races[0]).toMatchObject({ status: "open", verdict, winner: null, places: [] });
      await mutate(f.id, async (_instance, objectState) => {
        expect(await objectState.storage.get("race:one")).toEqual({ verdict });
      });
    }
    // Advice does not freeze claims. A new entrant changes the required permutation.
    await claim(f.id, f.outsider);
    expect((await api(f.id, "/races/one/verdict", f.judge, advice())).status).toBe(400);
    expect((await api(f.id, "/races/one/verdict", f.judge, advice(["outsider", "alpha", "beta"]))).status).toBe(200);
    expect((await state(f.id)).ledger).toEqual([]);
  });

  it("keeps the full retained entrant roster in the verdict after a withdrawal", async () => {
    const f = await fixture();
    await createRace(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    const r = await review(f.id, f.alpha, "alpha");
    expect((await api(f.id, "/packets/one/claim", f.alpha, undefined, "DELETE")).status).toBe(200);
    expect((await api(f.id, "/races/one/verdict", f.judge, advice(["beta"]))).status).toBe(400);
    expect((await api(f.id, "/races/one/verdict", f.judge, advice(["beta", "alpha"]))).status).toBe(200);
    expect((await api(f.id, `/reviews/${r.id}`, f.judge)).status).toBe(200);
  });

  it("preserves advice on owner promotion, permits an independent winner, and refuses later verdicts", async () => {
    const f = await fixture();
    await createRace(f.id);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta);
    expect((await api(f.id, "/races/one/verdict", f.judge, advice(["beta", "alpha"]))).status).toBe(200);
    const before = (await state(f.id)).races[0]!.verdict;
    const r = await review(f.id, f.alpha, "alpha");
    expect((await api(f.id, `/reviews/${r.id}/approve`, OWNER, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(200);
    expect((await state(f.id)).races[0]).toMatchObject({ status: "finished", winner: "alpha", verdict: before });
    expect((await api(f.id, "/races/one/verdict", f.judge, advice())).status).toBe(409);
    for (const token of [OWNER, f.alpha, f.beta, f.outsider])
      expect((await api(f.id, "/races/one/verdict", token, advice())).status).toBe(403);
    const judgeClaim = await api(f.id, "/packets/one/claim", f.judge, {});
    expect(judgeClaim.status).toBe(409);
    expect(await judgeClaim.json()).toEqual({ error: "The judge can't race." });
    expect((await api(f.id, `/reviews/${r.id}/diff?path=src%2Findex.ts`, f.judge)).status).toBe(200);
    // Legacy finish records without advice still fence verdicts and normalize to null.
    await mutate(f.id, async (_instance, objectState) => {
      const record = (await objectState.storage.get<RaceRecord>("race:one"))!;
      delete record.verdict;
      await objectState.storage.put("race:one", record);
    });
    expect((await state(f.id)).races[0]).toMatchObject({ status: "finished", verdict: null });
    expect((await api(f.id, "/races/one/verdict", f.judge, advice())).status).toBe(409);
  });
});
