import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Activity, Project, PushEvent, Repository } from "../src/types";
import type { Blocker, Claim } from "../src/workflow-types";
import { ZERO_SHA } from "../src/trees";
import { TestSupervisor } from "./worker";

const OLD = "1".repeat(40), CANONICAL = "2".repeat(40), MERGE = "a".repeat(40);
const EDIT = "b".repeat(40), DELETION = "c".repeat(40), BOTH_DELETED = "d".repeat(40);
const A = "src/a.ts", B = "src/b.ts";
const blob = (name: string, hash: string): ArtifactsTreeEntry => ({ name, hash, type: "blob", mode: "100644" });

async function fixture() {
  const id = `catch-up-${crypto.randomUUID().slice(0, 8)}`;
  const fork = `${id}--builder-1`;
  const project: Project = { id, namespace: "fixture", repoName: id, remote: `https://git.idiot.tax/${id}`, defaultBranch: "main" };
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
  const mutate = async (callback: (instance: TestSupervisor, state: DurableObjectState) => void | Promise<void>) =>
    runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof TestSupervisor)) throw new Error("Expected offline fixture supervisor");
      await callback(instance, state);
    });
  await mutate(async (instance, state) => {
    await instance.fixture.create(id);
    await instance.fixture.create(fork);
    instance.fixture.heads.set(id, CANONICAL);
    // Exact Git snapshots: MERGE has canonical as a parent and the same promoted files.
    const snapshots: [string, string, ArtifactsTreeEntry[], string[]][] = [
      [OLD, "3".repeat(40), [blob("a.ts", "7".repeat(40)), blob("b.ts", "7".repeat(40))], []],
      [CANONICAL, "4".repeat(40), [blob("a.ts", "8".repeat(40)), blob("b.ts", "8".repeat(40))], [OLD]],
      [MERGE, "5".repeat(40), [blob("a.ts", "8".repeat(40)), blob("b.ts", "8".repeat(40))], [OLD, CANONICAL]],
      [EDIT, "6".repeat(40), [blob("a.ts", "9".repeat(40)), blob("b.ts", "8".repeat(40))], [CANONICAL]],
      [DELETION, "e".repeat(40), [blob("b.ts", "8".repeat(40))], [CANONICAL]],
      [BOTH_DELETED, "f".repeat(40), [], [CANONICAL]],
    ];
    for (const [sha, tree, files, parents] of snapshots) {
      // Separate root/subtree IDs; unrelated canonical trees must never be visited.
      const root = tree.slice(0, 39) + "0";
      instance.fixture.reviewCommits.set(sha, {
        hash: sha, treeHash: root, parents, message: "Offline push fixture",
        author: { name: "Fixture", email: "fixture@idiot.tax" },
        committer: { name: "Fixture", email: "fixture@idiot.tax" }, authoredAt: 1, committedAt: 1,
      });
      instance.fixture.reviewTrees.set(root, [
        { name: "src", type: "tree", mode: "40000", hash: tree },
        { name: "unrelated", type: "tree", mode: "40000", hash: "0".repeat(39) + "1" },
      ]);
      instance.fixture.reviewTrees.set(tree, files);
    }
    instance.fixture.reviewTrees.set("0".repeat(39) + "1", []);
    const claim: Claim = {
      packet: "claimed", agent: "claimant", repoName: `${id}--claimant-1`, paths: ["src"],
      createdAt: "2026-10-13T12:00:00Z", usage: { reported: null, metered: null },
    };
    await state.storage.put({
      project, [`repo:${id}`]: null, [`repo:${fork}`]: "builder", "claim:claimed": claim,
      "claim:builder": { ...claim, packet: "builder", agent: "builder", repoName: fork, paths: ["own"] },
    });
  });
  const push = async (after: string, before = OLD) => {
    const event: PushEvent = {
      type: "cf.artifacts.repo.pushed", source: { namespace: "fixture", repoName: fork },
      payload: { ref: "refs/heads/main", before, after }, metadata: { eventTimestamp: "2026-10-13T13:00:00Z" },
    };
    expect(await stub.recordPush(event)).toBe(true);
    return runInDurableObject(stub, async (instance, state) => {
      if (!(instance instanceof TestSupervisor)) throw new Error("Expected offline fixture supervisor");
      return {
        blockers: [...(await state.storage.list<Blocker>({ prefix: "blocker:" })).values()],
        activity: [...(await state.storage.list<Activity>({ prefix: "activity:" })).values()],
        calls: instance.fixture.calls,
      };
    });
  };
  return { id, fork, mutate, push };
}

