import { RpcTarget } from "cloudflare:workers";
import { loadChecks, MissingChecksError } from "../../forkhorse-runner/src/checks";
import { receiptJson, requirePassingReceipt, sha256 } from "../../forkhorse-runner/src/runner";
import type { AuthorizedReview, ReviewAuthority, RunRequest, StoredReceipt } from "../../forkhorse-runner/src/types";
import { HttpError } from "./http";
import type { Env, Project } from "./types";
import type { Claim, ClaimReleaseAudit, Fork, ReceiptSummary, Review } from "./workflow-types";

export const settings = (project: Project) => project.settings ?? { requireReceipt: false };
export const publicReview = ({ receiptGeneration: _generation, ...review }: Review) => ({
  ...review, receipt: review.receipt ?? null, returned: review.returned ?? null,
});
export type ExecuteReceipt = (
  request: RunRequest, authority: ReceiptAuthority, generation: string,
) => Promise<StoredReceipt>;
const same = (review: Review | undefined, run: AuthorizedReview) =>
  review && !review.stale && (!review.promoted || run.trigger === "review-created") && review.id === run.reviewId &&
  review.sha === run.commit && review.repoName === run.forkRepoName &&
  review.receiptGeneration === run.generation && review.receipt?.trigger === run.trigger;

/** Immutable content-addressed records. Chunks stay well below the 128 KiB value limit,
 * including worst-case UTF-8 expansion. The manifest is committed with all chunks. */
export async function storeReceipt(storage: DurableObjectStorage, record: StoredReceipt): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(record.digest) || await sha256(receiptJson(record.receipt)) !== record.digest)
    throw new Error("Invalid receipt digest");
  const serialized = JSON.stringify(record);
  if (serialized.length > 8 * 1024 * 1024) throw new Error("Receipt too large");
  const chunks = Array.from({ length: Math.ceil(serialized.length / 16384) }, (_, i) =>
    serialized.slice(i * 16384, (i + 1) * 16384));
  await storage.transaction(async (txn) => {
    const key = `receipt:${record.digest}`;
    if (await txn.get(key)) return;
    for (let i = 0; i < chunks.length; i++) await txn.put(`${key}:${i}`, chunks[i]!);
    await txn.put(key, { chunks: chunks.length });
  });
}
export async function readReceipt(storage: DurableObjectStorage, digest: string | null): Promise<StoredReceipt | null> {
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return null;
  const key = `receipt:${digest}`;
  const manifest = await storage.get<{ chunks: number }>(key);
  if (!manifest) return null;
  if (!Number.isInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > 512)
    throw new Error("Invalid receipt manifest");
  const chunks: string[] = [];
  for (let i = 0; i < manifest.chunks; i++) {
    const chunk = await storage.get<string>(`${key}:${i}`);
    if (chunk === undefined) throw new Error("Incomplete receipt");
    chunks.push(chunk);
  }
  const record = JSON.parse(chunks.join("")) as StoredReceipt;
  if (record.digest !== digest || await sha256(receiptJson(record.receipt)) !== digest)
    throw new Error("Invalid stored receipt");
  return record;
}

/** A capability for ONE reserved execution, sent only to the same-script runner.
 * These callbacks deliberately do not acquire Supervisor's workflow mutex: promote
 * owns that mutex while awaiting the runner. Attachment uses a storage transaction. */
