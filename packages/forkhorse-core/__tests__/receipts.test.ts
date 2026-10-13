import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ReceiptAuthority, Receipts, readReceipt, storeReceipt, recoverInterruptedReceipts } from "../src/receipts";
import { receiptJson, sha256 } from "../../forkhorse-runner/src/runner";
import type { AuthorizedReview, Check, CheckReceipt, Receipt, StoredReceipt } from "../../forkhorse-runner/src/types";
import type { Fork, LedgerEntry, Review, SettingsChange, StateSnapshot } from "../src/workflow-types";
import type { Project } from "../src/types";
import { TestSupervisor } from "./worker";
import { AFTER } from "./fixtures";

const OWNER = "offline-fixture-owner-token";
const CHECK: Check = { name: "unit", tier: "full", image: "default", run: "npm test" };
const stub = (id: string) => env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
const inspect = <T>(id: string, fn: (instance: TestSupervisor, ctx: DurableObjectState) => Promise<T> | T) =>
  runInDurableObject(stub(id), async (instance, ctx) => {
    if (!(instance instanceof TestSupervisor)) throw new Error("Expected offline fixture");
    return fn(instance, ctx);
  });
function api(id: string, path: string, data?: unknown, token = OWNER, method?: string) {
  return worker.fetch(new Request(`https://api.idiot.tax/projects${id ? `/${id}` : ""}${path}`, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}` }, body: data === undefined ? undefined : JSON.stringify(data),
  }), env);
}
const state = async (id: string) => (await api(id, "/state")).json<StateSnapshot>();
async function finished(id: string, rid: string) {
  return inspect(id, async (_instance, ctx) => {
    for (let i = 0; i < 200; i++) {
      const review = await ctx.storage.get<Review>(`review:${rid}`);
      if (review?.receipt?.status !== "running") return review!;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Offline receipt did not finish");
  });
}
async function fixture(requireReceipt?: boolean) {
  const id = `receipts-${crypto.randomUUID().slice(0, 8)}`;
  const created = await api("", "", { id, agents: ["builder"], ...(requireReceipt === undefined ? {} : { requireReceipt }) });
  expect(created.status).toBe(201);
  const { agents } = await created.json<{ agents: { apiToken: string }[] }>();
  const token = agents[0]!.apiToken;
  const joined = await (await api(id, "/join", { agent: "builder" }, token)).json<{ repoName: string }>();
  await api(id, "/packets", { id: "test", title: "Test", goal: "Test", paths: ["src"], acceptance: ["Pass"] });
  await api(id, "/packets/test/claim", {}, token);
  await inspect(id, instance => {
    instance.fixture.checks = JSON.stringify([CHECK]);
    instance.fixture.heads.set(joined.repoName, AFTER);
  });
  const submit = async () => {
    const response = await api(id, "/reviews", { packet: "test", repoName: joined.repoName, sha: AFTER }, token);
    expect(response.status).toBe(201);
    return (await response.json<{ review: Review }>()).review;
  };
  return { id, token, repo: joined.repoName, submit };
}

/** Fabricated validator input only. This does not relabel a mocked runner result. */
async function fabricated(run: AuthorizedReview, checks = [CHECK], log = "", outcome: CheckReceipt["outcome"] = "passed"): Promise<StoredReceipt> {
  const logs = { stdout: log, stderr: log, truncated: false };
  const receipt: Receipt = {
    schema: 1, evidence: "container", projectId: run.projectId, reviewId: run.reviewId,
    forkRepoName: run.forkRepoName, commit: run.commit, generation: run.generation, trigger: run.trigger,
    checks: await Promise.all(checks.map(async check => ({
      commit: run.commit, check, imageDigest: `sha256:${"a".repeat(64)}`, exitStatus: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null, outcome,
      startedAt: "2026-10-12T00:00:00.000Z", finishedAt: "2026-10-12T00:00:01.000Z", durationMs: 1000,
      logs, logDigest: await sha256(JSON.stringify(logs)),
    }))),
  };
  return { receipt, digest: await sha256(receiptJson(receipt)) };
}

describe("receipt integration in workerd; all container execution is explicitly mocked", () => {
  it("uses same-script loopback DO RPC and callback capabilities with the native adapter and a mocked port", async () => {
    const f = await fixture(false);
    await inspect(f.id, instance => { instance.useRpcRunner = true; });
    const review = await f.submit();
    const result = await finished(f.id, review.id);
    expect(result.receipt?.status).toBe("passed");
    const record = await (await api(f.id, `/reviews/${review.id}/receipt`)).json<StoredReceipt>();
    expect(record.receipt.evidence).toBe("mocked-container-port");
    expect(record.receipt.commit).toBe(AFTER);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
  });

  it("marks interrupted executions unavailable and rejects late attachment after recovery", async () => {
    const f = await fixture(), review = await f.submit();
    await finished(f.id, review.id);
    await inspect(f.id, async (instance, ctx) => {
      const project = (await ctx.storage.get<Project>("project"))!;
      const fork = (await ctx.storage.get<Fork>(`fork:${f.repo}`))!;
      const current = (await ctx.storage.get<Review>(`review:${review.id}`))!;
      const run = await new Receipts(ctx.storage, { ...env, ARTIFACTS: instance.fixture }, async () => { throw new Error("Not executed"); }, () => {})
        .reserve(project, current, fork, "review-created");
      const authority = new ReceiptAuthority(ctx.storage, run), record = await fabricated(run);
      await authority.storeReceipt(record);
      await recoverInterruptedReceipts(ctx.storage);
      expect(await authority.setReviewReceiptDigest(run, record.digest)).toBe(false);
    });
    expect((await state(f.id)).reviews[0]?.receipt).toMatchObject({ status: "infrastructure-error", digest: null });
  });

  it("defaults new projects to required; owner-only settings preserve the legacy false fallback", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const f = await fixture();
    expect((await state(f.id)).project.settings).toEqual({ requireReceipt: true });
    expect((await api(f.id, "/settings", { requireReceipt: false }, f.token, "PATCH")).status).toBe(403);
    expect((await api(f.id, "/settings", { requireReceipt: "false" }, OWNER, "PATCH")).status).toBe(400);
    expect((await api(f.id, "/settings", { requireReceipt: false, extra: true }, OWNER, "PATCH")).status).toBe(400);
    expect(await (await api(f.id, "/settings", { requireReceipt: false }, OWNER, "PATCH")).json())
      .toEqual({ settings: { requireReceipt: false } });
    await inspect(f.id, async (_instance, ctx) => {
      const project = (await ctx.storage.get<Project>("project"))!;
      delete project.settings;
      await ctx.storage.put("project", project);
    });
    expect((await state(f.id)).project.settings).toEqual({ requireReceipt: false });
  });

  it("audits actual toggles with owner API provenance, preserves same-value requests and exposes history", async () => {
    const f = await fixture();
    for (const requireReceipt of [false, false, true, false]) {
      const response = await api(f.id, "/settings", { requireReceipt }, OWNER, "PATCH");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ settings: { requireReceipt } });
    }
    const changes = (await state(f.id)).settingsChanges;
    expect(changes).toHaveLength(3);
    expect(changes.map(({ before, after, by, via, setting }) => ({ before, after, by, via, setting })))
      .toEqual([false, true, false].map((after, index) => ({
        setting: "requireReceipt", before: index !== 1, after, by: "owner", via: "owner-api",
      })));
    await inspect(f.id, async (_instance, ctx) => {
      const stored = await ctx.storage.list<SettingsChange>({ prefix: "settingsChange:" });
      expect([...stored.values()]).toEqual(changes);
      for (const [key, change] of stored) {
        expect(key).toBe(`settingsChange:${change.recordedAt}`);
        expect(new Date(change.recordedAt).toISOString()).toBe(change.recordedAt);
        expect(Object.keys(change).toSorted()).toEqual(["after", "before", "by", "recordedAt", "setting", "via"]);
      }
    });
    expect((await (await api(f.id, "/state", undefined, f.token)).json<StateSnapshot>()).settingsChanges).toEqual(changes);
  });

  it.each([null, [], {}, { requireReceipt: 0 }, { requireReceipt: false, via: "access" }])("rejects invalid settings body %j without changing settings or audit history", async data => {
    const f = await fixture();
    expect((await api(f.id, "/settings", data, OWNER, "PATCH")).status).toBe(400);
    expect((await state(f.id)).project.settings).toEqual({ requireReceipt: true });
    expect((await state(f.id)).settingsChanges).toEqual([]);
  });

  it("blocks toggles and same-value requests while an uncertain promotion remains pending", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    await inspect(f.id, instance => { instance.gitFixture.failPush = true; });
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(502);
    const before = await state(f.id);
    expect(before.promotionPending).toMatchObject({ review: review.id, requireReceipt: false });
    for (const requireReceipt of [true, false])
      expect((await api(f.id, "/settings", { requireReceipt }, OWNER, "PATCH")).status).toBe(409);
    const after = await state(f.id);
    expect(after.project.settings).toEqual(before.project.settings);
    expect(after.settingsChanges).toEqual([]);
    expect(after.promotionPending).toEqual(before.promotionPending);
    expect(after.reviews).toEqual(before.reviews);
  });

  it("rolls back the setting and audit together if durable persistence fails", async () => {
    const f = await fixture();
    await inspect(f.id, async (instance, ctx) => {
      const transaction = ctx.storage.transaction.bind(ctx.storage);
      const failure = vi.spyOn(ctx.storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          throw new Error("Offline settings audit failure");
        });
        return callback(txn);
      }));
      try {
        const response = await instance.fetch(new Request(`https://api.idiot.tax/projects/${f.id}/settings`, {
          method: "PATCH", headers: { authorization: `Bearer ${OWNER}` }, body: JSON.stringify({ requireReceipt: false }),
        }));
        expect(response.status).toBe(502);
        expect((await ctx.storage.get<Project>("project"))?.settings).toEqual({ requireReceipt: true });
        expect(await ctx.storage.list({ prefix: "settingsChange:" })).toEqual(new Map());
      } finally { failure.mockRestore(); }
    });
  });

  it("does not backfill unknown legacy promotion policy from the current setting", async () => {
    const f = await fixture();
    const legacy: LedgerEntry = {
      id: "legacy", review: "legacy-review", repoName: f.id, ref: "refs/heads/main",
      before: "1".repeat(40), after: AFTER, receiptDigest: null, recordedAt: "2026-10-12T00:00:00.000Z",
    };
    await inspect(f.id, async (_instance, ctx) => { await ctx.storage.put("ledger:legacy", legacy); });
    expect((await state(f.id)).ledger).toEqual([legacy]);
    await api(f.id, "/settings", { requireReceipt: false }, OWNER, "PATCH");
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    expect((await state(f.id)).ledger).toEqual([legacy]);
    await inspect(f.id, async (_instance, ctx) => {
      expect(await ctx.storage.get("ledger:legacy")).toEqual(legacy);
    });
  });

  it("queues a settings change behind promotion and retains the policy used at push", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await inspect(f.id, async (instance, ctx) => {
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const pushing = new Promise<void>(resolve => { entered = resolve; });
      const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
      const paused = vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        return { ...prepared, push: async (...pushArgs) => { entered(); await barrier; await prepared.push(...pushArgs); } };
      });
      const request = (path: string, method: string, data: unknown) => new Request(`https://api.idiot.tax/projects/${f.id}${path}`, {
        method, headers: { authorization: `Bearer ${OWNER}` }, body: JSON.stringify(data),
      });
      try {
        const promote = instance.fetch(request(`/reviews/${review.id}/promote`, "POST", {}));
        await pushing;
        expect((await ctx.storage.get<LedgerEntry>("promotionPending"))?.requireReceipt).toBe(false);
        const toggle = instance.fetch(request("/settings", "PATCH", { requireReceipt: true }));
        await ctx.storage.get("project");
        expect((await ctx.storage.get<Project>("project"))?.settings).toEqual({ requireReceipt: false });
        expect(await ctx.storage.list({ prefix: "settingsChange:" })).toEqual(new Map());
        release();
        expect((await promote).status).toBe(200);
        expect((await toggle).status).toBe(200);
      } finally { release(); paused.mockRestore(); }
    });
    const snapshot = await state(f.id);
    expect(snapshot.project.settings).toEqual({ requireReceipt: true });
    expect(snapshot.ledger[0]?.requireReceipt).toBe(false);
    expect(snapshot.settingsChanges).toHaveLength(1);
  });

  it("keeps receipts and promotion stamps across off/on/off toggles; required validator evidence is fabricated offline", async () => {
    const f = await fixture(false), advisory = await f.submit();
    await finished(f.id, advisory.id);
    expect((await api(f.id, `/reviews/${advisory.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${advisory.id}/promote`, {})).status).toBe(200);
    const retained = (await state(f.id)).reviews[0]!;
    const receipt = await (await api(f.id, `/reviews/${advisory.id}/receipt`)).json();
    expect((await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH")).status).toBe(200);
    expect((await api(f.id, "/packets/test/claim", { repoName: f.repo }, f.token)).status).toBe(201);
    await inspect(f.id, instance => {
      instance.fixture.heads.set(f.repo, "a".repeat(40));
      // Validator inputs only: this proves gating logic, not live container execution.
      instance.receiptFixtureExecutor = async (request, authority) => {
        const run = await authority.authorize(request), record = await fabricated(run);
        await authority.storeReceipt(record);
        expect(await authority.setReviewReceiptDigest(run, record.digest)).toBe(true);
        return record;
      };
    });
    const response = await api(f.id, "/reviews", { packet: "test", repoName: f.repo, sha: "a".repeat(40) }, f.token);
    expect(response.status).toBe(201);
    const required = (await response.json<{ review: Review }>()).review;
    await finished(f.id, required.id);
    expect((await api(f.id, `/reviews/${required.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${required.id}/promote`, {})).status).toBe(200);
    const promoted = (await state(f.id)).reviews.find(r => r.id === required.id)!;
    expect(promoted.receipt?.trigger).toBe("before-promote");
    expect((await api(f.id, "/settings", { requireReceipt: false }, OWNER, "PATCH")).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.project.settings).toEqual({ requireReceipt: false });
    expect(snapshot.ledger.map(({ review: id, requireReceipt }) => ({ id, requireReceipt })))
      .toEqual([{ id: advisory.id, requireReceipt: false }, { id: required.id, requireReceipt: true }]);
    expect(snapshot.reviews.find(r => r.id === advisory.id)).toEqual(retained);
    expect(snapshot.reviews.find(r => r.id === required.id)).toEqual(promoted);
    expect(await (await api(f.id, `/reviews/${advisory.id}/receipt`)).json()).toEqual(receipt);
    await inspect(f.id, instance => { expect(instance.receiptRuns).toEqual(["review-created", "review-created", "before-promote"]); });
  });

  it("returns a running review immediately; keeps logs/images/tokens out of state and guards full receipt reads", async () => {
    const f = await fixture();
    let release!: () => void;
    await inspect(f.id, instance => { instance.receiptBarrier = new Promise<void>(resolve => { release = resolve; }); });
    const review = await f.submit();
    expect(review.receipt).toMatchObject({ status: "running", trigger: "review-created", digest: null, finishedAt: null, durationMs: null });
    expect((await state(f.id)).reviews[0]?.receipt?.status).toBe("running");
    expect((await api(f.id, `/reviews/${review.id}/receipt`)).status).toBe(404);
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(409);
    await inspect(f.id, () => { release(); });
    const done = await finished(f.id, review.id);
    expect(done.receipt?.status).toBe("passed");
    const stored = await (await api(f.id, `/reviews/${review.id}/receipt`)).json<StoredReceipt>();
    expect(stored.receipt.evidence).toBe("mocked-container-port");
    expect(stored.receipt.checks[0]?.logs.stdout).toBe("fixture output\n");
    expect((await api(f.id, `/reviews/${review.id}/receipt`, undefined, f.token)).status).toBe(403);
    const summary = (await state(f.id)).reviews[0]!;
    expect(Object.keys(summary.receipt!).toSorted()).toEqual(["checks", "digest", "durationMs", "finishedAt", "startedAt", "status", "trigger"]);
    expect(Object.keys(summary.receipt!.checks[0]!).toSorted()).toEqual(["durationMs", "name", "outcome", "runtime", "tier"]);
    const serialized = JSON.stringify(summary);
    for (const forbidden of ["logs", "image", "token", "receiptGeneration", "fixture output"]) expect(serialized).not.toContain(forbidden);
    // The production validator never treats mocked evidence as a passing container receipt.
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(409);
    await api(f.id, "/settings", { requireReceipt: false }, OWNER, "PATCH");
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    await inspect(f.id, instance => {
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.scope === "read"))
        .toEqual([{ method: "createToken", repo: f.repo, scope: "read", ttl: 180 }]);
      expect([...instance.fixture.tokens.get(f.repo)!.values()].filter(t => t.scope === "read").every(t => t.state === "revoked")).toBe(true);
    });
  });

  it("advisory failed receipts gate neither approval nor promotion and start no container at promote", async () => {
    const f = await fixture(false);
    await inspect(f.id, instance => { instance.receiptExitStatus = 1; });
    const review = await f.submit(), first = await finished(f.id, review.id);
    expect(first.receipt?.status).toBe("failed");
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.reviews[0]).toMatchObject({ promoted: true, stale: false, receiptDigest: first.receiptDigest });
    expect(snapshot.reviews[0]?.receipt).toMatchObject({ status: "failed", trigger: "review-created" });
    expect(snapshot.ledger[0]?.requireReceipt).toBe(false);
    await inspect(f.id, instance => {
      expect(instance.receiptRuns).toEqual(["review-created"]);
      expect(instance.receiptContainers.map(c => c.starts)).toEqual([1]);
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.scope === "read")).toHaveLength(1);
    });
  });

  it.each([false, true])("advisory promotion releases its claim without losing the late receipt (reclaimed: %s)", async (reclaim) => {
    const f = await fixture(false);
    let release!: () => void;
    await inspect(f.id, instance => {
      instance.receiptExitStatus = 1;
      instance.receiptBarrier = new Promise<void>(resolve => { release = resolve; });
    });
    const review = await f.submit();
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    expect((await state(f.id)).claims).toEqual([]);
    if (reclaim) {
      const joined = await (await api(f.id, "/join", { agent: "builder" }, f.token)).json<{ repoName: string }>();
      expect((await api(f.id, "/packets/test/claim", { repoName: joined.repoName }, f.token)).status).toBe(201);
    }
    await inspect(f.id, instance => {
      expect(instance.receiptRuns).toEqual(["review-created"]);
      expect(instance.receiptContainers).toHaveLength(0);
      release();
    });
    const done = await finished(f.id, review.id);
    expect(done).toMatchObject({ promoted: true, receipt: { status: "failed", trigger: "review-created" } });
    expect(done.receiptDigest).not.toBeNull();
    expect((await api(f.id, `/reviews/${review.id}/receipt`)).status).toBe(200);
  });

  it.each(["generation", "missing-audit"] as const)("fences late promoted receipts with %s mismatch", async (mismatch) => {
    const f = await fixture(false);
    let release!: () => void;
    await inspect(f.id, instance => { instance.receiptBarrier = new Promise<void>(resolve => { release = resolve; }); });
    const review = await f.submit();
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    await inspect(f.id, async (_instance, ctx) => {
      const current = (await ctx.storage.get<Review>(`review:${review.id}`))!;
      if (mismatch === "generation")
        await ctx.storage.put(`review:${review.id}`, { ...current, receiptGeneration: crypto.randomUUID() });
      else await ctx.storage.delete(`claimRelease:${review.id}`);
      release();
      // Let the deliberately rejected background execution settle.
      for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect((await ctx.storage.get<Review>(`review:${review.id}`))?.receiptDigest).toBeNull();
    });
  });

  it("advisory receipt changes after approval cannot block promotion", async () => {
    const f = await fixture(false);
    let release!: () => void;
    await inspect(f.id, instance => { instance.receiptBarrier = new Promise<void>(resolve => { release = resolve; }); });
    const review = await f.submit();
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await inspect(f.id, () => { release(); });
    const done = await finished(f.id, review.id);
    expect(done.approval?.receiptDigest).toBeNull();
    expect(done.receiptDigest).not.toBeNull();
    expect((await state(f.id)).reviews[0]?.stale).toBe(false);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    await inspect(f.id, instance => { expect(instance.receiptRuns).toEqual(["review-created"]); });
  });

  it("advisory missing check configuration gates nothing and starts no container", async () => {
    const f = await fixture(false);
    await inspect(f.id, instance => { instance.fixture.checks = undefined; });
    const review = await f.submit();
    await finished(f.id, review.id);
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    expect((await state(f.id)).reviews[0]?.receipt).toBeNull();
    await inspect(f.id, instance => {
      expect(instance.receiptRuns).toEqual([]);
      expect(instance.receiptContainers).toHaveLength(0);
    });
  });

  it("turning the requirement on reruns an already-approved review and records a failed before-promote result", async () => {
    const f = await fixture(false);
    const review = await f.submit(), first = await finished(f.id, review.id);
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    await inspect(f.id, instance => { instance.receiptExitStatus = 1; });
    const failed = await api(f.id, `/reviews/${review.id}/promote`, {});
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: "Checks failed before promote." });
    const current = (await state(f.id)).reviews[0]!;
    expect(current.receipt).toMatchObject({ status: "failed", trigger: "before-promote", checks: [{ name: "unit", tier: "full", outcome: "failed" }] });
    expect(current.receiptDigest).not.toBe(first.receiptDigest);
    await inspect(f.id, instance => {
      expect(instance.receiptRuns).toEqual(["review-created", "before-promote"]);
      expect(instance.receiptContainers.map(c => c.starts)).toEqual([1, 1]);
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id)).toEqual([]);
    });
  });

  it("required promotion waits for its fresh run before attempting any canonical write", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    let release!: () => void, resolved = false;
    await inspect(f.id, instance => { instance.receiptBarrier = new Promise<void>(resolve => { release = resolve; }); });
    const pending = api(f.id, `/reviews/${review.id}/promote`, {}).then(response => { resolved = true; return response; });
    await inspect(f.id, async (instance, ctx) => {
      for (let i = 0; i < 200 && instance.receiptRuns.length < 2; i++) {
        await ctx.storage.get(`review:${review.id}`);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(instance.receiptRuns).toEqual(["review-created", "before-promote"]);
      expect(resolved).toBe(false);
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id)).toEqual([]);
      release();
    });
    // A completed mock run still cannot satisfy the production required-evidence gate.
    expect(await (await pending).json()).toEqual({ error: "Checks failed before promote." });
  });

  it.each(["timed-out", "infrastructure-error"] as const)("required %s validator input produces the specified 409", async outcome => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    await inspect(f.id, instance => {
      instance.receiptFixtureExecutor = async (request, authority) => {
        const run = await authority.authorize(request), record = await fabricated(run, [CHECK], "", outcome);
        await authority.storeReceipt(record);
        await authority.setReviewReceiptDigest(run, record.digest);
        return record;
      };
    });
    const response = await api(f.id, `/reviews/${review.id}/promote`, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Checks failed before promote." });
    expect((await state(f.id)).reviews[0]?.receipt).toMatchObject({ status: outcome, trigger: "before-promote" });
    await inspect(f.id, instance => {
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id)).toEqual([]);
    });
  });

  it("required promotion accepts fresh fabricated validator evidence after an advisory approval", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    await inspect(f.id, instance => {
      // Fresh fabricated validator input, never a relabeled mocked execution result.
      instance.receiptFixtureExecutor = async (request, authority) => {
        const run = await authority.authorize(request), record = await fabricated(run);
        await authority.storeReceipt(record);
        expect(await authority.setReviewReceiptDigest(run, record.digest)).toBe(true);
        return record;
      };
    });
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.reviews[0]?.receipt?.trigger).toBe("before-promote");
    expect(snapshot.ledger[0]?.receiptDigest).toBe(snapshot.reviews[0]?.receiptDigest);
    expect(snapshot.ledger[0]?.requireReceipt).toBe(true);
    await inspect(f.id, instance => { expect(instance.receiptRuns).toEqual(["review-created", "before-promote"]); });
  });

  it("refuses a generation change during Git preparation before minting a canonical token", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    await inspect(f.id, (instance, ctx) => {
      instance.receiptFixtureExecutor = async (request, authority) => {
        const run = await authority.authorize(request), record = await fabricated(run);
        await authority.storeReceipt(record);
        await authority.setReviewReceiptDigest(run, record.digest);
        return record;
      };
      const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
      instance.gitFixture.preparePromote = async (...args) => {
        const prepared = await prepare(...args);
        const current = (await ctx.storage.get<Review>(`review:${review.id}`))!;
        await ctx.storage.put(`review:${review.id}`, { ...current, receiptGeneration: "newer-execution" });
        return prepared;
      };
    });
    expect(await (await api(f.id, `/reviews/${review.id}/promote`, {})).json())
      .toEqual({ error: "Receipt changed before promote." });
    await inspect(f.id, instance => {
      expect(instance.fixture.calls.filter(c => c.method === "createToken" && c.repo === f.id)).toEqual([]);
    });
  });

  it("does not promote mocked evidence after the owner turns the requirement on", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    await api(f.id, `/reviews/${review.id}/approve`, {});
    await api(f.id, "/settings", { requireReceipt: true }, OWNER, "PATCH");
    expect(await (await api(f.id, `/reviews/${review.id}/promote`, {})).json()).toEqual({ error: "Checks failed before promote." });
    expect((await state(f.id)).ledger).toEqual([]);
  });

  it("stores chunked immutable receipts, compares generations and commits atomically, and validates required approval", async () => {
    const f = await fixture(), review = await f.submit();
    await finished(f.id, review.id);
    await inspect(f.id, async (instance, ctx) => {
      const project = (await ctx.storage.get<Project>("project"))!;
      const fork = (await ctx.storage.get<Fork>(`fork:${f.repo}`))!;
      const current = (await ctx.storage.get<Review>(`review:${review.id}`))!;
      const receipts = new Receipts(ctx.storage, { ...env, ARTIFACTS: instance.fixture }, async () => { throw new Error("Not an execution test"); }, () => {});
      const old = await receipts.reserve(project, current, fork, "review-created");
      const oldAuthority = new ReceiptAuthority(ctx.storage, old);
      const record = await fabricated(old, Array.from({ length: 16 }, (_, i) => ({ ...CHECK, name: `test-${i}` })), "x".repeat(32768));
      await oldAuthority.storeReceipt(record);
      const chunks = await ctx.storage.list<string>({ prefix: `receipt:${record.digest}:` });
      expect(chunks.size).toBeGreaterThan(64);
      expect([...chunks.values()].every(c => new TextEncoder().encode(c).length < 128 * 1024)).toBe(true);
      expect(await readReceipt(ctx.storage, record.digest)).toEqual(record);
      await expect(storeReceipt(ctx.storage, { ...record, receipt: { ...record.receipt, commit: "a".repeat(40) } })).rejects.toThrow("Invalid receipt digest");
      const fresh = await receipts.reserve(project, current, fork, "review-created");
      expect(await oldAuthority.setReviewReceiptDigest(old, record.digest)).toBe(false);
      expect((await ctx.storage.get<Review>(`review:${review.id}`))!.receiptDigest).toBeNull();
      const authority = new ReceiptAuthority(ctx.storage, fresh), valid = await fabricated(fresh);
      await authority.storeReceipt(valid);
      // A different commit cannot attach, even with the generation unchanged.
      await ctx.storage.put(`review:${review.id}`, { ...current, sha: "b".repeat(40) });
      expect(await authority.setReviewReceiptDigest(fresh, valid.digest)).toBe(false);
      await ctx.storage.put(`review:${review.id}`, current);
      const attached = await Promise.all([
        authority.setReviewReceiptDigest(fresh, valid.digest),
        authority.setReviewReceiptDigest(fresh, valid.digest),
      ]);
      expect(attached.toSorted()).toEqual([false, true]);
      expect(await readReceipt(ctx.storage, record.digest)).toEqual(record);
    });
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
  });

  it("refuses attachment after claim release and never exposes gateway/runner through HTTP", async () => {
    const f = await fixture(false), review = await f.submit();
    await finished(f.id, review.id);
    let run!: AuthorizedReview, record!: StoredReceipt;
    await inspect(f.id, async (instance, ctx) => {
      const project = (await ctx.storage.get<Project>("project"))!;
      const fork = (await ctx.storage.get<Fork>(`fork:${f.repo}`))!;
      const current = (await ctx.storage.get<Review>(`review:${review.id}`))!;
      run = await new Receipts(ctx.storage, { ...env, ARTIFACTS: instance.fixture }, async () => { throw new Error("Not executed"); }, () => {})
        .reserve(project, current, fork, "review-created");
      record = await fabricated(run);
      await new ReceiptAuthority(ctx.storage, run).storeReceipt(record);
    });
    await api(f.id, "/packets/test/claim", undefined, f.token, "DELETE");
    await inspect(f.id, async (_instance, ctx) => {
      expect(await new ReceiptAuthority(ctx.storage, run).setReviewReceiptDigest(run, record.digest)).toBe(false);
    });
    for (const path of ["/ReceiptRunner", "/GitReadGateway", "/runner", "/git-upload-pack"]) {
      const response = await worker.fetch(new Request(`https://api.idiot.tax${path}`), env);
      expect(response.status).toBe(404);
    }
  });
});


