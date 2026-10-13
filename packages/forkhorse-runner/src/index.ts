import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { Snapshot } from "./snapshot";
import type { QuickPorts } from "./quick";
import { forwardGitRead } from "./git";
import { runReviewChecks } from "./runner";
import type { ContainerPort, ForkRepository, QuickFileStat, Receipt, ReviewAuthority, RunRequest, StoredReceipt } from "./types";

export { QuickFiles } from "./snapshot";
export { requirePassingReceipt } from "./runner";
export type * from "./types";

export interface RunnerEnv {
  LOADER: WorkerLoader;
  ARTIFACTS: { get(name: string): Promise<ForkRepository> };
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "ReceiptRunner";
    }
  }
}

/** Loopback capability is scoped to one authorized fork by the controlling Durable Object. */
export class GitReadGateway extends WorkerEntrypoint<RunnerEnv, { remote: string }> {
  override fetch(request: Request): Promise<Response> {
    return forwardGitRead(request, this.ctx.props.remote);
  }
}

/** Sandbox 1.0 native adapter. Export only through trusted bindings; there is no public fetch route. */
export class ReceiptRunner extends DurableObject<RunnerEnv> {
  private busy = false;
  #snapshots = new Map<string, Snapshot>();

  protected quickPorts(): QuickPorts {
    return { loader: this.env.LOADER, evidence: "dynamic-worker", files: snapshot => {
      const snapshotId = crypto.randomUUID();
      this.#snapshots.set(snapshotId, snapshot);
      return this.ctx.exports.QuickFiles({ props: { runnerId: this.ctx.id.toString(), snapshotId } });
    } };
  }
  async readSnapshot(id: string, path: string): Promise<string | null> {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw new Error("Snapshot unavailable.");
    return snapshot.read(path);
  }
  async listSnapshot(id: string, prefix: string): Promise<string[]> {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw new Error("Snapshot unavailable.");
    return snapshot.list(prefix);
  }
  async statSnapshot(id: string, path: string): Promise<QuickFileStat | null> {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw new Error("Snapshot unavailable.");
    return snapshot.stat(path);
  }

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    // A restarted DO must not inherit untrusted processes/files from its old execution.
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) await ctx.container.destroy();
    });
  }

  protected containerPort(): ContainerPort | undefined { return this.ctx.container; }
  protected evidence(): Receipt["evidence"] { return "container"; }

  async run(request: RunRequest, authority: ReviewAuthority & RpcTarget): Promise<StoredReceipt> {
    if (this.busy) throw new Error("Runner already in use");
    const container = this.containerPort();
    this.busy = true;
    try {
      let authorizedFork: string | undefined;
      return await runReviewChecks(request, {
        authority: {
          authorize: async (input) => {
            const review = await authority.authorize(input);
            authorizedFork = review.forkRepoName;
            return review;
          },
          storeReceipt: (record) => authority.storeReceipt(record),
          setReviewReceiptDigest: (review, digest) => authority.setReviewReceiptDigest(review, digest),
        },
        getFork: (name) => {
          if (!authorizedFork || name !== authorizedFork) throw new Error("Unauthorized fork");
          return this.env.ARTIFACTS.get(name);
        }, container,
        gitGateway: (remote) => this.ctx.exports.GitReadGateway({ props: { remote } }),
        evidence: this.evidence(),
        quick: this.quickPorts(),
      });
    } finally {
      for (const snapshot of this.#snapshots.values()) snapshot.close();
      this.#snapshots.clear();
      this.busy = false;
    }
  }
}