export class ReceiptAuthority extends RpcTarget implements ReviewAuthority {
  #storage: DurableObjectStorage;
  #run: AuthorizedReview;
  constructor(storage: DurableObjectStorage, run: AuthorizedReview) {
    super(); this.#storage = storage; this.#run = structuredClone(run);
  }
  async authorize(request: RunRequest): Promise<AuthorizedReview> {
    if (request.reviewId !== this.#run.reviewId || request.trigger !== this.#run.trigger ||
        !same(await this.#storage.get<Review>(`review:${request.reviewId}`), this.#run))
      throw new Error("Stale receipt execution");
    return structuredClone(this.#run);
  }
  async storeReceipt(record: StoredReceipt): Promise<void> {
    const r = record.receipt, run = this.#run;
    if (r.projectId !== run.projectId || r.reviewId !== run.reviewId || r.commit !== run.commit ||
        r.generation !== run.generation || r.trigger !== run.trigger || r.forkRepoName !== run.forkRepoName)
      throw new Error("Receipt outside capability");
    await storeReceipt(this.#storage, record);
  }
  async setReviewReceiptDigest(run: AuthorizedReview, digest: string): Promise<boolean> {
    if (Object.keys(this.#run).some(key => run[key as keyof AuthorizedReview] !== this.#run[key as keyof AuthorizedReview])) return false;
    const record = await readReceipt(this.#storage, digest);
    if (!record || record.receipt.generation !== run.generation || record.receipt.commit !== run.commit ||
        record.receipt.reviewId !== run.reviewId || record.receipt.projectId !== run.projectId ||
        record.receipt.forkRepoName !== run.forkRepoName || record.receipt.trigger !== run.trigger) return false;
    return this.#storage.transaction(async (txn) => {
      const review = await txn.get<Review>(`review:${run.reviewId}`);
      if (!same(review, run) || !review || review.receiptDigest !== null) return false;
      const claim = await txn.get<Claim>(`claim:${review.packet}`);
      // A promoted advisory run may finish after its claim was atomically released,
      // including after a new claim is made. Only its exact promotion audit restores
      // that historical binding; same() still fences stale commits and generations.
      const release = review.promoted && run.trigger === "review-created"
        ? await txn.get<ClaimReleaseAudit>(`claimRelease:${review.id}`) : undefined;
      const promotedBinding = release?.releasedBy === "promote" && release.review === review.id &&
        release.packet === review.packet && release.agent === review.agent && release.repoName === review.repoName;
      if (!promotedBinding && (!claim || claim.repoName !== review.repoName || claim.agent !== review.agent)) return false;
      const checks = record.receipt.checks;
      const status: ReceiptSummary["status"] = !checks.length ? "infrastructure-error"
        : checks.some(c => c.outcome === "infrastructure-error") ? "infrastructure-error"
        : checks.some(c => c.outcome === "timed-out") ? "timed-out"
        : checks.some(c => c.outcome === "failed") ? "failed" : "passed";
      const finishedAt = new Date().toISOString();
      review.receiptDigest = digest;
      review.receipt = {
        ...review.receipt!, status, digest, finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(review.receipt!.startedAt)),
        checks: checks.map(c => ({ name: c.check.name, tier: "full", outcome: c.outcome, durationMs: c.durationMs })),
      };
      await txn.put(`review:${review.id}`, review);
      return true;
    });
  }
}

/** Invoked only after project/caller/claim/fork/head authorization in Workflow. */
export class Receipts {
  constructor(private storage: DurableObjectStorage, private env: Env,
    private execute: ExecuteReceipt, private background: (job: Promise<void>) => void) {}

  async reserve(project: Project, review: Review, fork: Fork, trigger: RunRequest["trigger"]): Promise<AuthorizedReview> {
    if (fork.repoName === project.repoName || fork.repoName !== review.repoName || fork.agent !== review.agent ||
        await this.storage.get(`repo:${fork.repoName}`) !== review.agent)
      throw new Error("Receipt requires an authorized fork");
    const run: AuthorizedReview = {
      reviewId: review.id, trigger, projectId: project.id, forkRepoName: fork.repoName,
      forkRemote: fork.remote, commit: review.sha, generation: crypto.randomUUID(),
    };
    review.receiptGeneration = run.generation;
    review.receiptDigest = null;
    review.receipt = {
      status: "running", trigger, digest: null, startedAt: new Date().toISOString(),
      finishedAt: null, durationMs: null, checks: [],
    };
    await this.storage.put(`review:${review.id}`, review);
    return run;
  }
  start(run: AuthorizedReview, advisory = false): void {
    this.background(this.run(run, advisory).then(() => {}));
  }
  async run(run: AuthorizedReview, advisory = false): Promise<StoredReceipt | null> {
    try {
      const authority = new ReceiptAuthority(this.storage, run);
      await authority.authorize(run);
      using repo = await this.env.ARTIFACTS.get(run.forkRepoName);
      const checks = await loadChecks(repo, run.commit);
      await this.storage.transaction(async txn => {
        const review = await txn.get<Review>(`review:${run.reviewId}`);
        if (!same(review, run) || !review) throw new Error("Stale receipt execution");
        review.receipt!.checks = checks.map(c => ({ name: c.name, tier: "full", outcome: "running", durationMs: null }));
        await txn.put(`review:${review.id}`, review);
      });
      return await this.execute({ reviewId: run.reviewId, trigger: run.trigger }, authority, run.generation);
    } catch (error) {
      // Missing checks/images, startup and cleanup errors have no publishable receipt.
      // Never expose provider exceptions, tokens, or commands in the state projection.
      await this.storage.transaction(async txn => {
        const review = await txn.get<Review>(`review:${run.reviewId}`);
        if (!same(review, run) || !review || review.receiptDigest) return;
        if (advisory && error instanceof MissingChecksError) {
          review.receipt = null;
          review.receiptGeneration = undefined;
          await txn.put(`review:${review.id}`, review);
          return;
        }
        const finishedAt = new Date().toISOString();
        review.receipt = { ...review.receipt!, status: "infrastructure-error", finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(review.receipt!.startedAt)),
          checks: review.receipt!.checks.map(c => ({ ...c, outcome: "infrastructure-error" })),
        };
        await txn.put(`review:${review.id}`, review);
      });
      return null;
    }
  }
  async requirePassing(project: Project, review: Review): Promise<void> {
    try {
      if (!settings(project).requireReceipt) return;
      using repo = await this.env.ARTIFACTS.get(review.repoName);
      await requirePassingReceipt(await readReceipt(this.storage, review.receiptDigest), {
        projectId: project.id, reviewId: review.id, forkRepoName: review.repoName, commit: review.sha,
        generation: review.receiptGeneration ?? "", digest: review.receiptDigest,
        checks: await loadChecks(repo, review.sha), requireReceipt: true,
      });
    } catch { throw new HttpError(409, "A current passing container receipt is required."); }
  }
}

/** A terminated execution is never silently resumed or presented as passing. */
export async function recoverInterruptedReceipts(storage: DurableObjectStorage): Promise<void> {
  await storage.transaction(async txn => {
    for (const review of (await txn.list<Review>({ prefix: "review:" })).values()) {
      if (review.receipt?.status !== "running") continue;
      const finishedAt = new Date().toISOString();
      review.receiptGeneration = undefined;
      review.receiptDigest = null;
      review.receipt = { ...review.receipt, status: "infrastructure-error", digest: null, finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(review.receipt.startedAt)),
        checks: review.receipt.checks.map(check => ({ ...check, outcome: "infrastructure-error" })),
      };
      await txn.put(`review:${review.id}`, review);
    }
  });
}
