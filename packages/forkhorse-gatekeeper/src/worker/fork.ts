import { forkAddress, type ReadReviewResponse, type ReadReceiptsResponse } from "../../../forkhorse-stable/src/index.ts";
import { WorkflowActions } from "./workflow.ts";
import { WorkflowSession } from "./workflow-session.ts";
import { actionKinds } from "./action-kinds.ts";
import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { validateBranchName } from "@gadgets/gatekeeper-kit/git-transport";
import type {
  ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, GitOid, GitPullHints, ResourceDescription, ActionKind,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AgentForkSession } from "../fork-types.d.ts";
import type { AgentVerifier, Env, UserAccount } from "./account.ts";
import { oid } from "./core-client.ts";
import { TYPES } from "./api-types.ts";

interface Props { accountId: string; repoName: string }
interface Push { branch: string; oldSha: string; newSha: string; status: "preparing" | "pending" | "applied" | "rejected" }

@validateRpc()
export class ForkGatekeeper extends DurableObject<Env, Props> implements Gatekeeper<AgentForkSession> {
  readonly #serial = new SerialTaskQueue();
  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.accountId));
  }
  #workflow(): WorkflowActions {
    const account = this.#account();
    return new WorkflowActions(this.ctx.storage.kv, {
      authorize: async () => { await account.fork(this.ctx.props.repoName); },
      context: () => account.workflowContext(),
      execute: operation => account.executeWorkflow(operation),
      readReview: (review): Promise<ReadReviewResponse> => account.readReview(review),
      readReceipts: (review): Promise<ReadReceiptsResponse> => account.readReceipts(review),
    }, this.#serial, () => {
      if ([...this.ctx.storage.kv.list<Push>({ prefix: "push:" })].some(([, action]) => action.status === "preparing" || action.status === "pending")) {
        throw new Error("Resolve the pending push before submitting a workflow action.");
      }
    });
  }
  async describe(): Promise<ResourceDescription> {
    const source = this.#account();
    await source.fork(this.ctx.props.repoName);
    const meta = await source.metadata();
    const url = forkAddress({ origin: meta.coreOrigin, project: meta.project, repoName: this.ctx.props.repoName });
    return { url,
      title: this.ctx.props.repoName, snippet: `Agent-owned Git fork. Attach this exact address: ${url}`, tsType: "AgentForkSession", suggestedBindingName: "FORK" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return Object.values(actionKinds); }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<AgentForkSession> {
    await this.#account().fork(this.ctx.props.repoName);
    return new ForkSession(this, queue.dup(), this.#workflow());
  }
  async readHead(): Promise<{ repoName: string; branch: string; commitId: string }> {
    const source = this.#account();
    const fork = await source.fork(this.ctx.props.repoName);
    const state = await source.state();
    return { repoName: fork.repoName, branch: state.project.defaultBranch, commitId: fork.head };
  }
  async submitPush(queue: RpcStub<ApprovalQueue>, branch: string, commitId: string): Promise<void> {
    await this.#serial.run(async () => {
      if (this.#workflow().hasPending()) throw new Error("Resolve the pending workflow action before pushing.");
      validateBranchName(branch);
      if (!oid(commitId) || /^0+$/.test(commitId)) throw new Error("A full, nonzero commit ID is required.");
      const head = await this.readHead();
      if (branch !== head.branch) throw new Error("Only the fork's default branch is supported.");
      if (head.commitId === commitId) return;
      const actions = this.ctx.storage.kv.list<Push>({ prefix: "push:" });
      const interrupted = [...actions].find(([, a]) => a.status === "preparing");
      if (interrupted) {
        const [key, action] = interrupted;
        if (action.branch !== branch || action.newSha !== commitId) {
          throw new Error("Retry the interrupted push with the same branch and commit before submitting another.");
        }
        // Reuse the gatekeeper action ID after an ambiguous reply/crash. The OS may
        // queue a duplicate, but applying this ID is serialized and idempotent.
        await this.#queuePush(queue, Number(key.slice(5)), action, head.repoName);
        return;
      }
      if ([...actions].some(([, a]) => a.status === "pending")) {
        throw new Error("Resolve the pending push before submitting another.");
      }
      using cache = await queue.getGitCache();
      if (!/^0+$/.test(head.commitId) && !await cache.isAncestor(head.commitId, commitId)) {
        throw new Error("Push must be a fast-forward. Rebase on the current fork head.");
      }
      const id = (this.ctx.storage.kv.get<number>("nextAction") ?? 0) + 1;
      this.ctx.storage.kv.put("nextAction", id);
      const action: Push = { branch, oldSha: head.commitId, newSha: commitId, status: "preparing" };
      this.ctx.storage.kv.put(`push:${id}`, action);
      await this.#queuePush(queue, id, action, head.repoName);
    });
  }
  async #queuePush(queue: RpcStub<ApprovalQueue>, id: number, action: Push, repoName: string): Promise<void> {
    try {
      await queue.submitAction(id, {
        title: `Push ${action.newSha.slice(0, 12)} to ${action.branch}`,
        description: `Advance fork ${repoName} on branch ${action.branch} from ${action.oldSha} to ${action.newSha}. The update fails if the branch moved.`,
        pushedCommits: [action.newSha], implementsRevert: false, awaitDecision: true,
        actionKind: actionKinds.push, autoApprovable: true,
      });
      this.ctx.storage.kv.put(`push:${id}`, { ...action, status: "pending" });
    } catch {
      // Keep the intent: the OS may have durably queued it before the reply failed.
      throw new Error("Push submission was interrupted. Retry the same branch and commit.");
    }
  }
  async gitPull(oids: GitOid[], cache: RpcStub<GitCache>, hints: GitPullHints): Promise<void> {
    await this.#account().pull(this.ctx.props.repoName, oids, hints, cache);
  }
  async applyAction(id: number, cache: RpcStub<GitCache>): Promise<void> {
    const workflow = this.#workflow();
    if (workflow.has(id)) return workflow.apply(id);
    await this.#serial.run(async () => {
      const action = this.ctx.storage.kv.get<Push>(`push:${id}`);
      if (action?.status === "applied") return;
      // A queued OS action is still approvable if its submission reply was lost.
      if (action?.status !== "pending" && action?.status !== "preparing") throw new Error("Push is not pending approval.");
      const head = await this.readHead();
      // Recover a lost successful reply; the approved exact commit is already present.
      if (head.commitId !== action.newSha) {
        if (head.branch !== action.branch || head.commitId !== action.oldSha) throw new Error("Fork moved; discard this push and rebase.");
        if (!/^0+$/.test(action.oldSha) && !await cache.isAncestor(action.oldSha, action.newSha)) {
          throw new Error("Push is not a fast-forward.");
        }
        const pack = await cache.buildPack();
        await this.#account().push(this.ctx.props.repoName, action.branch, action.oldSha, action.newSha, pack);
      }
      this.ctx.storage.kv.put(`push:${id}`, { ...action, status: "applied" });
    });
  }
  async rejectAction(id: number): Promise<void> {
    const workflow = this.#workflow();
    if (workflow.has(id)) return workflow.reject(id);
    await this.#serial.run(async () => {
      const action = this.ctx.storage.kv.get<Push>(`push:${id}`);
      if (!action || action.status === "rejected") return;
      if (action.status === "applied") throw new Error("Push already applied.");
      this.ctx.storage.kv.put(`push:${id}`, { ...action, status: "rejected" });
    });
  }
  async revertAction(): Promise<never> { throw new Error("Create and submit a new reverting commit; history rewrites are not supported."); }
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const meta = await this.#account().metadata();
    if (!await (user as Fetcher<AgentVerifier>).owns(meta.coreOrigin, meta.project, this.ctx.props.repoName)) {
      throw new Error("Observer cannot access this agent fork.");
    }
  }
  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class ForkSession extends WorkflowSession implements AgentForkSession {
  constructor(private readonly gatekeeper: ForkGatekeeper, queue: RpcStub<ApprovalQueue>, actions: WorkflowActions) { super(actions, queue); }
  async getHead(): Promise<{ repoName: string; branch: string; commitId: string }> {
    await this.queue.authorizeObservation({ title: "Read fork head", description: "Read the connected fork's default branch and commit." });
    const head = await this.gatekeeper.readHead();
    using cache = await this.queue.getGitCache();
    if (!/^0+$/.test(head.commitId)) await cache.advertiseCommit(head.commitId);
    return head;
  }
  async push(branch: string, commitId: string): Promise<void> { await this.gatekeeper.submitPush(this.queue, branch, commitId); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}
