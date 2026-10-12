import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { forwardGitRead } from "./git";
import { runReviewChecks } from "./runner";
import type { ForkRepository, ReviewAuthority, RunRequest, StoredReceipt } from "./types";

export { requirePassingReceipt } from "./runner";
export type * from "./types";

export interface RunnerEnv {
  /** Trusted service seam supplied by FH-005; not implemented or bound in this offline packet. */
  REVIEW_AUTHORITY: ReviewAuthority;
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

  async run(request: RunRequest): Promise<StoredReceipt> {
    if (this.busy) throw new Error("Runner already in use");
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding required");
    this.busy = true;
    try {
      return await runReviewChecks(request, {
        authority: this.env.REVIEW_AUTHORITY,
        getFork: (name) => this.env.ARTIFACTS.get(name), container,
        gitGateway: (remote) => this.ctx.exports.GitReadGateway({ props: { remote } }),
        evidence: "container",
      });
    } finally {
      this.busy = false;
    }
  }
}
