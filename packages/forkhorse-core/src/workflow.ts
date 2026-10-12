import { publicReview, readReceipt, settings } from "./receipts";
import type { Receipts } from "./receipts";
import { publicEvents } from "./subscriptions";
import { branchHead } from "./artifacts";
import { body, digest, HttpError, isRecord, json, slug } from "./http";
import type { ErrorContext } from "./http";
import { claimPath, filePath, overlaps, requireCovered } from "./paths";
import { staleBase } from "./git";
import type { GitOperations } from "./git";
import { ZERO_SHA } from "./trees";
import { capActivity } from "./activity";
import type { StoredActivity } from "./activity";
import type { Activity, Env, Project, PushEvent } from "./types";
import type {
  Blocker,
  Claim,
  CommitFile,
  Fork,
  LedgerEntry,
  Packet,
  ReconcilerAlert,
  Review,
  StateSnapshot,
} from "./workflow-types";

export interface Actor {
  owner: boolean;
  agent?: string;
}
export interface Agent {
  name: string;
  tokenHash: string;
}
const now = () => new Date().toISOString();
const shaPattern = /^[0-9a-f]{40}$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = async <T>(storage: DurableObjectStorage, prefix: string): Promise<T[]> => [
  ...(await storage.list<T>({ prefix })).values(),
];

