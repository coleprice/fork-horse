import { Supervisor } from "../src/supervisor";
import type { Env } from "../src/types";
import { FixtureGit } from "./git-fixture";
import { FixtureArtifacts } from "./fixtures";

/** Test-only Worker injects fixtures; production has no fixture switch or public event route. */
export class TestSupervisor extends Supervisor {
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
