import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type {
  Blocker,
  Claim,
  ClaimReleaseAudit,
  Fork,
  LedgerEntry,
  ReconcilerAlert,
  Review,
} from "../src/workflow-types";
import type { PushEvent } from "../src/types";
import { branchHead } from "../src/artifacts";
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
async function releases(id: string): Promise<ClaimReleaseAudit[]> {
  return runInDurableObject(stub(id), async (_instance, objectState) =>
    [...(await objectState.storage.list<ClaimReleaseAudit>({ prefix: "claimRelease:" })).values()],
  );
}
async function fixture(branch = "main") {
  const id = `flow-${crypto.randomUUID().slice(0, 8)}`;
  await mutate(id, (instance) => {
    instance.fixture.defaultBranch = branch;
    instance.fixture.checks = JSON.stringify([{ name: "fixture", tier: "full", image: "default", run: "true" }]);
  });
  const response = await worker.fetch(
    new Request("https://api.idiot.tax/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ id, agents: ["alpha", "beta"], requireReceipt: false }),
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
    metadata: { eventTimestamp: "2026-10-12T00:00:00Z" },
  };
}

describe("workflow in real Durable Objects, with explicitly offline Git/Artifacts fixtures", () => {
  it.each(["owner", "agent"] as const)("audits %s release, invalidates reviews and keeps repeated release idempotent", async (role) => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const original = (await state(f.id)).claims[0]!;
    const r = await review(f.id, f.alpha, f.a);
    expect((await claim(f.id, OWNER)).status).toBe(403);
    expect((await api(f.id, "/packets/one/claim", "invalid", undefined, "DELETE")).status).toBe(403);
    expect((await api(f.id, "/packets/one/claim", f.beta, undefined, "DELETE")).status).toBe(403);
    expect(await releases(f.id)).toEqual([]);
    const token = role === "owner" ? OWNER : f.alpha;
    expect((await api(f.id, "/packets/one/claim", token, undefined, "DELETE")).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.reviews.find(item => item.id === r.id)?.stale).toBe(true);
    expect(await releases(f.id)).toEqual([{
      packet: "one", agent: "alpha", repoName: f.a, claimedAt: original.createdAt,
      releasedBy: role, recordedAt: expect.any(String),
    }]);
    expect((await api(f.id, "/packets/one/claim", token, undefined, "DELETE")).status).toBe(200);
    expect(await releases(f.id)).toHaveLength(1);
    expect((await api(f.id, "/packets/missing/claim", token, undefined, "DELETE")).status).toBe(404);
    expect((await claim(f.id, f.beta)).status).toBe(201);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
    expect((await state(f.id)).claims).toMatchObject([{ agent: "beta", repoName: f.b }]);
  });

  it("accepts release through the trusted owner binding and preserves other packets", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "two", ["docs"]);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta, "two");
    const response = await stub(f.id).ownerRequest({
      url: `https://api.idiot.tax/projects/${f.id}/packets/one/claim`, method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await state(f.id)).claims).toMatchObject([{ packet: "two", agent: "beta" }]);
    expect(await releases(f.id)).toMatchObject([{ releasedBy: "owner", agent: "alpha" }]);
  });

  it("releases only the promoted claim, audits its review and invalidates sibling reviews atomically", async () => {
    const f = await fixture();
    await packet(f.id);
    await packet(f.id, "two", ["docs"]);
    await claim(f.id, f.alpha);
    await claim(f.id, f.beta, "two");
    const original = (await state(f.id)).claims.find(c => c.packet === "one")!;
    const sibling = await review(f.id, f.alpha, f.a);
    const r = await review(f.id, f.alpha, f.a);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(200);
    const snapshot = await state(f.id);
    expect(snapshot.claims).toMatchObject([{ packet: "two", agent: "beta" }]);
    expect(snapshot.reviews.find(item => item.id === r.id)).toMatchObject({ promoted: true, stale: false });
    expect(snapshot.reviews.find(item => item.id === sibling.id)).toMatchObject({ promoted: false, stale: true });
    expect(snapshot.ledger).toMatchObject([{ review: r.id, after: AFTER }]);
    expect(snapshot.promotionPending).toBeNull();
    expect(await releases(f.id)).toEqual([{
      packet: "one", agent: "alpha", repoName: f.a, claimedAt: original.createdAt,
      releasedBy: "promote", review: r.id, recordedAt: expect.any(String),
    }]);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(409);
    expect(await releases(f.id)).toHaveLength(1);
  });

  it.each(["owner", "promote"] as const)("rolls back the whole %s transaction when release audit persistence fails", async (operation) => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (_instance, objectState) => {
      const transaction = objectState.storage.transaction.bind(objectState.storage);
      vi.spyOn(objectState.storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("claimRelease:"))
            throw new Error("offline audit persistence failure");
        });
        return callback(txn);
      }));
    });
    try {
      const response = operation === "promote"
        ? await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})
        : await api(f.id, "/packets/one/claim", OWNER, undefined, "DELETE");
      expect(response.status).toBe(502);
      const snapshot = await state(f.id);
      expect(snapshot.claims).toMatchObject([{ packet: "one", agent: "alpha" }]);
      expect(snapshot.ledger).toEqual([]);
      expect(snapshot.reviews.find(item => item.id === r.id)).toMatchObject({ promoted: false, stale: false });
      expect(snapshot.promotionPending !== null).toBe(operation === "promote");
      expect(await releases(f.id)).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(["other-agent", "same-agent-new-claim"] as const)("preserves a replacement claim at ledger finalization: %s", async (replacement) => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    const next = { ...(await state(f.id)).claims[0]!,
      agent: replacement === "other-agent" ? "beta" : "alpha",
      repoName: replacement === "other-agent" ? f.b : f.a,
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    await mutate(f.id, (instance, objectState) => {
      const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
      vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        return { ...prepared, push: async (...pushArgs) => {
          await prepared.push(...pushArgs);
          // Defensive storage race injection; public routes remain serialized.
          await objectState.storage.put("claim:one", next);
        } };
      });
    });
    try {
      expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(200);
      expect((await state(f.id)).claims).toEqual([next]);
      expect(await releases(f.id)).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it("serializes owner close with promotion and never duplicates the release audit", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    const responses = await Promise.all([
      api(f.id, `/reviews/${r.id}/promote`, OWNER, {}),
      api(f.id, "/packets/one/claim", OWNER, undefined, "DELETE"),
    ]);
    expect(responses[1]!.status).toBe(200);
    expect([200, 409]).toContain(responses[0]!.status);
    expect((await state(f.id)).claims).toEqual([]);
    expect(await releases(f.id)).toHaveLength(1);
    expect((await releases(f.id))[0]!.releasedBy).toBe(responses[0]!.status === 200 ? "promote" : "owner");
  });

  it.each(["heads", "prepare", "pending", "token", "push", "ledger"] as const)(
    "correlates a sanitized promote failure at %s, preserving cleanup and fencing", async (stage) => {
      const f = await fixture();
      await packet(f.id);
      await claim(f.id, f.alpha);
      const r = await review(f.id, f.alpha, f.a);
      const provider = Object.assign(new Error("Bearer api_fixture_secret https://provider.idiot.tax/private"), {
        name: "GitError", code: "FixtureFailure", status: 503,
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await mutate(f.id, (instance, objectState) => {
          if (stage === "heads") vi.spyOn(instance.fixture, "get").mockRejectedValueOnce(provider);
          if (stage === "prepare") vi.spyOn(instance.gitFixture, "preparePromote").mockRejectedValueOnce(provider);
          if (stage === "pending") {
            const original = objectState.storage.put.bind(objectState.storage);
            vi.spyOn(objectState.storage, "put").mockImplementation(async (...args: unknown[]) => {
              if (args[0] === "promotionPending") throw provider;
              return (original as (...args: unknown[]) => Promise<void>)(...args);
            });
          }
          if (stage === "token") instance.fixture.beforeTokenCreate = async (repo) => { if (repo === f.id) throw provider; };
          if (stage === "push") vi.spyOn(instance.gitFixture, "preparePromote").mockResolvedValue({
            sha: AFTER, push: async () => { throw provider; },
          });
          if (stage === "ledger") {
            const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
            vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
              const prepared = await prepare(...args);
              return { ...prepared, push: async (...pushArgs) => {
                await prepared.push(...pushArgs);
                vi.spyOn(objectState.storage, "transaction").mockRejectedValueOnce(provider);
              } };
            });
          }
        });
        const response = await api(f.id, `/reviews/${r.id}/promote`, OWNER, {});
        expect(response.status).toBe(502);
        const payload = await response.json<{ error: string; diagnosticId: string }>();
        expect(payload).toEqual({
          error: "Repository operation failed; retry or ask the owner to inspect it.",
          diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
        expect(log.mock.calls).toEqual([[JSON.stringify({
          event: "core.error", id: payload.diagnosticId, op: "review.promote", stage,
          name: "GitError", code: "FixtureFailure", status: 503,
        })]]);
        expect((await state(f.id)).promotionPending !== null).toBe(["token", "push", "ledger"].includes(stage));
        expect((await state(f.id)).claims).toMatchObject([{ packet: "one", agent: "alpha" }]);
        expect(await releases(f.id)).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("reads bare default branches for creation, caller heads and review through promotion", async () => {
    const branch = "release/candidate";
    const f = await fixture(branch);
    await mutate(f.id, async (_instance, objectState) => {
      expect(await objectState.storage.get("canonicalHead")).toBe(BEFORE);
    });
    const me = await (await api(f.id, "/me", f.alpha)).json<{ forks: { head: string }[] }>();
    expect(me.forks.map((fork) => fork.head)).toEqual([BEFORE]);
    expect((await state(f.id)).forks.map((fork) => fork.head)).toEqual([BEFORE, BEFORE]);
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    expect(r.base).toBe(BEFORE);
    expect((await api(f.id, `/reviews/${r.id}/promote`, OWNER, {})).status).toBe(200);
    expect((await state(f.id)).ledger).toMatchObject([{ before: BEFORE, after: AFTER }]);
    await mutate(f.id, async (instance) => {
      const reads = instance.fixture.calls.filter((call) => call.method === "log");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((call) => call.ref === branch)).toBe(true);
      expect(instance.fixture.heads.get(f.id)).toBe(AFTER);
      using repo = await instance.fixture.get(f.id);
      expect(await repo.log({ ref: `refs/heads/${branch}`, limit: 1 })).toEqual([]);
      expect(await repo.log({ ref: "HEAD", limit: 1 })).toEqual([]);
      expect(await repo.log({ ref: "main", limit: 1 })).toEqual([]);
      instance.fixture.heads.set(f.id, "0".repeat(40));
      expect(await branchHead(repo, branch)).toBe("0".repeat(40));
    });
  });

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

  it.each(["main", "release/candidate"])("keeps a newer review current when older push events arrive on %s", async (branch) => {
    const f = await fixture(branch);
    await packet(f.id);
    await claim(f.id, f.alpha);
    // Two remote pushes happen before either queued event is delivered.
    const older = await review(f.id, f.alpha, f.a);
    const newerSha = "b".repeat(40);
    const newer = await review(f.id, f.alpha, f.a, "one", newerSha, false);
    await mutate(f.id, (instance) => { instance.fixture.calls.length = 0; });
    const firstEvent = push(f.a, BEFORE, AFTER, `refs/heads/${branch}`);
    const secondEvent = push(f.a, AFTER, newerSha, `refs/heads/${branch}`);
    for (const event of [firstEvent, secondEvent]) {
      expect(await stub(f.id).recordPush(event)).toBe(true);
      await mutate(f.id, async (instance, objectState) => {
        // Inspect stored flags: /state also reads heads and could mask a broken write.
        expect(await objectState.storage.get<Review>(`review:${newer.id}`)).toMatchObject({ sha: newerSha, stale: false });
        expect(await objectState.storage.get<Review>(`review:${older.id}`)).toMatchObject({ stale: true });
        expect(instance.fixture.calls.filter(call => call.method === "log").at(-1)).toMatchObject({ repo: f.a, ref: branch });
      });
      expect((await api(f.id, `/reviews/${newer.id}/approve`, OWNER, {})).status).toBe(200);
    }
    await mutate(f.id, async (_instance, objectState) => {
      expect(await objectState.storage.get("sequence")).toBe(2);
    });
    expect(await stub(f.id).recordPush(firstEvent)).toBe(true);
    await mutate(f.id, async (_instance, objectState) => {
      expect(await objectState.storage.get("sequence")).toBe(2);
      expect(await objectState.storage.get<Review>(`review:${newer.id}`)).toMatchObject({ stale: false });
    });
  });

  it.each(["throws", "empty"])("falls back to the event head when the fork log %s", async (failure) => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const older = await review(f.id, f.alpha, f.a, "one", BEFORE);
    const current = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (instance) => {
      const get = instance.fixture.get.bind(instance.fixture);
      vi.spyOn(instance.fixture, "get").mockImplementation(async name => {
        const repo = await get(name);
        repo.log = async () => {
          if (failure === "throws") throw new Error("offline-provider-failure");
          return [];
        };
        return repo;
      });
    });
    try {
      expect(await stub(f.id).recordPush(push(f.a))).toBe(true);
      await mutate(f.id, async (_instance, objectState) => {
        expect(await objectState.storage.get<Review>(`review:${current.id}`)).toMatchObject({ stale: false });
        expect(await objectState.storage.get<Review>(`review:${older.id}`)).toMatchObject({ stale: true });
        expect(await objectState.storage.get("sequence")).toBe(1);
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves default-branch reviews current on a non-default-branch push", async () => {
    const f = await fixture();
    await packet(f.id);
    await claim(f.id, f.alpha);
    const r = await review(f.id, f.alpha, f.a);
    await mutate(f.id, (instance) => { instance.fixture.calls.length = 0; });
    expect(await stub(f.id).recordPush(push(f.a, AFTER, BEFORE, "refs/heads/topic"))).toBe(true);
    await mutate(f.id, async (instance, objectState) => {
      expect(await objectState.storage.get<Review>(`review:${r.id}`)).toMatchObject({ stale: false });
      expect(instance.fixture.calls.some(call => call.method === "log")).toBe(false);
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

  it("ignores advisory receipt changes but invalidates approval when its claim is released", async () => {
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
    expect((await state(f.id)).reviews[0]?.stale).toBe(false);
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
    const winner = snapshot.reviews.find(r => r.promoted)!;
    expect(snapshot.claims).toHaveLength(1);
    expect(snapshot.claims[0]!.packet).not.toBe(winner.packet);
    expect(await releases(f.id)).toMatchObject([{ releasedBy: "promote", review: winner.id }]);
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
    expect((await state(f.id)).claims).toHaveLength(1);
    expect(await releases(f.id)).toEqual([]);
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
    for (const token of [OWNER, f.alpha])
      expect((await api(f.id, "/packets/one/claim", token, undefined, "DELETE")).status).toBe(409);
    expect((await state(f.id)).claims).toHaveLength(1);
    expect(await releases(f.id)).toEqual([]);
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


async function ready() {
  const f = await fixture();
  await packet(f.id);
  await claim(f.id, f.alpha);
  return { ...f, review: await review(f.id, f.alpha, f.a) };
}

describe("FH-039 return and detail API in workerd with offline providers", () => {

  it("returns atomically, clears approval, persists audit, blocks approval/promotion and becomes stale after push", async () => {
    const f = await ready();
    const route = `/reviews/${f.review.id}/return`;
    for (const token of [f.alpha, f.beta, "invalid"])
      expect((await api(f.id, route, token, { reason: "Fix this" })).status).toBe(403);
    for (const reason of [undefined, null, 12, "", " ", "x".repeat(2001)])
      expect((await api(f.id, route, OWNER, { reason })).status).toBe(400);
    const response = await api(f.id, route, OWNER, { reason: "Please fix the boundary." });
    expect(response.status).toBe(200);
    const returned = (await response.json<{ review: Review }>()).review;
    expect(returned).toMatchObject({ approval: null, stale: false, returned: { reason: "Please fix the boundary.", at: expect.any(String) } });
    expect((await state(f.id)).reviews[0]!.returned).toEqual(returned.returned);
    await mutate(f.id, async (_instance, objectState) => {
      expect([...(await objectState.storage.list({ prefix: "reviewReturn:" })).values()]).toEqual([
        { review: f.review.id, packet: "one", agent: "alpha", returnedBy: "owner", ...returned.returned },
      ]);
      expect((await objectState.storage.get<Review>(`review:${f.review.id}`))!.returned).toEqual(returned.returned);
    });
    for (const operation of ["approve", "promote"]) {
      const denied = await api(f.id, `/reviews/${f.review.id}/${operation}`, OWNER, {});
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({ error: "Review was returned to the agent." });
    }
    await mutate(f.id, (instance) => { instance.fixture.heads.set(f.a, BEFORE); });
    await stub(f.id).recordPush(push(f.a, AFTER, BEFORE));
    expect((await state(f.id)).reviews[0]).toMatchObject({ stale: true, returned: returned.returned });
    const fresh = await review(f.id, f.alpha, f.a);
    expect(fresh.returned).toBeNull();
  });

  it("rolls back return state and approval if the audit transaction fails", async () => {
    const f = await ready();
    const initial = (await state(f.id)).reviews[0]!;
    await mutate(f.id, (_instance, objectState) => {
      const transaction = objectState.storage.transaction.bind(objectState.storage);
      vi.spyOn(objectState.storage, "transaction").mockImplementation(callback => transaction(async txn => {
        const put = txn.put.bind(txn);
        vi.spyOn(txn, "put").mockImplementation(async (...args: unknown[]) => {
          await (put as (...args: unknown[]) => Promise<void>)(...args);
          if (typeof args[0] === "object" && args[0] !== null && Object.keys(args[0]).some(key => key.startsWith("reviewReturn:")))
            throw new Error("offline return audit persistence failure");
        });
        return callback(txn);
      }));
    });
    try {
      expect((await api(f.id, `/reviews/${f.review.id}/return`, OWNER, { reason: "Revise" })).status).toBe(502);
      expect((await state(f.id)).reviews[0]).toEqual(initial);
      await mutate(f.id, async (_instance, objectState) => {
        expect((await objectState.storage.list({ prefix: "reviewReturn:" })).size).toBe(0);
      });
    } finally { vi.restoreAllMocks(); }
  });

  it("rechecks a returned review inside the approval transaction", async () => {
    const f = await ready();
    await mutate(f.id, (_instance, objectState) => {
      const transaction = objectState.storage.transaction.bind(objectState.storage);
      vi.spyOn(objectState.storage, "transaction").mockImplementationOnce(async callback => {
        const current = (await objectState.storage.get<Review>(`review:${f.review.id}`))!;
        await objectState.storage.put(`review:${f.review.id}`, { ...current, approval: null, returned: { reason: "Race fixture", at: new Date().toISOString() } });
        return transaction(callback);
      });
    });
    try {
      const response = await api(f.id, `/reviews/${f.review.id}/approve`, OWNER, {});
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Review was returned to the agent." });
      expect((await state(f.id)).reviews[0]!.approval).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });

  it("rejects promoted and uncertain reviews; serializes return versus promotion", async () => {
    const f = await ready();
    const responses = await Promise.all([
      api(f.id, `/reviews/${f.review.id}/return`, OWNER, { reason: "Revise" }),
      api(f.id, `/reviews/${f.review.id}/promote`, OWNER, {}),
    ]);
    expect(responses.map(r => r.status).toSorted()).toEqual([200, 409]);
    const snap = await state(f.id);
    expect(snap.reviews[0]!.returned !== null).toBe(!snap.reviews[0]!.promoted);
    const g = await ready();
    expect((await api(g.id, `/reviews/${g.review.id}/promote`, OWNER, {})).status).toBe(200);
    expect((await api(g.id, `/reviews/${g.review.id}/return`, OWNER, { reason: "Late" })).status).toBe(409);
    const h = await ready();
    await mutate(h.id, async (_instance, objectState) => { await objectState.storage.put("promotionPending", { review: h.review.id }); });
    expect((await api(h.id, `/reviews/${h.review.id}/return`, OWNER, { reason: "Uncertain" })).status).toBe(409);
  });

  it("rechecks returned state after asynchronous promotion preparation before issuing a canonical token", async () => {
    const f = await ready();
    await mutate(f.id, (instance, objectState) => {
      const prepare = instance.gitFixture.preparePromote.bind(instance.gitFixture);
      vi.spyOn(instance.gitFixture, "preparePromote").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        const current = (await objectState.storage.get<Review>(`review:${f.review.id}`))!;
        await objectState.storage.put(`review:${f.review.id}`, { ...current, returned: { reason: "Race fixture", at: new Date().toISOString() } });
        return prepared;
      });
    });
    try {
      const denied = await api(f.id, `/reviews/${f.review.id}/promote`, OWNER, {});
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({ error: "Review was returned to the agent." });
      await mutate(f.id, instance => {
        expect(instance.fixture.calls.some(c => c.repo === f.id && c.method === "createToken")).toBe(false);
        expect(instance.gitFixture.pushes).toEqual([]);
      });
    } finally { vi.restoreAllMocks(); }
  });

  it("authorizes detail/diff only for owner or review agent, projects exact public fields and links its promotion", async () => {
    const f = await ready();
    const route = `/reviews/${f.review.id}`;
    await mutate(f.id, async (instance, objectState) => {
      instance.fixture.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
      instance.fixture.reviewBlobs.set("8".repeat(40), new Blob(["after\n"]));
      await objectState.storage.put("blocker:ours", { id: "ours", packet: "one", paths: ["src/index.ts"] });
      await objectState.storage.put("blocker:other", { id: "other", packet: "two", paths: ["docs"] });
    });
    for (const token of [f.beta, "invalid"]) {
      expect((await api(f.id, route, token)).status).toBe(403);
      expect((await api(f.id, route + "/diff?path=src%2Findex.ts", token)).status).toBe(403);
    }
    expect((await api(f.id, "/reviews/missing", f.alpha)).status).toBe(404);
    for (const token of [OWNER, f.alpha]) {
      const response = await api(f.id, route, token);
      expect(response.status).toBe(200);
      const detail = await response.json<{ review: Review; packet: unknown; changes: { base: string; head: string }; commits: unknown[]; commitsTruncated: boolean; promotion: unknown; blockers: { id: string }[] }>();
      expect(Object.keys(detail).toSorted()).toEqual(["blockers", "changes", "commits", "commitsTruncated", "packet", "promotion", "review"]);
      expect(detail.review.returned).toBeNull();
      expect(detail.packet).toEqual({ id: "one", title: "one", goal: "Fixture goal", paths: ["src/**"], acceptance: ["Fixture check"] });
      expect(detail.changes).toMatchObject({ base: BEFORE, head: AFTER });
      expect(detail.commits).toHaveLength(1);
      expect(detail.commitsTruncated).toBe(false);
      expect(detail.promotion).toBeNull();
      expect(detail.blockers.map(b => b.id)).toEqual(["ours"]);
      const serialized = JSON.stringify(detail);
      for (const forbidden of ["receiptGeneration", "tokenHash", "stdout", "stderr", f.alpha, "scoped-"])
        expect(serialized).not.toContain(forbidden);
      const diff = await api(f.id, route + "/diff?path=src%2Findex.ts", token);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({ path: "src/index.ts", status: "modified", binary: false, truncated: false });
    }
    expect((await api(f.id, route + "/diff?path=unchanged", f.alpha)).status).toBe(404);
    expect((await api(f.id, route + "/diff?path=..%2Foutside", f.alpha)).status).toBe(404);
    expect((await api(f.id, `/reviews/${f.review.id}/promote`, OWNER, {})).status).toBe(200);
    const detail = await (await api(f.id, route, f.alpha)).json<{ promotion: unknown }>();
    const ledger = (await state(f.id)).ledger[0]!;
    expect(detail.promotion).toEqual({ before: ledger.before, after: ledger.after, recordedAt: ledger.recordedAt, receiptDigest: ledger.receiptDigest });
  });

  it("normalizes legacy returned state and sanitizes failed provider reads", async () => {
    const f = await ready();
    await mutate(f.id, async (instance, objectState) => {
      const current = { ...(await objectState.storage.get<Review>(`review:${f.review.id}`))! } as Partial<Review>;
      delete current.returned;
      await objectState.storage.put(`review:${f.review.id}`, current);
      instance.fixture.failTree = true;
    });
    expect((await state(f.id)).reviews[0]!.returned).toBeNull();
    const response = await api(f.id, `/reviews/${f.review.id}`, f.alpha);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Invalid repository object");
  });
});
