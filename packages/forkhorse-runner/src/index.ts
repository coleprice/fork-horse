import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { forwardGitRead } from "./git";
import { runReviewChecks } from "./runner";
import type { ContainerPort, ForkRepository, Receipt, ReviewAuthority, RunRequest, StoredReceipt } from "./types";

export { requirePassingReceipt } from "./runner";
export type * from "./types";

export interface RunnerEnv {
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
    if (!container) throw new Error("Container binding required");
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
      });
    } finally {
      this.busy = false;
    }
  }
}
