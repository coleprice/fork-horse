import { claimForAgent, entrantKey, entrants, liveClaims, markEntrant, MAX_RACE_ENTRANTS, openEntrants, placedEntrants, raceStates, recordPromoteRejected } from "./race-entrants";
import { ReviewReader } from "./review-detail";
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
import { publicPacket } from "./packets";
import { archivePacket } from "./packet-archive";
import type { StoredActivity } from "./activity";
import type { Activity, Env, Project, PushEvent } from "./types";
import type {
  Blocker,
  Claim,
  ClaimReleaseAudit,
  CommitFile,
  Fork,
  LedgerEntry,
  Packet,
  RaceEntrant,
  RaceResult,
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
  createdAt?: string;
}
const now = () => new Date().toISOString();
const shaPattern = /^[0-9a-f]{40}$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = async <T>(storage: DurableObjectStorage, prefix: string): Promise<T[]> => [
  ...(await storage.list<T>({ prefix })).values(),
];
// Legacy observations stay in storage unchanged until resolved.
type StoredBlocker = Omit<Blocker, "resolved" | "at" | "pushingPacket"> &
  Partial<Pick<Blocker, "resolved" | "at" | "pushingPacket">>;
const publicBlocker = (blocker: StoredBlocker): Blocker => ({
  ...blocker, at: blocker.at ?? null, pushingPacket: blocker.pushingPacket ?? null,
  resolved: blocker.resolved ?? null,
});

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
    const claim = await claimForAgent(this.storage, packet, agent);
    if (!claim || claim.agent !== agent || claim.repoName !== repoName)
      throw new HttpError(409, "A live matching packet, agent and fork binding is required.");
    return { claim, fork };
  }

  private async releaseClaim(
    txn: DurableObjectTransaction,
    claim: Claim,
    releasedBy: ClaimReleaseAudit["releasedBy"],
    review?: string,
    at = now(),
  ): Promise<void> {
    const race = "closedAt" in claim;
    if (race) {
      await txn.put(entrantKey(claim.packet, claim.agent), {
        ...claim, closedAt: at, closedBy: releasedBy === "promote" || releasedBy === "race-finished"
          ? "race-finished" : releasedBy === "owner" ? "owner" : "release",
      });
    } else await txn.delete(`claim:${claim.packet}`);
    for (const pending of (await txn.list<Review>({ prefix: "review:" })).values()) {
      if (pending.packet === claim.packet && !pending.promoted &&
          (!race || (pending.agent === claim.agent && pending.repoName === claim.repoName)))
        await txn.put(`review:${pending.id}`, { ...pending, stale: true });
    }
    for (const [key, blocker] of await txn.list<StoredBlocker>({ prefix: "blocker:" })) {
      // A race packet has several independent claimants/pushers. Closing one entry
      // must not resolve another entrant's collision or unblock that other fork.
      const claimantEnded = blocker.packet === claim.packet && (!race || blocker.claimingAgent === claim.agent);
      const pusherEnded = blocker.pushingPacket === claim.packet && (!race ||
        (blocker.pushingAgent === claim.agent && blocker.repoName === claim.repoName));
      if ((claimantEnded || pusherEnded) && !blocker.resolved)
        await txn.put(key, { ...publicBlocker(blocker), resolved: {
          at, by: releasedBy === "race-finished" ? "race-finished" : releasedBy === "promote" ? "promote" : "release",
        } } satisfies Blocker);
    }
    await txn.put(`claimRelease:${review ?? crypto.randomUUID()}`, {
      packet: claim.packet,
      agent: claim.agent,
      repoName: claim.repoName,
      claimedAt: claim.createdAt,
      releasedBy,
      ...(review ? { review } : {}),
      recordedAt: at,
    } satisfies ClaimReleaseAudit);
  }

  /** Called in the ledger transaction, after canonical Git CAS succeeds. */
  private async finishRace(txn: DurableObjectTransaction, claim: Claim, review: Review, entry: LedgerEntry): Promise<void> {
    const records = await entrants(txn, claim.packet);
    const winner = records.find(entrant => entrant.agent === claim.agent);
    if (!winner || winner.closedAt !== null || winner.repoName !== claim.repoName ||
        winner.createdAt !== claim.createdAt || await txn.get(`race:${claim.packet}`))
      throw new Error("Race binding changed during promotion");
    // The durable intent predates external Git I/O. Finish only after that I/O succeeds,
    // including milestones reached by advisory receipts while the push was in flight.
    const finishedAt = now();
    const placed = placedEntrants(records, winner.agent);
    for (const [index, entrant] of placed.entries()) {
      const finished = { ...entrant, place: index + 1,
        ...(entrant.agent === winner.agent ? { promotedAt: finishedAt } : {}),
      };
      if (entrant.closedAt === null) {
        // The winner retains the promote audit used by late advisory receipts.
        const winning = entrant.agent === winner.agent;
        await this.releaseClaim(txn, finished, winning ? "promote" : "race-finished",
          winning ? review.id : undefined, finishedAt);
      } else {
        // Preserve an earlier withdrawal's reason/time; it sorts after all runners.
        await txn.put(entrantKey(entrant.packet, entrant.agent), finished);
      }
    }
    await txn.put(`race:${claim.packet}`, {
      winner: winner.agent, places: placed.map((entrant, index) => ({ agent: entrant.agent, place: index + 1 })),
      finishedAt, ledgerEntryId: entry.id,
    } satisfies RaceResult);
  }

  private async rejectRacePromote(project: Project, review: Review, found?: string, rejection = staleBase()): Promise<never> {
    try {
      const head = found ?? await this.head(project.repoName, project.defaultBranch);
      if (head !== review.base || await this.storage.get(`race:${review.packet}`))
        await recordPromoteRejected(this.storage, review, head);
    }
    catch {
      // Photo-finish bookkeeping must never turn a definite 409 into an uncertain push.
      console.error(JSON.stringify({ event: "race.promote-rejection-unrecorded" }));
    }
    throw rejection;
  }

  private async raceClaim(request: Request, project: Project, packet: Packet, actor: Actor): Promise<Response> {
    const data = request.body ? await body(request) : {};
    if (request.method === "DELETE") {
      const agent = actor.owner ? data.agent : this.agent(actor);
      if (!slug(agent, 32)) throw new HttpError(400, "Provide the race entrant's agent.");
      if (await this.storage.get("promotionPending"))
        throw new HttpError(409, "Promotion needs owner inspection.");
      await this.storage.transaction(async txn => {
        const current = await claimForAgent(txn, packet.id, agent);
        if (current) await this.releaseClaim(txn, current, actor.owner ? "owner" : "agent");
      });
      return json({ released: true });
    }
    const agent = this.agent(actor);
    if (await this.storage.get(`race:${packet.id}`)) throw new HttpError(409, "Race finished.");
    const current = await this.storage.get<RaceEntrant>(entrantKey(packet.id, agent));
    if (current) {
      if (current.closedAt !== null) throw new HttpError(409, "Race entrant is closed.");
      if (data.repoName !== undefined && data.repoName !== current.repoName)
        throw new HttpError(409, "Claim is already bound; release it before changing forks.");
      await this.fork(project, current.repoName, agent);
      return json({ claim: current });
    }
    if ((await entrants(this.storage, packet.id)).length >= MAX_RACE_ENTRANTS)
      throw new HttpError(409, "Race entrant limit reached.");
    const repoName = data.repoName ?? await this.storage.get<string>(`latestFork:${agent}`);
    const fork = await this.fork(project, repoName, agent);
    if ((await liveClaims(this.storage)).some(claim => claim.packet !== packet.id &&
        claim.agent !== agent && claim.paths.some(a => packet.paths.some(b => overlaps(a, b)))))
      throw new HttpError(409, "Paths overlap another agent's live claim.");
    const entrant: RaceEntrant = {
      packet: packet.id, agent, repoName: fork.repoName, paths: packet.paths, createdAt: now(),
      firstPushAt: null, reviewRequestedAt: null, receiptPassedAt: null, approvedAt: null,
      promotedAt: null, place: null, closedAt: null, closedBy: null,
    };
    // Supervisor serializes the cap check, overlap check and immutable binding.
    await this.storage.put(entrantKey(packet.id, agent), entrant);
    return json({ claim: entrant }, 201);
  }

  private async requireNoBlockers(
    storage: DurableObjectStorage | DurableObjectTransaction,
    review: Review,
  ): Promise<void> {
    for (const blocker of (await storage.list<StoredBlocker>({ prefix: "blocker:" })).values()) {
      if (!blocker.resolved && blocker.repoName === review.repoName &&
          (blocker.pushingPacket == null || blocker.pushingPacket === review.packet))
        throw new HttpError(409, "This fork pushed into paths another agent has claimed. The owner must resolve the blocker first.");
    }
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
      return json({ packets: (await list<Packet>(this.storage, "packet:")).map(publicPacket) });
    if (path === "/packets" && method === "POST") {
      this.owner(actor);
      const data = await body(request);
      if (
        !slug(data.id) ||
        (data.mode !== undefined && data.mode !== "standard" && data.mode !== "race") ||
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
        mode: data.mode ?? "standard",
        title: data.title,
        goal: data.goal,
        paths: [...new Set(data.paths)],
        acceptance: data.acceptance as string[],
        archived: null,
      };
      if (await this.storage.get(`packet:${packet.id}`))
        throw new HttpError(409, "Packet already exists.");
      await this.storage.put(`packet:${packet.id}`, packet);
      return json({ packet }, 201);
    }
    const archiving = /^\/packets\/([^/]+)\/(archive|unarchive)$/.exec(path);
    if (archiving && method === "POST") {
      this.owner(actor);
      const action = archiving[2] === "archive" ? "archive" : "unarchive";
      return json({ packet: await archivePacket(this.storage, archiving[1]!, action) });
    }
    const claiming = /^\/packets\/([^/]+)\/claim$/.exec(path);
    if (claiming && (method === "POST" || method === "DELETE")) {
      const agent = method === "DELETE" && actor.owner ? undefined : this.agent(actor);
      const packetId = claiming[1]!;
      const packet = await this.storage.get<Packet>(`packet:${packetId}`);
      if (!packet) throw new HttpError(404, "Packet not found.");
      if (method === "POST" && packet.archived) throw new HttpError(409, "Packet is archived.");
      if (packet.mode === "race") return this.raceClaim(request, project, packet, actor);
      const current = await this.storage.get<Claim>(`claim:${packetId}`);
      if (method === "DELETE") {
        if (current && !actor.owner && current.agent !== agent)
          throw new HttpError(403, "Claim belongs to another agent.");
        if (await this.storage.get("promotionPending"))
          throw new HttpError(409, "Promotion needs owner inspection.");
        await this.storage.transaction(async (txn) => {
          const live = await txn.get<Claim>(`claim:${packetId}`);
          if (live) {
            if (!actor.owner && live.agent !== agent)
              throw new HttpError(403, "Claim belongs to another agent.");
            await this.releaseClaim(txn, live, actor.owner ? "owner" : "agent");
          }
        });
        return json({ released: true });
      }
      // POST still requires an agent; owner authority is limited to DELETE here.
      const claimingAgent = this.agent(actor);
      const data = request.body ? await body(request) : {};
      if (current) {
        if (
          current.agent !== agent ||
          (data.repoName !== undefined && data.repoName !== current.repoName)
        )
          throw new HttpError(409, "Claim is already bound; release it before changing forks.");
        await this.fork(project, current.repoName, claimingAgent);
        return json({ claim: current });
      }
      const repoName = data.repoName ?? (await this.storage.get<string>(`latestFork:${agent}`));
      const fork = await this.fork(project, repoName, claimingAgent);
      const claims = await liveClaims(this.storage);
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
        agent: claimingAgent,
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
      await this.storage.transaction(txn => markEntrant(txn, claim, "firstPushAt", now()));
      return json({ repoName: fork.repoName, packet: claim.packet, sha: prepared.sha }, 201);
    }
    if (path === "/blockers" && method === "GET")
      return json({ blockers: (await list<StoredBlocker>(this.storage, "blocker:")).map(publicBlocker) });
    const resolving = /^\/blockers\/([^/]+)\/resolve$/.exec(path);
    if (resolving && method === "POST") {
      this.owner(actor);
      const data = await body(request);
      if (!text(data.reason, 200)) throw new HttpError(400, "reason must be 1 to 200 characters.");
      const reason = data.reason;
      const blocker = await this.storage.transaction(async txn => {
        const key = `blocker:${resolving[1]}`;
        const stored = await txn.get<StoredBlocker>(key);
        if (!stored) throw new HttpError(404, "Blocker not found.");
        if (stored.resolved) return publicBlocker(stored);
        const at = now();
        const resolved: Blocker = { ...publicBlocker(stored), resolved: { at, by: "owner", reason } };
        // Resolution provenance stays on the permanent blocker record; activity is Git-only.
        await txn.put(key, resolved);
        return resolved;
      });
      return json({ blocker });
    }
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
        returned: null,
        createdAt: now(),
      };
      if (!this.receipts) throw new Error("Receipt integration required");
      const run = await this.receipts.reserve(project, review, fork, "review-created");
      this.receipts.start(run, !settings(project).requireReceipt);
      return json({ review: publicReview(review) }, 201);
    }
    const detail = /^\/reviews\/([^/]+)(\/diff)?$/.exec(path);
    if (detail && method === "GET") {
      const review = await this.storage.get<Review>(`review:${detail[1]}`);
      if (!review) throw new HttpError(404, "Review not found.");
      if (!actor.owner && actor.agent !== review.agent)
        throw new HttpError(403, "Review belongs to another agent.");
      using repo = await this.env.ARTIFACTS.get(review.repoName);
      const reader = new ReviewReader(repo);
      const changes = await reader.changes(review.base, review.sha);
      if (detail[2]) return json(await reader.diff(new URL(request.url).searchParams.get("path") ?? "", changes));
      const packet = await this.storage.get<Packet>(`packet:${review.packet}`);
      if (!packet) throw new HttpError(404, "Packet not found.");
      // Historical stores can grow indefinitely; fail closed instead of scanning without a budget.
      const ledgerEntries = await this.storage.list<LedgerEntry>({ prefix: "ledger:", limit: 2049 });
      const blockerEntries = await this.storage.list<StoredBlocker>({ prefix: "blocker:", limit: 2049 });
      if (ledgerEntries.size > 2048 || blockerEntries.size > 2048)
        throw new HttpError(413, "Review exceeds the bounded read limit.");
      const ledger = [...ledgerEntries.values()].find(entry => entry.review === review.id);
      return json({ review: publicReview(review),
        packet: { id: packet.id, title: packet.title, goal: packet.goal, paths: packet.paths, acceptance: packet.acceptance },
        changes: changes.public, ...await reader.history(review.base, review.sha),
        promotion: ledger ? { before: ledger.before, after: ledger.after, recordedAt: ledger.recordedAt, receiptDigest: ledger.receiptDigest } : null,
        blockers: [...blockerEntries.values()].filter(blocker => blocker.packet === review.packet).map(publicBlocker),
      });
    }
    const returning = /^\/reviews\/([^/]+)\/return$/.exec(path);
    if (returning && method === "POST") {
      this.owner(actor);
      const data = await body(request);
      if (!text(data.reason, 2000)) throw new HttpError(400, "reason must be 1 to 2000 characters.");
      const reason = data.reason;
      const returned = await this.storage.transaction(async txn => {
        const review = await txn.get<Review>(`review:${returning[1]}`);
        if (!review) throw new HttpError(404, "Review not found.");
        if (review.promoted) throw new HttpError(409, "Review was already promoted.");
        if (await txn.get("promotionPending")) throw new HttpError(409, "Promotion needs owner inspection.");
        review.returned = { reason, at: now() };
        review.approval = null;
        await txn.put({
          [`review:${review.id}`]: review,
          [`reviewReturn:${crypto.randomUUID()}`]: { review: review.id, packet: review.packet, agent: review.agent, returnedBy: "owner", ...review.returned },
        });
        return review;
      });
      return json({ review: publicReview(returned) });
    }
    const reviewing = /^\/reviews\/([^/]+)\/(approve|promote)$/.exec(path);
    if (reviewing && method === "POST") {
      this.owner(actor);
      const review = await this.storage.get<Review>(`review:${reviewing[1]}`);
      if (!review) throw new HttpError(404, "Review not found.");
      if (review.returned) throw new HttpError(409, "Review was returned to the agent.");
      if (await this.storage.get("promotionPending"))
        throw new HttpError(409, "Promotion needs owner inspection.");
      if (review.promoted) throw staleBase();
      const race = (await this.storage.get<Packet>(`packet:${review.packet}`))?.mode === "race";
      // Finished entrants have no live binding and their reviews are stale. Preserve
      // the photo-finish response before those guards hide the canonical CAS loss.
      if (race && reviewing[2] === "promote" && await this.storage.get(`race:${review.packet}`))
        return this.rejectRacePromote(project, review);
      const { claim, fork } = await this.binding(project, review.packet, review.repoName, review.agent);
      await this.requireNoBlockers(this.storage, review);
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
          if (current?.returned) throw new HttpError(409, "Review was returned to the agent.");
          if (!current || current.stale || current.promoted || current.sha !== review.sha)
            throw new HttpError(409, "Approval is stale; request review again.");
          if (requireReceipt && (current.receiptGeneration !== review.receiptGeneration || current.receiptDigest !== review.receiptDigest))
            throw new HttpError(409, "Receipt changed; approve again.");
          await this.requireNoBlockers(txn, current);
          current.approval = { sha: current.sha, receiptDigest: current.receiptDigest };
          await txn.put(`review:${review.id}`, current);
          await markEntrant(txn, claim, "approvedAt", now());
          return current;
        });
        return json({ review: publicReview(approved) });
      }
      if (
        !review.approval ||
        review.approval.sha !== review.sha
      )
        throw new HttpError(409, "Approval does not match the commit.");
      const beforeChecks = await this.head(project.repoName, project.defaultBranch);
      if (beforeChecks !== review.base) {
        if (race) return this.rejectRacePromote(project, review, beforeChecks);
        throw staleBase();
      }
      // Advisory promotion neither invokes nor waits for the check runner. Owner
      // consent binds the commit; required projects establish fresh receipt evidence below.
      let checkedGeneration: string | undefined;
      if (requireReceipt) {
        if (!this.receipts) throw new Error("Receipt integration required");
        const run = await this.receipts.reserve(project, review, fork, "before-promote");
        const result = await this.receipts.run(run);
        const current = await this.storage.get<Review>(`review:${review.id}`);
        if (current?.returned) throw new HttpError(409, "Review was returned to the agent.");
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
      const beforePush = await this.head(project.repoName, project.defaultBranch);
      if (beforePush !== review.base) {
        if (race) return this.rejectRacePromote(project, review, beforePush);
        throw staleBase();
      }
      const checked = await this.storage.get<Review>(`review:${review.id}`);
      if (checked?.returned) throw new HttpError(409, "Review was returned to the agent.");
      if (!checked || checked.stale || checked.promoted || checked.sha !== review.sha)
        throw new HttpError(409, "Approval is stale; request review again.");
      if (requireReceipt && (checked.receiptGeneration !== checkedGeneration || checked.receiptDigest !== review.receiptDigest ||
          checked.receipt?.trigger !== "before-promote"))
        throw new HttpError(409, "Receipt changed before promote.");
      // A background advisory receipt may have completed during preparation.
      Object.assign(review, checked);
      await this.requireNoBlockers(this.storage, review);
      const entry: LedgerEntry = {
        id: crypto.randomUUID(),
        review: review.id,
        repoName: project.repoName,
        ref: `refs/heads/${project.defaultBranch}`,
        before: review.base,
        after: review.sha,
        receiptDigest: review.receiptDigest,
        recordedAt: now(),
        ...(race ? { race: review.packet } : {}),
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
          if (race) await this.finishRace(txn, claim, review, entry);
          else {
            const live = await claimForAgent(txn, review.packet, review.agent);
            // Never erase a replacement binding, even if it names the same packet.
            if (live && live.agent === claim.agent && live.repoName === claim.repoName &&
                live.createdAt === claim.createdAt)
              await this.releaseClaim(txn, live, "promote", review.id);
          }
          await txn.delete("promotionPending");
        });
      } catch (error) {
        // A definite preflight/CAS rejection is safe to retry after a new review.
        // Transport/storage uncertainty keeps the durable intent for inspection/reconciliation.
        if (error instanceof HttpError && error.status === 409) {
          await this.storage.delete("promotionPending");
          if (race) return await this.rejectRacePromote(project, review, undefined, error);
        }
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
    const previous = await this.storage.get<Agent>(`agent:${agent}`);
    await this.storage.put(`agent:${agent}`, {
      name: agent, tokenHash: await digest(apiToken),
      ...(previous ? (previous.createdAt ? { createdAt: previous.createdAt } : {}) : { createdAt: now() }),
    });
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
    const packets = (await list<Packet>(this.storage, "packet:")).map(publicPacket);
    return json({
      project: { ...project, settings: settings(project), ...await publicEvents(this.storage, project.repoName) },
      agents: (await list<Agent>(this.storage, "agent:")).map(({ name, createdAt }) => ({ name, createdAt: createdAt ?? null })),
      forks: await Promise.all(forks.map(async (fork) => ({ ...fork, ...await publicEvents(this.storage, fork.repoName), head: heads.get(fork.repoName)! }))),
      packets,
      races: await raceStates(this.storage, packets),
      claims: await list<Claim>(this.storage, "claim:"),
      blockers: (await list<StoredBlocker>(this.storage, "blocker:")).map(publicBlocker),
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
  forkHead?: string,
): Promise<void> {
  if (entry.agent) {
    const raceEntrants = await openEntrants(txn);
    const claims = [...(await txn.list<Claim>({ prefix: "claim:" })).values(), ...raceEntrants];
    const pushingClaims = claims.filter(claim => claim.agent === entry.agent && claim.repoName === entry.repoName);
    // Raw push events name a fork, not a packet. Multiple bindings cannot be attributed safely.
    const pushingPacket = pushingClaims.length === 1 ? pushingClaims[0]!.packet : null;
    for (const claim of claims) {
      const paths = entry.changedPaths.filter((path) =>
        claim.paths.some((claimed) => overlaps(claimed, path)),
      );
      const sameRace = raceEntrants.some(entrant => entrant.packet === claim.packet &&
        entrant.agent === entry.agent && entrant.repoName === entry.repoName);
      if (claim.agent !== entry.agent && paths.length && !sameRace) {
        // A colon cannot occur in packet/agent slugs, so race IDs cannot collide with standard packet IDs.
        const id = `${entry.sequence}-${claim.packet}${"closedAt" in claim ? `:${claim.agent}` : ""}`;
        const blocker: Blocker = {
          id,
          packet: claim.packet,
          claimingAgent: claim.agent,
          pushingAgent: entry.agent,
          repoName: entry.repoName,
          sha: entry.after,
          paths,
          at: entry.recordedAt,
          pushingPacket,
          resolved: null,
        };
        await txn.put(`blocker:${id}`, blocker);
      }
    }
    if (entry.ref === `refs/heads/${project.defaultBranch}`) {
      for (const entrant of raceEntrants) {
        if (entrant.agent === entry.agent && entrant.repoName === entry.repoName &&
            entry.after !== ZERO_SHA && entry.before !== entry.after &&
            Date.parse(entry.eventTimestamp) >= Date.parse(entrant.createdAt))
          await markEntrant(txn, entrant, "firstPushAt", entry.eventTimestamp);
      }
      // Queue events can arrive after a newer review; prefer the fresh fork head.
      const head = forkHead ?? entry.after;
      for (const review of (await txn.list<Review>({ prefix: "review:" })).values()) {
        if (review.repoName === entry.repoName && !review.promoted && review.sha !== head)
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