describe("quick receipts through real Dynamic Workers and production core RPC; fixture Artifacts", () => {
  const QUICK: Check = { name: "quick", tier: "quick", module: ".forkhorse/quick/check.js" };
  it.each([true, false])("preserves required=%s approval and promote semantics for quick-only suites", async required => {
    const f = await fixture(required);
    await inspect(f.id, instance => {
      instance.useRpcRunner = true;
      instance.fixture.checks = JSON.stringify([QUICK]);
      instance.fixture.quickSource = 'export default async ctx => ({ok:(await ctx.list(".forkhorse/quick")).includes(".forkhorse/quick/check.js")});';
    });
    const review = await f.submit();
    const completed = await finished(f.id, review.id);
    expect(completed.receipt).toMatchObject({status:"passed",checks:[{tier:"quick",runtime:"dynamic-worker"}]});
    const record = await (await api(f.id, `/reviews/${review.id}/receipt`)).json<StoredReceipt>();
    expect(record.receipt.evidence).toBe("dynamic-worker");
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(200);
    expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    expect(await inspect(f.id, instance => instance.receiptRuns)).toEqual(required ? ["review-created","before-promote"] : ["review-created"]);
  });
  it.each([true, false])("preserves required=%s handling of failed quick checks", async required => {
    const f = await fixture(required);
    await inspect(f.id, instance => {
      instance.useRpcRunner = true;
      instance.fixture.checks = JSON.stringify([CHECK, QUICK]);
      instance.fixture.quickSource = 'export default async () => ({ok:false,message:"fixture failed"});';
    });
    const review = await f.submit();
    const completed = await finished(f.id, review.id);
    expect(completed.receipt).toMatchObject({status:"failed",checks:[{tier:"quick",outcome:"failed"},
      {tier:"full",durationMs:null,message:"Skipped: a quick check failed."}]});
    expect((await api(f.id, `/reviews/${review.id}/approve`, {})).status).toBe(required ? 409 : 200);
    if (!required) expect((await api(f.id, `/reviews/${review.id}/promote`, {})).status).toBe(200);
    expect(await inspect(f.id, instance => instance.receiptRuns)).toEqual(["review-created"]);
  });
});