describe("catch-up trespass detection in workerd with offline Artifacts fixtures", () => {
  it.each([CANONICAL, MERGE])("does not block a fast-forward or merge to canonical content (%s)", async head => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const f = await fixture();
    const result = await f.push(head);
    expect(result.blockers).toEqual([]);
    expect(result.activity[0]?.changedPaths).toEqual([A, B]);
    expect(result.calls.some(call => call.method === "readBlob" || call.method === "createToken")).toBe(false);
    expect((await f.push(head)).activity).toHaveLength(1);
  });

  it("blocks a real edit with the original pushing-packet attribution", async () => {
    const f = await fixture();
    const result = await f.push(EDIT, CANONICAL);
    expect(result.blockers).toMatchObject([{
      packet: "claimed", claimingAgent: "claimant", pushingAgent: "builder", pushingPacket: "builder",
      repoName: f.fork, sha: EDIT, paths: [A], resolved: null, at: result.activity[0]!.recordedAt,
    }]);
  });

  it("flags only the edited path in a mixed catch-up push", async () => {
    const f = await fixture();
    const result = await f.push(EDIT);
    expect(result.activity[0]?.changedPaths).toEqual([A, B]);
    expect(result.blockers.map(blocker => blocker.paths)).toEqual([[A]]);
  });

  it.each([true, false])("flags an unseen path claimed after precomputation (initial overlaps: %s)", async initialOverlap => {
    const f = await fixture();
    const readsInsideTransaction: string[] = [];
    await f.mutate(async (instance, state) => {
      const original = (await state.storage.get<Claim>("claim:claimed"))!;
      if (initialOverlap) await state.storage.put("claim:claimed", { ...original, paths: [A] });
      else await state.storage.delete("claim:claimed");
      const lateClaim: Claim = { ...original, packet: "late", agent: "late",
        repoName: `${f.id}--late-1`, paths: [B],
      };
      const transaction = state.storage.transaction.bind(state.storage);
      let inTransaction = false;
      vi.spyOn(state.storage, "transaction").mockImplementationOnce(async callback => {
        // This path was not a candidate when Git was read; it is claimed just
        // before the transaction, which must re-read claims and flag it anyway.
        await state.storage.put("claim:late", lateClaim);
        return transaction(async txn => {
          inTransaction = true;
          try { return await callback(txn); }
          finally { inTransaction = false; }
        });
      });
      const get = instance.fixture.get.bind(instance.fixture);
      vi.spyOn(instance.fixture, "get").mockImplementation(async name => {
        const observe = (method: string) => {
          if (inTransaction) readsInsideTransaction.push(`${name}:${method}`);
        };
        observe("get");
        const repo = await get(name);
        const log = repo.log.bind(repo), readCommit = repo.readCommit.bind(repo), readTree = repo.readTree.bind(repo);
        repo.log = async options => { observe("log"); return log(options); };
        repo.readCommit = async sha => { observe("readCommit"); return readCommit(sha); };
        repo.readTree = async hash => { observe("readTree"); return readTree(hash); };
        return repo;
      });
    });
    const result = await f.push(MERGE);
    expect(result.activity[0]?.changedPaths).toEqual([A, B]);
    expect(result.blockers).toMatchObject([{
      packet: "late", claimingAgent: "late", pushingPacket: "builder", paths: [B], resolved: null,
    }]);
    expect(result.blockers).toHaveLength(1);
    expect(readsInsideTransaction).toEqual([]);
  });

  it.each([DELETION, ZERO_SHA])("blocks deletion while the path still exists in canonical (%s)", async head => {
    const f = await fixture();
    const result = await f.push(head, CANONICAL);
    expect(result.blockers.map(blocker => blocker.paths)).toEqual([head === ZERO_SHA ? [A, B] : [A]]);
  });

  it("does not block a path already deleted in canonical", async () => {
    const f = await fixture();
    await f.mutate(instance => { instance.fixture.heads.set(f.id, BOTH_DELETED); });
    expect((await f.push(BOTH_DELETED)).blockers).toEqual([]);
  });

  it("compares the event's pushed commit even if the fork head has moved again", async () => {
    const f = await fixture();
    await f.mutate(instance => { instance.fixture.heads.set(f.fork, EDIT); });
    expect((await f.push(MERGE)).blockers).toEqual([]);
  });

  it.each(["readCommit", "readTree"])("retains overlaps when the pushed %s becomes unavailable after diffing", async failure => {
    const f = await fixture();
    await f.mutate(instance => {
      const get = instance.fixture.get.bind(instance.fixture);
      vi.spyOn(instance.fixture, "get").mockImplementation(async name => {
        const repo = await get(name);
        if (name !== f.fork) return repo;
        if (failure === "readCommit") {
          const readCommit = repo.readCommit.bind(repo);
          let reads = 0;
          repo.readCommit = async sha => ++reads > 2 ? null : readCommit(sha);
        } else {
          const readTree = repo.readTree.bind(repo);
          let reads = 0;
          repo.readTree = async hash => {
            if (hash === "5".repeat(39) + "0" && ++reads > 1) return null;
            return readTree(hash);
          };
        }
        return repo;
      });
    });
    expect((await f.push(MERGE)).blockers.map(blocker => blocker.paths)).toEqual([[A, B]]);
  });

  it.each(["get", "log", "readCommit", "readTree", "missing-head", "partial-tree"])(
    "retains all raw overlaps when canonical read fails at %s", async failure => {
      const f = await fixture();
      await f.mutate(instance => {
        if (failure === "missing-head") { instance.fixture.heads.delete(f.id); return; }
        const get = instance.fixture.get.bind(instance.fixture);
        vi.spyOn(instance.fixture, "get").mockImplementation(async name => {
          if (name === f.id && failure === "get") throw new Error("Offline canonical failure");
          const repo = await get(name);
          if (name !== f.id) return repo;
          if (failure === "partial-tree") {
            const readTree = repo.readTree.bind(repo);
            repo.readTree = async hash => hash === "4".repeat(40) ? null : readTree(hash);
          } else repo[failure as "log" | "readCommit" | "readTree"] = (async () => {
            throw new Error("Offline canonical failure");
          }) as Repository["log"] & Repository["readCommit"] & Repository["readTree"];
          return repo;
        });
      });
      expect((await f.push(MERGE)).blockers.map(blocker => blocker.paths)).toEqual([[A, B]]);
    },
  );

  it("reads canonical only for overlaps and never descends into unrelated subtrees", async () => {
    const f = await fixture();
    await f.mutate(instance => {
      const get = instance.fixture.get.bind(instance.fixture);
      vi.spyOn(instance.fixture, "get").mockImplementation(async name => {
        const repo = await get(name);
        if (name === f.id) {
          const readTree = repo.readTree.bind(repo);
          repo.readTree = async hash => {
            expect(hash).not.toBe("0".repeat(39) + "1");
            return readTree(hash);
          };
        }
        return repo;
      });
    });
    const result = await f.push(MERGE);
    expect(result.blockers).toEqual([]);
    // One canonical root and one shared src tree for both overlapping paths.
    expect(result.calls.filter(call => call.repo === f.id && call.method === "readTree")).toHaveLength(2);
  });

  it("skips canonical reads when no foreign claim overlaps", async () => {
    const f = await fixture();
    await f.mutate(async (_instance, state) => { await state.storage.delete("claim:claimed"); });
    const result = await f.push(MERGE);
    expect(result.blockers).toEqual([]);
    expect(result.calls.filter(call => call.repo === f.id && ["get", "log", "readCommit", "readTree"].includes(call.method))).toEqual([]);
  });
});