/** Called only inside the Supervisor's serialization gate, after project authentication. */
export class Workflow {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private git: GitOperations,
    private diagnostic: ErrorContext = { op: "request" },
    private receipts?: Receipts,
  ) {}

  private owner(actor: Actor): void {
    if (!actor.owner) throw new HttpError(403, "Only the owner can perform this operation.");
  }
  private agent(actor: Actor): string {
    if (!actor.agent || actor.owner) throw new HttpError(403, "An agent credential is required.");
    return actor.agent;
  }
  private async fork(project: Project, repoName: unknown, agent: string): Promise<Fork> {
    if (typeof repoName !== "string")
      throw new HttpError(409, "A registered fork binding is required.");
    const owner = await this.storage.get<string | null>(`repo:${repoName}`);
    if (repoName === project.repoName || (owner !== undefined && owner !== agent))
      throw new HttpError(403, "Canonical and foreign repositories are forbidden.");
    const fork = await this.storage.get<Fork>(`fork:${repoName}`);
    if (!fork || owner !== agent || fork.agent !== agent)
      throw new HttpError(409, "A registered caller-owned fork is required.");
    return fork;
  }
  async head(repoName: string, branch: string): Promise<string> {
    using repo = await this.env.ARTIFACTS.get(repoName);
    return await branchHead(repo, branch);
  }
  private async binding(
    project: Project,
    packet: unknown,
    repoName: unknown,
    agent: string,
  ): Promise<{ claim: Claim; fork: Fork }> {
    const fork = await this.fork(project, repoName, agent);
    if (!slug(packet)) throw new HttpError(400, "packet must be a packet ID.");
    const claim = await this.storage.get<Claim>(`claim:${packet}`);
    if (!claim || claim.agent !== agent || claim.repoName !== repoName)
      throw new HttpError(409, "A live matching packet, agent and fork binding is required.");
    return { claim, fork };
  }

  async route(request: Request, project: Project, actor: Actor): Promise<Response | null> {
    const path = new URL(request.url).pathname.slice(`/projects/${project.id}`.length);
    const method = request.method;
    if (path === "/settings" && method === "PATCH") {
      this.owner(actor);
      const data = await body(request);
      if (Object.keys(data).length !== 1 || typeof data.requireReceipt !== "boolean")
        throw new HttpError(400, "Provide only requireReceipt as a boolean.");
      project.settings = { requireReceipt: data.requireReceipt };
      await this.storage.put("project", project);
      return json({ settings: project.settings });
    }
    const receiptRoute = /^\/reviews\/([^/]+)\/receipt$/.exec(path);
    if (receiptRoute && method === "GET") {
      this.owner(actor);
      const review = await this.storage.get<Review>(`review:${receiptRoute[1]}`);
      const receipt = await readReceipt(this.storage, review?.receiptDigest ?? null);
      if (!receipt) throw new HttpError(404, "Receipt not found.");
      return json(receipt);
    }
    if (path === "/agents" && method === "POST") {
      this.owner(actor);
      const data = await body(request);
      if (!slug(data.agent, 32))
        throw new HttpError(400, "agent must be a lowercase slug of at most 32 characters.");
      if (await this.storage.get(`agent:${data.agent}`))
        throw new HttpError(409, "Agent already enrolled.");
      if ((await list(this.storage, "agent:")).length >= 50)
        throw new HttpError(409, "Agent limit reached.");
      return this.credential(data.agent, 201);
    }
    const rotation = /^\/agents\/([^/]+)\/rotate$/.exec(path);
    if (rotation && method === "POST") {
      this.owner(actor);
      const agent = rotation[1]!;
      if (!slug(agent, 32) || !(await this.storage.get(`agent:${agent}`)))
        throw new HttpError(404, "Agent not found.");
      return this.credential(agent, 200);
    }
    if (path === "/packets" && method === "GET")
      return json({ packets: await list<Packet>(this.storage, "packet:") });
    if (path === "/packets" && method === "POST") {
      this.owner(actor);
      const data = await body(request);
      if (
        !slug(data.id) ||
        !text(data.title, 200) ||
        !text(data.goal, 4000) ||
        !Array.isArray(data.paths) ||
        data.paths.length < 1 ||
        data.paths.length > 200 ||
        !data.paths.every(claimPath) ||
        !Array.isArray(data.acceptance) ||
        data.acceptance.length < 1 ||
        data.acceptance.length > 100 ||
        !data.acceptance.every((entry) => text(entry, 2000))
      )
        throw new HttpError(400, "Invalid packet fields.");
      const packet: Packet = {
        id: data.id,
        title: data.title,
        goal: data.goal,
        paths: [...new Set(data.paths)],
        acceptance: data.acceptance as string[],
      };
      if (await this.storage.get(`packet:${packet.id}`))
        throw new HttpError(409, "Packet already exists.");
      await this.storage.put(`packet:${packet.id}`, packet);
      return json({ packet }, 201);
    }
    const claiming = /^\/packets\/([^/]+)\/claim$/.exec(path);
    if (claiming && (method === "POST" || method === "DELETE")) {
      const agent = this.agent(actor);
      const packetId = claiming[1]!;
      const packet = await this.storage.get<Packet>(`packet:${packetId}`);
      if (!packet) throw new HttpError(404, "Packet not found.");
      const current = await this.storage.get<Claim>(`claim:${packetId}`);
      if (method === "DELETE") {
        if (current && current.agent !== agent)
          throw new HttpError(403, "Claim belongs to another agent.");
        if (await this.storage.get("promotionPending"))
          throw new HttpError(409, "Promotion needs owner inspection.");
        await this.storage.transaction(async (txn) => {
          await txn.delete(`claim:${packetId}`);
          for (const review of (await txn.list<Review>({ prefix: "review:" })).values()) {
            if (review.packet === packetId && !review.promoted)
              await txn.put(`review:${review.id}`, { ...review, stale: true });
          }
        });
        return json({ released: true });
      }
      const data = request.body ? await body(request) : {};
      if (current) {
        if (
          current.agent !== agent ||
          (data.repoName !== undefined && data.repoName !== current.repoName)
        )
          throw new HttpError(409, "Claim is already bound; release it before changing forks.");
        await this.fork(project, current.repoName, agent);
        return json({ claim: current });
      }
      const repoName = data.repoName ?? (await this.storage.get<string>(`latestFork:${agent}`));
      const fork = await this.fork(project, repoName, agent);
      const claims = await list<Claim>(this.storage, "claim:");
      if (
        claims.some(
          (claim) =>
            claim.agent !== agent &&
            claim.paths.some((a) => packet.paths.some((b) => overlaps(a, b))),
        )
      )
        throw new HttpError(409, "Paths overlap another agent's live claim.");
      const claim: Claim = {
        packet: packetId,
        agent,
        repoName: fork.repoName,
        paths: packet.paths,
        createdAt: now(),
      };
      // Supervisor serializes discovery and this atomic record; no partially bound claim is visible.
      await this.storage.put(`claim:${packetId}`, claim);
      return json({ claim }, 201);
    }
    const committing = /^\/forks\/([^/]+)\/commit$/.exec(path);
    if (committing && method === "POST") {
      const agent = this.agent(actor);
      // The entire wire body is bounded, not just string character count or Content-Length.
      const data = await body(request, 1024 * 1024);
      const { claim, fork } = await this.binding(project, data.packet, committing[1], agent);
      if (
        !text(data.message, 4000) ||
        !Array.isArray(data.files) ||
        data.files.length < 1 ||
        data.files.length > 200 ||
        !data.files.every(
          (file) => isRecord(file) && filePath(file.path) && typeof file.content === "string",
        )
      )
        throw new HttpError(400, "Provide a message and 1 to 200 valid text files.");
      const files = data.files as unknown as CommitFile[];
      if (new Set(files.map((file) => file.path)).size !== files.length)
        throw new HttpError(400, "Duplicate file path.");
      requireCovered(
        claim.paths,
        files.map((file) => file.path),
      );
      const base = await this.head(fork.repoName, project.defaultBranch);
      const prepared = await this.git.prepareCommit(
        fork,
        project.defaultBranch,
        base,
        files,
        data.message,
      );
      using repo = await this.env.ARTIFACTS.get(fork.repoName);
      const token = await repo.createToken("write", 60);
      try {
        await prepared.push(fork.remote, token.plaintext, base);
      } finally {
        await repo.revokeToken(token.id);
      }
      await this.invalidate(fork.repoName, prepared.sha);
      return json({ repoName: fork.repoName, packet: claim.packet, sha: prepared.sha }, 201);
    }
    if (path === "/blockers" && method === "GET")
      return json({ blockers: await list<Blocker>(this.storage, "blocker:") });
    if (path === "/reviews" && method === "POST") {
      const agent = this.agent(actor);
      const data = await body(request);
      const { claim, fork } = await this.binding(project, data.packet, data.repoName, agent);
      if (typeof data.sha !== "string" || !shaPattern.test(data.sha) || data.sha === ZERO_SHA)
        throw new HttpError(400, "sha must be a commit SHA.");
      if ((await this.head(fork.repoName, project.defaultBranch)) !== data.sha)
        throw new HttpError(409, "Review commit is not the fork head.");
      const review: Review = {
        id: crypto.randomUUID(),
        packet: claim.packet,
        agent,
        repoName: fork.repoName,
        sha: data.sha,
        base: await this.head(project.repoName, project.defaultBranch),
        receiptDigest: null,
        approval: null,
        stale: false,
        promoted: false,
        createdAt: now(),
      };
      if (!this.receipts) throw new Error("Receipt integration required");
      const run = await this.receipts.reserve(project, review, fork, "review-created");
      this.receipts.start(run, !settings(project).requireReceipt);
      return json({ review: publicReview(review) }, 201);
    }
    const reviewing = /^\/reviews\/([^/]+)\/(approve|promote)$/.exec(path);
    if (reviewing && method === "POST") {
      this.owner(actor);
      const review = await this.storage.get<Review>(`review:${reviewing[1]}`);
      if (!review) throw new HttpError(404, "Review not found.");
      if (await this.storage.get("promotionPending"))
        throw new HttpError(409, "Promotion needs owner inspection.");
      if (review.promoted) throw staleBase();
      const { fork } = await this.binding(project, review.packet, review.repoName, review.agent);
      if (reviewing[2] === "promote") this.diagnostic.stage = "heads";
      if (
        review.stale ||
        (await this.head(review.repoName, project.defaultBranch)) !== review.sha
      ) {
        await this.storage.put(`review:${review.id}`, { ...review, stale: true });
        throw new HttpError(409, "Approval is stale; request review again.");
      }
      const requireReceipt = settings(project).requireReceipt;
      if (reviewing[2] === "approve") {
        if (requireReceipt) {
          if (!this.receipts) throw new Error("Receipt integration required");
          await this.receipts.requirePassing(project, review);
        }
        const approved = await this.storage.transaction(async txn => {
          const current = await txn.get<Review>(`review:${review.id}`);
          if (!current || current.stale || current.promoted || current.sha !== review.sha)
            throw new HttpError(409, "Approval is stale; request review again.");
          if (requireReceipt && (current.receiptGeneration !== review.receiptGeneration || current.receiptDigest !== review.receiptDigest))
            throw new HttpError(409, "Receipt changed; approve again.");
          current.approval = { sha: current.sha, receiptDigest: current.receiptDigest };
          await txn.put(`review:${review.id}`, current);
          return current;
        });
        return json({ review: publicReview(approved) });
      }
      if (
        !review.approval ||
        review.approval.sha !== review.sha
      )
        throw new HttpError(409, "Approval does not match the commit.");
      if ((await this.head(project.repoName, project.defaultBranch)) !== review.base)
        throw staleBase();
      // Advisory promotion neither invokes nor waits for the check runner. Owner
      // consent binds the commit; required projects establish fresh receipt evidence below.
      let checkedGeneration: string | undefined;
      if (requireReceipt) {
        if (!this.receipts) throw new Error("Receipt integration required");
        const run = await this.receipts.reserve(project, review, fork, "before-promote");
        const result = await this.receipts.run(run);
        const current = await this.storage.get<Review>(`review:${review.id}`);
        if (!current || current.stale || current.promoted || current.sha !== run.commit ||
            current.receiptGeneration !== run.generation || current.receipt?.trigger !== "before-promote")
          throw new HttpError(409, "Approval is stale; request review again.");
        Object.assign(review, current);
        if (!result || result.digest !== review.receiptDigest || result.receipt.trigger !== "before-promote" || result.receipt.commit !== run.commit ||
            result.receipt.generation !== run.generation || result.receipt.reviewId !== run.reviewId ||
            result.receipt.projectId !== project.id || result.receipt.forkRepoName !== fork.repoName ||
            !result.receipt.checks.length || result.receipt.checks.some(c => c.outcome !== "passed" || c.exitStatus !== 0))
          throw new HttpError(409, "Checks failed before promote.");
        try { await this.receipts.requirePassing(project, review); }
        catch { throw new HttpError(409, "Checks failed before promote."); }
        checkedGeneration = run.generation;
      }
      this.diagnostic.stage = "prepare";
      const prepared = await this.git.preparePromote(
        fork,
        project.defaultBranch,
        review.sha,
        review.base,
      );
      // Re-read both heads after preparation. Transport also checks canonical's advertised old SHA.
      this.diagnostic.stage = "heads";
      if ((await this.head(review.repoName, project.defaultBranch)) !== review.sha)
        throw new HttpError(409, "Approval is stale; request review again.");
      if ((await this.head(project.repoName, project.defaultBranch)) !== review.base)
        throw staleBase();
      const checked = await this.storage.get<Review>(`review:${review.id}`);
      if (!checked || checked.stale || checked.promoted || checked.sha !== review.sha)
        throw new HttpError(409, "Approval is stale; request review again.");
      if (requireReceipt && (checked.receiptGeneration !== checkedGeneration || checked.receiptDigest !== review.receiptDigest ||
          checked.receipt?.trigger !== "before-promote"))
        throw new HttpError(409, "Receipt changed before promote.");
      // A background advisory receipt may have completed during preparation.
      Object.assign(review, checked);
      const entry: LedgerEntry = {
        id: crypto.randomUUID(),
        review: review.id,
        repoName: project.repoName,
        ref: `refs/heads/${project.defaultBranch}`,
        before: review.base,
        after: review.sha,
        receiptDigest: review.receiptDigest,
        recordedAt: now(),
      };
      // Persist an intent before external I/O. An uncertain push never gets retried automatically.
      this.diagnostic.stage = "pending";
      await this.storage.put("promotionPending", entry);
      this.diagnostic.stage = "token";
      using canonical = await this.env.ARTIFACTS.get(project.repoName);
      const token = await canonical.createToken("write", 60);
      try {
        this.diagnostic.stage = "push";
        await prepared.push(project.remote, token.plaintext, review.base);
        this.diagnostic.stage = "ledger";
        await this.storage.transaction(async (txn) => {
          const latest = await txn.get<Review>(`review:${review.id}`);
          await txn.put({
            [`ledger:${entry.id}`]: entry,
            canonicalHead: review.sha,
            // Keep any advisory result attached while the canonical push was in flight.
            [`review:${review.id}`]: { ...latest!, promoted: true },
          });
          await txn.delete("promotionPending");
        });
      } catch (error) {
        // A definite preflight/CAS rejection is safe to retry after a new review.
        // Transport/storage uncertainty keeps the durable intent for inspection/reconciliation.
        if (error instanceof HttpError && error.status === 409)
          await this.storage.delete("promotionPending");
        throw error;
      } finally {
        // Successful cleanup preserves the original failure stage; cleanup failures identify token.
        const previousStage = this.diagnostic.stage;
        this.diagnostic.stage = "token";
        await canonical.revokeToken(token.id);
        this.diagnostic.stage = previousStage;
      }
      return json({ sha: review.sha });
    }
    if (path === "/state" && method === "GET") return this.state(project);
    return null;
  }

  private async credential(agent: string, status: number): Promise<Response> {
    const apiToken =
      "api_" +
      [...crypto.getRandomValues(new Uint8Array(32))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    await this.storage.put(`agent:${agent}`, { name: agent, tokenHash: await digest(apiToken) });
    return json({ agent, apiToken }, status);
  }
  private async invalidate(repoName: string, sha: string): Promise<void> {
    await this.storage.transaction(async txn => {
      for (const review of (await txn.list<Review>({ prefix: "review:" })).values()) {
        if (review.repoName === repoName && review.sha !== sha && !review.promoted)
          await txn.put(`review:${review.id}`, { ...review, stale: true });
      }
    });
  }
  private async state(project: Project): Promise<Response> {
    const forks = await list<Fork>(this.storage, "fork:");
    const heads = new Map<string, string>();
    for (const fork of forks)
      heads.set(fork.repoName, await this.head(fork.repoName, project.defaultBranch));
    const reviews = await list<Review>(this.storage, "review:");
    for (const review of reviews) {
      if (!review.promoted && !review.stale && heads.get(review.repoName) !== review.sha) {
        await this.storage.transaction(async txn => {
          const current = await txn.get<Review>(`review:${review.id}`);
          if (current) {
            current.stale = true;
            await txn.put(`review:${review.id}`, current);
            Object.assign(review, current);
          }
        });
      }
    }
    const current = await this.head(project.repoName, project.defaultBranch);
    const expected = await this.storage.get<string>("canonicalHead");
    const alerts = await list<ReconcilerAlert>(this.storage, "alert:");
    if (expected !== undefined && expected !== current)
      alerts.push({
        id: "current-head",
        repoName: project.repoName,
        ref: `refs/heads/${project.defaultBranch}`,
        before: expected,
        after: current,
        reason: "Canonical head differs from the merge ledger.",
      });
    return json({
      project: { ...project, settings: settings(project), ...await publicEvents(this.storage, project.repoName) },
      agents: (await list<Agent>(this.storage, "agent:")).map(({ name }) => ({ name })),
      forks: await Promise.all(forks.map(async (fork) => ({ ...fork, ...await publicEvents(this.storage, fork.repoName), head: heads.get(fork.repoName)! }))),
      packets: await list<Packet>(this.storage, "packet:"),
      claims: await list<Claim>(this.storage, "claim:"),
      blockers: await list<Blocker>(this.storage, "blocker:"),
      reviews: reviews.map(publicReview),
      ledger: (await list<LedgerEntry>(this.storage, "ledger:")).toSorted((a, b) =>
        a.recordedAt.localeCompare(b.recordedAt),
      ),
      activity: [
        ...(
          await this.storage.list<StoredActivity>({ prefix: "activity:", reverse: true, limit: 100 })
        ).values(),
      ].toReversed().map(capActivity),
      reconcilerAlerts: alerts,
      promotionPending: (await this.storage.get<LedgerEntry>("promotionPending")) ?? null,
    } satisfies StateSnapshot);
  }
}

