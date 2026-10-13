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
  calls: { method: string; repo: string; scope?: string; ttl?: number; sourceUrl?: string; ref?: string }[] = [];
  defaultBranch = "main";
  private repos = new Set<string>();
  heads = new Map<string, string>();
  tokens = new Map<string, Map<string, ArtifactsTokenInfo>>();
  tokenCounter = 0;
  tokenPageSize = 30;
  beforeTokenCreate?: (repo: string, scope: string) => Promise<void>;
  failRevoke = false;
  staleTokenListing = false;
  failTree = false;
  failCreate = false;
  // Optional complete push diff for activity-cap/runtime acceptance fixtures.
  changedPaths?: string[];
  checks?: string;
  reviewCommits = new Map<string, ArtifactsCommitMetadata>();
  reviewTrees = new Map<string, ArtifactsTreeEntry[]>();
  reviewBlobs = new Map<string, Blob>();

  async create(name: string): Promise<ArtifactsCreateRepoResult> {
    this.calls.push({ method: "create", repo: name });
    if (this.failCreate) throw new Error("fixture-provider-secret-that-must-not-leak");
    if (this.repos.has(name)) throw new Error("fixture already exists");
    this.repos.add(name);
    this.heads.set(name, BEFORE);
    this.tokens.set(
      name,
      new Map([
        [
          `initial-${name}`,
          {
            id: `initial-${name}`,
            scope: "write",
            state: "active",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      ]),
    );
    return {
      id: name,
      name,
      description: null,
      defaultBranch: this.defaultBranch,
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
      log: async (options) => {
        this.calls.push({ method: "log", repo: name, ref: options?.ref });
        // Mirror the provider: HEAD and qualified Git refs do not resolve here.
        if (options?.ref !== this.defaultBranch) return [];
        const hash = this.heads.get(name);
        return hash && hash !== "0".repeat(40)
          ? [
              {
                hash,
                treeHash: OLD_TREE,
                message: "Fixture",
                author: { name: "Agent", email: "agent@idiot.tax" },
                committer: { name: "Agent", email: "agent@idiot.tax" },
                parents: [],
                authoredAt: 1,
                committedAt: 1,
              },
            ]
          : [];
      },
      [Symbol.dispose]: () => {
        this.calls.push({ method: "dispose", repo: name });
      },
      fork: async (forkName) => {
        this.calls.push({ method: "fork", repo: name });
        return this.create(forkName);
      },
      listTokens: async () => {
        this.calls.push({ method: "listTokens", repo: name });
        const tokens = [...this.tokens.get(name)!.values()].filter(
          (token) => token.state === "active",
        );
        return {
          tokens: tokens.slice(0, this.tokenPageSize).map((token) => ({ ...token })),
          total: tokens.length,
        };
      },
      revokeToken: async (id) => {
        this.calls.push({ method: "revokeToken", repo: name });
        if (this.failRevoke) throw new Error("fixture-provider-secret-that-must-not-leak");
        const token = this.tokens.get(name)!.get(id);
        if (!token) return false;
        if (!this.staleTokenListing) token.state = "revoked";
        return true;
      },
      createToken: async (scope = "write", ttl = 3600) => {
        this.calls.push({ method: "createToken", repo: name, scope, ttl });
        await this.beforeTokenCreate?.(name, scope);
        const plaintext =
          this.tokens.get(name)!.size === 1
            ? `scoped-${name}`
            : `scoped-${name}-${this.tokenCounter + 1}`;
        const id = `token-${name}-${++this.tokenCounter}`;
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        this.tokens
          .get(name)!
          .set(id, { id, scope, expiresAt, state: "active", createdAt: new Date().toISOString() });
        return { id, plaintext, scope, expiresAt };
      },
      readCommit: async (hash) => {
        this.calls.push({ method: "readCommit", repo: name });
        if (this.reviewCommits.has(hash)) return this.reviewCommits.get(hash)!;
        if (hash !== BEFORE && hash !== AFTER && !(this.checks !== undefined && /^[a-f0-9]{40}$/.test(hash))) return null;
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
      readBlob: async (hash) => {
        this.calls.push({ method: "readBlob", repo: name });
        return this.reviewBlobs.get(hash) ?? (this.checks === undefined ? null : new Blob([this.checks]));
      },
      readTree: async (hash) => {
        this.calls.push({ method: "readTree", repo: name });
        if (this.failTree) return null;
        if (this.reviewTrees.has(hash)) return this.reviewTrees.get(hash)!;
        if (this.changedPaths && hash === OLD_TREE) return [];
        if (this.changedPaths && hash === NEW_TREE) return this.changedPaths.map((path) => file(path));
        if (this.checks !== undefined && (hash === OLD_TREE || hash === NEW_TREE))
          return [...trees.get(hash)!, { name: ".forkhorse", type: "tree", mode: "40000", hash: "c".repeat(40) }];
        if (this.checks !== undefined && hash === "c".repeat(40))
          return [{ name: "checks", type: "blob", mode: "100644", hash: "d".repeat(40) }];
        return trees.get(hash) ?? null;
      },
    };
  }
}
