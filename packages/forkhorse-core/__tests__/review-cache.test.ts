import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ReviewReader } from "../src/review-detail";
import { ReviewCache, REVIEW_CACHE_MAX_BYTES, REVIEW_CACHE_MAX_ENTRIES, REVIEW_CACHE_PREFIX } from "../src/review-cache";
import type { ReviewGitDetail } from "../src/review-cache";
import { ZERO_SHA } from "../src/trees";
import { FixtureArtifacts, BEFORE, AFTER } from "./fixtures";

function inStorage(callback: (storage: DurableObjectStorage) => Promise<void>) {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(`cache-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_instance, state) => callback(state.storage));
}
async function fixture() {
  const artifacts = new FixtureArtifacts();
  await artifacts.create("cache-fixture");
  const repo = await artifacts.get("cache-fixture");
  const load = async (base = BEFORE, head = AFTER): Promise<ReviewGitDetail> => {
    const reader = new ReviewReader(repo);
    return { changes: (await reader.changes(base, head)).public, ...await reader.history(base, head) };
  };
  const diff = async (path: string) => {
    const reader = new ReviewReader(repo);
    const changes = await reader.changes(BEFORE, AFTER);
    return { patch: await reader.diff(path, changes), complete: !changes.public.truncated };
  };
  return { artifacts, load, diff };
}
const objectReads = (artifacts: FixtureArtifacts) => artifacts.calls.filter(c => /^read(Commit|Tree|Blob)$/.test(c.method)).length;
const entries = (storage: DurableObjectStorage) => storage.list({ prefix: REVIEW_CACHE_PREFIX });

describe("durable review Git cache in workerd (offline Artifacts fixtures)", () => {
  it("populates then hits across cache instances, with identical detail and no further object reads", async () => {
    await inStorage(async storage => {
      const f = await fixture();
      expect((await entries(storage)).size).toBe(0);
      const first = await new ReviewCache(storage).detail(BEFORE, AFTER, () => f.load());
      expect((await entries(storage)).size).toBe(1);
      const reads = objectReads(f.artifacts);
      expect(reads).toBeGreaterThan(0);
      f.artifacts.failTree = true;
      expect(await new ReviewCache(storage).detail(BEFORE, AFTER, () => f.load())).toEqual(first);
      expect(objectReads(f.artifacts)).toBe(reads);
    });
  });

  it("keys by both exact commits, including empty and reversed bases", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      const forward = await cache.detail(BEFORE, AFTER, () => f.load());
      const reverse = await cache.detail(AFTER, BEFORE, () => f.load(AFTER, BEFORE));
      const empty = await cache.detail(ZERO_SHA, AFTER, () => f.load(ZERO_SHA, AFTER));
      const same = await cache.detail(BEFORE, BEFORE, () => f.load(BEFORE, BEFORE));
      expect(reverse.changes).not.toEqual(forward.changes);
      expect(empty.commits).toHaveLength(2);
      expect(same.changes.files).toEqual([]);
      expect((await entries(storage)).size).toBe(4);
    });
  });

  it("caches requested patches by exact path and keeps missing paths and failed blobs uncached", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
      // Both tree snapshots succeed, but a missing blob must not create an entry.
      await expect(cache.diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"))).rejects.toThrow();
      expect((await entries(storage)).size).toBe(0);
      f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["after\n"]));
      const first = await cache.diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"));
      expect(first.patch).toContain("+after\n");
      const reads = objectReads(f.artifacts);
      expect(await new ReviewCache(storage).diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"))).toEqual(first);
      expect(objectReads(f.artifacts)).toBe(reads);
      expect((await cache.diff(BEFORE, AFTER, "removed.txt", () => f.diff("removed.txt"))).status).toBe("deleted");
      const saved = [...(await entries(storage)).values()];
      await expect(cache.diff(BEFORE, AFTER, "../outside", () => f.diff("../outside"))).rejects.toMatchObject({ status: 404 });
      expect([...(await entries(storage)).values()]).toEqual(saved);
    });
  });

  it("skips oversized UTF-8 values and retries the provider on the next read", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      f.artifacts.changedPaths = Array.from({ length: 190 }, (_, i) => `${i}-${"🐎".repeat(100)}`);
      const first = await cache.detail(BEFORE, AFTER, () => f.load());
      expect(first.changes.truncated).toBe(false);
      expect(JSON.stringify(first).length).toBeLessThan(REVIEW_CACHE_MAX_BYTES);
      expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeGreaterThan(REVIEW_CACHE_MAX_BYTES);
      expect((await entries(storage)).size).toBe(0);
      const reads = objectReads(f.artifacts);
      expect(await cache.detail(BEFORE, AFTER, () => f.load())).toEqual(first);
      expect(objectReads(f.artifacts)).toBeGreaterThan(reads);
    });
  });

  it("never caches failures after successful tree reads, and recovers on a complete retry", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      // Trees are valid; history fails while following a missing base ancestor.
      const badParent = "a".repeat(40);
      f.artifacts.reviewCommits.set(BEFORE, {
        hash: BEFORE, treeHash: "3".repeat(40), parents: [badParent], message: "Fixture",
        committedAt: 1, authoredAt: 1,
        author: { name: "Fixture", email: "author@idiot.tax" }, committer: { name: "Fixture", email: "author@idiot.tax" },
      });
      await expect(cache.detail(BEFORE, AFTER, () => f.load())).rejects.toThrow();
      expect(f.artifacts.calls.some(c => c.method === "readTree")).toBe(true);
      expect((await entries(storage)).size).toBe(0);
      f.artifacts.reviewCommits.delete(BEFORE);
      await cache.detail(BEFORE, AFTER, () => f.load());
      expect((await entries(storage)).size).toBe(1);
    });
  });

  it("skips partial file lists, histories, and patches without changing the response", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      f.artifacts.changedPaths = Array.from({ length: 205 }, (_, i) => `file-${i}`);
      expect((await cache.detail(BEFORE, AFTER, () => f.load())).changes.truncated).toBe(true);
      expect((await entries(storage)).size).toBe(0);
      f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["complete\n"]));
      expect((await cache.diff(BEFORE, AFTER, "file-0", () => f.diff("file-0"))).truncated).toBe(false);
      expect((await entries(storage)).size).toBe(0);
      f.artifacts.changedPaths = undefined;
      const detail = await f.load();
      const partialHistory = { ...detail, commitsTruncated: true };
      expect(await cache.detail(BEFORE, AFTER, async () => partialHistory)).toEqual(partialHistory);
      expect((await entries(storage)).size).toBe(0);
      f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["🐎\n".repeat(30000)]));
      expect((await cache.diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"))).truncated).toBe(true);
      expect((await entries(storage)).size).toBe(0);
    });
  });

  it("bounds pair count and evicts the oldest insertion even if it was recently read", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage), detail = await f.load();
      const head = (i: number) => i.toString(16).padStart(40, "0");
      for (let i = 1; i <= REVIEW_CACHE_MAX_ENTRIES; i++)
        await cache.detail(BEFORE, head(i), async () => ({ ...detail, changes: { ...detail.changes, head: head(i) } }));
      expect((await entries(storage)).size).toBe(REVIEW_CACHE_MAX_ENTRIES);
      await cache.detail(BEFORE, head(1), async () => { throw new Error("Expected cache hit"); });
      await cache.detail(BEFORE, head(REVIEW_CACHE_MAX_ENTRIES + 1), async () => detail);
      const stored = await entries(storage);
      expect(stored.size).toBe(REVIEW_CACHE_MAX_ENTRIES);
      expect(stored.has(`${REVIEW_CACHE_PREFIX}${BEFORE}:${head(1)}`)).toBe(false);
      expect(stored.has(`${REVIEW_CACHE_PREFIX}${BEFORE}:${head(2)}`)).toBe(true);
      let loaded = false;
      await cache.detail(BEFORE, head(1), async () => { loaded = true; return detail; });
      expect(loaded).toBe(true);
      expect((await entries(storage)).size).toBe(REVIEW_CACHE_MAX_ENTRIES);
    });
  });

  it("keeps an existing detail when another complete patch would exceed the aggregate size bound", async () => {
    await inStorage(async storage => {
      const f = await fixture(), cache = new ReviewCache(storage);
      const detail = await cache.detail(BEFORE, AFTER, () => f.load());
      f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
      f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["x".repeat(REVIEW_CACHE_MAX_BYTES - 300)]));
      const patch = await cache.diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"));
      expect(patch.truncated).toBe(false);
      const reads = objectReads(f.artifacts);
      await cache.diff(BEFORE, AFTER, "src/index.ts", () => f.diff("src/index.ts"));
      expect(objectReads(f.artifacts)).toBeGreaterThan(reads);
      expect(await cache.detail(BEFORE, AFTER, async () => { throw new Error("Expected detail hit"); })).toEqual(detail);
      for (const value of (await entries(storage)).values())
        expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(REVIEW_CACHE_MAX_BYTES);
    });
  });
});
