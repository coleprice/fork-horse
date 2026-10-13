import { ReceiptRunner as NativeReceiptRunner } from "../../forkhorse-runner/src/index";
import type { ReviewAuthority, RunRequest } from "../../forkhorse-runner/src/types";
import type { RpcTarget } from "cloudflare:workers";
import { runReviewChecks } from "../../forkhorse-runner/src/runner";
import type { ExecuteReceipt } from "../src/receipts";
import { MockContainer } from "./receipt-fixture";
import { Supervisor } from "../src/supervisor";
import type { Env } from "../src/types";
import { FixtureGit } from "./git-fixture";
import { FixtureArtifacts } from "./fixtures";

/** Test-only Worker injects fixtures; production has no fixture switch or public event route. */
export class TestSupervisor extends Supervisor {
  receiptFixtureExecutor?: ExecuteReceipt;
  useRpcRunner = false;
  receiptExitStatus = 0;
  receiptBarrier?: Promise<void>;
  receiptRuns: string[] = [];
  receiptContainers: MockContainer[] = [];
  protected override receiptExecution(): ExecuteReceipt {
    return async (request, authority, generation) => {
      this.receiptRuns.push(request.trigger);
      if (this.receiptFixtureExecutor) return this.receiptFixtureExecutor(request, authority, generation);
      await this.receiptBarrier;
      if (this.useRpcRunner) {
        const id = crypto.randomUUID();
        const runner = this.ctx.exports.ReceiptRunner.getByName(id) as unknown as DurableObjectStub<ReceiptRunner>;
        await runner.configure(this.fixture.checks!, this.fixture.quickSource);
        return super.receiptExecution()(request, authority, id);
      }
      const container = new MockContainer(this.receiptExitStatus);
      this.receiptContainers.push(container);
      return runReviewChecks(request, {
        authority, container,
        getFork: name => this.fixture.get(name), evidence: "mocked-container-port",
        gitGateway: () => ({}) as Fetcher,
      });
    };
  }
  readonly gitFixture: FixtureGit;
  protected override gitOperations() {
    return this.gitFixture;
  }
  configureEvents(values: Pick<Env, "CF_ACCOUNT_ID" | "CF_EVENTS_API_TOKEN" | "PUSH_QUEUE_ID">) {
    Object.assign(this.env, values);
  }
  readonly fixture: FixtureArtifacts;
  constructor(ctx: DurableObjectState, env: Env) {
    const fixture = new FixtureArtifacts();
    super(ctx, { ...env, ARTIFACTS: fixture });
    this.fixture = fixture;
    this.gitFixture = new FixtureGit(fixture);
  }
}
export { default } from "../src/index";

/** Production adapter/RPC wiring with an explicitly mocked container port. */
export class ReceiptRunner extends NativeReceiptRunner {
  readonly fixture: FixtureArtifacts;
  readonly mock = new MockContainer();
  constructor(ctx: DurableObjectState, env: Env) {
    const fixture = new FixtureArtifacts();
    super(ctx, { ...env, ARTIFACTS: fixture });
    this.fixture = fixture;
    this.fixture.checks = JSON.stringify([{ name: "unit", tier: "full", image: "default", run: "npm test" }]);
  }
  configure(checks: string, source?: string) { this.fixture.checks = checks; this.fixture.quickSource = source; }
  protected override containerPort() { return this.mock; }
  protected override evidence() { return "mocked-container-port" as const; }
  override async run(request: RunRequest, authority: ReviewAuthority & RpcTarget) {
    const review = await authority.authorize(request);
    await this.fixture.create(review.forkRepoName);
    return super.run(request, authority);
  }
}
export { GitReadGateway, QuickFiles } from "../../forkhorse-runner/src/index";