/** Add conflict/reconciler records in the same transaction as FH-003's activity and dedupe key. */
export async function recordWorkflowPush(
  txn: DurableObjectTransaction,
  project: Project,
  event: PushEvent,
  entry: Activity,
): Promise<void> {
  if (entry.agent) {
    for (const claim of (await txn.list<Claim>({ prefix: "claim:" })).values()) {
      const paths = entry.changedPaths.filter((path) =>
        claim.paths.some((claimed) => overlaps(claimed, path)),
      );
      if (claim.agent !== entry.agent && paths.length) {
        const id = `${entry.sequence}-${claim.packet}`;
        const blocker: Blocker = {
          id,
          packet: claim.packet,
          claimingAgent: claim.agent,
          pushingAgent: entry.agent,
          repoName: entry.repoName,
          sha: entry.after,
          paths,
        };
        await txn.put(`blocker:${id}`, blocker);
      }
    }
    if (entry.ref === `refs/heads/${project.defaultBranch}`) {
      for (const review of (await txn.list<Review>({ prefix: "review:" })).values()) {
        if (review.repoName === entry.repoName && !review.promoted && review.sha !== entry.after)
          await txn.put(`review:${review.id}`, { ...review, stale: true });
      }
    }
  } else {
    const ledger = [...(await txn.list<LedgerEntry>({ prefix: "ledger:" })).values()];
    let matched = false;
    for (const merge of ledger) {
      if (
        merge.repoName === entry.repoName &&
        merge.ref === entry.ref &&
        merge.before === entry.before &&
        merge.after === entry.after &&
        !(await txn.get(`ledgerEvent:${merge.id}`))
      ) {
        await txn.put(`ledgerEvent:${merge.id}`, entry.sequence);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const alert: ReconcilerAlert = {
        id: String(entry.sequence),
        repoName: entry.repoName,
        ...event.payload,
        reason: "Canonical push is absent from the merge ledger.",
      };
      await txn.put(`alert:${alert.id}`, alert);
    }
  }
}
