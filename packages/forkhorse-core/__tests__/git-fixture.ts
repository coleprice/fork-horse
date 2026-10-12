import { HttpError } from "../src/http";
import { staleBase } from "../src/git";
import type { GitOperations, PreparedPush } from "../src/git";
import type { CommitFile, Fork } from "../src/workflow-types";
import type { FixtureArtifacts } from "./fixtures";

/** Explicit transport fixture. Real Git object/protocol tests are separate. */
export class FixtureGit implements GitOperations {
  pushes: { remote: string; expected: string; sha: string }[] = [];
  failPush = false;
  raceBeforePush = false;
  constructor(private artifacts: FixtureArtifacts) {}
  private prepared(sha: string): PreparedPush {
    return {
      sha,
      push: async (remote, _token, expected) => {
        if (this.failPush) throw new Error("fixture-secret-provider-error");
        const repo = remote
          .split("/")
          .at(-1)!
          .replace(/\.git$/, "");
        if (this.raceBeforePush) this.artifacts.heads.set(repo, "f".repeat(40));
        if (this.artifacts.heads.get(repo) !== expected) throw staleBase();
        this.pushes.push({ remote, expected, sha });
        this.artifacts.heads.set(repo, sha);
      },
    };
  }
  async prepareCommit(
    _fork: Fork,
    _branch: string,
    _expected: string,
    _files: CommitFile[],
    _message: string,
  ) {
    return this.prepared("c".repeat(40));
  }
  async preparePromote(_fork: Fork, _branch: string, sha: string, base: string) {
    if (base === sha) throw new HttpError(409, "stale base, rebase");
    return this.prepared(sha);
  }
}
