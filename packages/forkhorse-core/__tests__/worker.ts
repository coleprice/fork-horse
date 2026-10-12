import { Supervisor } from "../src/supervisor";
import type { Env } from "../src/types";
import { FixtureArtifacts } from "./fixtures";

/** Test-only Worker injects fixtures; production has no fixture switch or public event route. */
export class TestSupervisor extends Supervisor {
  readonly fixture: FixtureArtifacts;
  constructor(ctx: DurableObjectState, env: Env) {
    const fixture = new FixtureArtifacts();
    super(ctx, { ...env, ARTIFACTS: fixture });
    this.fixture = fixture;
  }
}
export { default } from "../src/index";
