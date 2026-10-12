import type { ArtifactsBinding, Repository } from "../src/types";

export const BEFORE = "1".repeat(40);
export const AFTER = "2".repeat(40);
const OLD_TREE = "3".repeat(40);
const NEW_TREE = "4".repeat(40);
const OLD_SRC = "5".repeat(40);
const NEW_SRC = "6".repeat(40);
const OLD_BLOB = "7".repeat(40);
const NEW_BLOB = "8".repeat(40);

function file(name: string, hash = OLD_BLOB, mode = "100644"): ArtifactsTreeEntry {
  return { name, hash, mode, type: mode === "100755" ? "exec" : "blob" };
}

const trees = new Map<string, ArtifactsTreeEntry[]>([
  [
    OLD_TREE,
    [
      file("removed.txt"),
      file("mode.sh"),
      file("same.txt"),
      { name: "src", type: "tree", mode: "40000", hash: OLD_SRC },
    ],
  ],
  [
    NEW_TREE,
    [
      file("added.txt"),
      file("mode.sh", OLD_BLOB, "100755"),
      file("same.txt"),
      { name: "src", type: "tree", mode: "40000", hash: NEW_SRC },
    ],
  ],
  [OLD_SRC, [file("index.ts")]],
  [NEW_SRC, [file("index.ts", NEW_BLOB)]],
]);

/** Explicit offline fixture implementing only the production binding surface. */
export class FixtureArtifacts implements ArtifactsBinding {
  calls: { method: string; repo: string; scope?: string; ttl?: number; sourceUrl?: string }[] = [];
  private repos = new Set<string>();
  failTree = false;
  failCreate = false;

  async create(name: string): Promise<ArtifactsCreateRepoResult> {
    this.calls.push({ method: "create", repo: name });
    if (this.failCreate) throw new Error("fixture-provider-secret-that-must-not-leak");
    if (this.repos.has(name)) throw new Error("fixture already exists");
    this.repos.add(name);
    return {
      id: name,
      name,
      description: null,
      defaultBranch: "main",
      remote: `https://git.idiot.tax/fixture/${name}.git`,
      token: `initial-${name}`,
    };
  }

  async import(params: Parameters<Artifacts["import"]>[0]): Promise<ArtifactsCreateRepoResult> {
    this.calls.push({ method: "import", repo: params.target.name, sourceUrl: params.source.url });
    return this.create(params.target.name);
  }

  async get(name: string): Promise<Repository> {
    this.calls.push({ method: "get", repo: name });
    if (!this.repos.has(name)) throw new Error("fixture not found");
    return {
      [Symbol.dispose]: () => {
        this.calls.push({ method: "dispose", repo: name });
      },
      fork: async (forkName) => {
        this.calls.push({ method: "fork", repo: name });
        return this.create(forkName);
      },
      revokeToken: async () => {
        this.calls.push({ method: "revokeToken", repo: name });
        return true;
      },
      createToken: async (scope = "write", ttl = 3600) => {
        this.calls.push({ method: "createToken", repo: name, scope, ttl });
        return {
          id: `token-${name}`,
          plaintext: `scoped-${name}`,
          scope,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        };
      },
      readCommit: async (hash) => {
        this.calls.push({ method: "readCommit", repo: name });
        if (hash !== BEFORE && hash !== AFTER) return null;
        return {
          hash,
          treeHash: hash === BEFORE ? OLD_TREE : NEW_TREE,
          message: "Fixture commit",
          author: { name: "Fixture agent", email: "agent@idiot.tax" },
          committer: { name: "Fixture agent", email: "agent@idiot.tax" },
          parents: hash === BEFORE ? [] : [BEFORE],
          authoredAt: 1,
          committedAt: 1,
        };
      },
      readTree: async (hash) => {
        this.calls.push({ method: "readTree", repo: name });
        if (this.failTree) return null;
        return trees.get(hash) ?? null;
      },
    };
  }
}
