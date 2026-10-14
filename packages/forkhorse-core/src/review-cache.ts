import type { ReviewReader } from "./review-detail";

export type ReviewGitDetail = {
  changes: Awaited<ReturnType<ReviewReader["changes"]>>["public"];
} & Awaited<ReturnType<ReviewReader["history"]>>;
type ReviewPatch = Awaited<ReturnType<ReviewReader["diff"]>>;
interface CachedPair {
  order: number;
  detail?: ReviewGitDetail;
  patches: ReviewPatch[];
}

// Version the representation independently from review records. UTF-8 JSON includes
// bookkeeping and patches; leave ample room below the DO's per-value limit.
export const REVIEW_CACHE_MAX_BYTES = 64 * 1024;
export const REVIEW_CACHE_MAX_ENTRIES = 32;
export const REVIEW_CACHE_PREFIX = "reviewGitCache:v1:pair:";
const sequenceKey = "reviewGitCache:v1:sequence";
const encoder = new TextEncoder();
const keyFor = (base: string, head: string) => `${REVIEW_CACHE_PREFIX}${base}:${head}`;

/** Project-local immutable Git data only. Call after authorization, within the
 * Supervisor's serialization gate; never store an assembled review response. */
export class ReviewCache {
  constructor(private storage: DurableObjectStorage) {}

  async detail(base: string, head: string, load: () => Promise<ReviewGitDetail>): Promise<ReviewGitDetail> {
    const key = keyFor(base, head);
    const cached = await this.storage.get<CachedPair>(key);
    if (cached?.detail) return cached.detail;
    // Await the whole read before storing anything. Throws and explicitly capped
    // results leave the cache unchanged and retain the reader's public behavior.
    const detail = await load();
    if (!detail.changes.truncated && !detail.commitsTruncated)
      await this.save(key, current => ({ ...current, detail }));
    return detail;
  }

  async diff(base: string, head: string, path: string, load: () => Promise<{ patch: ReviewPatch; complete: boolean }>): Promise<ReviewPatch> {
    const key = keyFor(base, head);
    const cached = await this.storage.get<CachedPair>(key);
    const patch = cached?.patches.find(candidate => candidate.path === path);
    if (patch) return patch;
    const { patch: result, complete } = await load();
    if (complete && !result.truncated)
      await this.save(key, current => ({ ...current,
        patches: [...current.patches.filter(candidate => candidate.path !== path), result],
      }));
    return result;
  }

  private async save(key: string, update: (current: CachedPair) => CachedPair): Promise<void> {
    await this.storage.transaction(async txn => {
      const previous = await txn.get<CachedPair>(key);
      const order = previous?.order ?? ((await txn.get<number>(sequenceKey)) ?? 0) + 1;
      const value = update(previous ?? { order, patches: [] });
      // A skipped update retains any smaller, complete values already cached.
      if (encoder.encode(JSON.stringify(value)).length > REVIEW_CACHE_MAX_BYTES) return;
      if (!previous) {
        const entries = await txn.list<CachedPair>({ prefix: REVIEW_CACHE_PREFIX, limit: REVIEW_CACHE_MAX_ENTRIES + 1 });
        const oldest = [...entries].toSorted((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
        const evict = oldest.slice(0, Math.max(0, entries.size - REVIEW_CACHE_MAX_ENTRIES + 1)).map(([entryKey]) => entryKey);
        if (evict.length) await txn.delete(evict);
        await txn.put(sequenceKey, order);
      }
      await txn.put(key, value);
    });
  }
}
