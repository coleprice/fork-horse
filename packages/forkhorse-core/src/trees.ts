import type { Repository } from "./types";

export const ZERO_SHA = "0".repeat(40);

/** Read object IDs only along requested paths; never walk unrelated subtrees or read blobs. */
export async function pathHashes(
  repo: Repository,
  sha: string,
  paths: string[],
): Promise<Map<string, string | undefined>> {
  const hashes = new Map<string, string | undefined>();
  if (sha === ZERO_SHA) return new Map(paths.map(path => [path, undefined]));
  const commit = await repo.readCommit(sha);
  if (!commit) throw new Error("Commit unavailable");
  const cache = new Map<string, ArtifactsTreeEntry[]>();
  let visited = 0;
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length > 64) throw new Error("Tree depth limit exceeded");
    let tree = commit.treeHash;
    let hash: string | undefined;
    for (const [index, part] of parts.entries()) {
      let entries = cache.get(tree);
      if (!entries) {
        entries = (await repo.readTree(tree)) ?? undefined;
        if (!entries) throw new Error("Tree unavailable");
        visited += entries.length;
        if (visited > 10000) throw new Error("Tree entry limit exceeded");
        cache.set(tree, entries);
      }
      const entry = entries.find(candidate => candidate.name === part);
      if (!entry) break;
      if (index === parts.length - 1) hash = entry.hash;
      else if (entry.type === "tree") tree = entry.hash;
      else break;
    }
    hashes.set(path, hash);
  }
  return hashes;
}

/** Compare complete snapshots, including modes, removals, symlinks and submodules. */
export async function changedPaths(
  repo: Repository,
  before: string,
  after: string,
): Promise<string[]> {
  const cache = new Map<string, ArtifactsTreeEntry[]>();
  async function snapshot(commitHash: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    if (commitHash === ZERO_SHA) return files;
    const commit = await repo.readCommit(commitHash);
    if (!commit) throw new Error("Commit unavailable");
    let visited = 0;
    async function visit(hash: string, prefix: string, depth: number): Promise<void> {
      if (depth > 64) throw new Error("Tree depth limit exceeded");
      let entries = cache.get(hash);
      if (!entries) {
        entries = (await repo.readTree(hash)) ?? undefined;
        if (!entries) throw new Error("Tree unavailable");
        cache.set(hash, entries);
      }
      for (const entry of entries) {
        if (++visited > 10000) throw new Error("Tree entry limit exceeded");
        const path = prefix + entry.name;
        if (entry.type === "tree") await visit(entry.hash, path + "/", depth + 1);
        else files.set(path, `${entry.mode}:${entry.hash}`);
      }
    }
    await visit(commit.treeHash, "", 0);
    return files;
  }
  const oldFiles = await snapshot(before);
  const newFiles = await snapshot(after);
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .filter((path) => oldFiles.get(path) !== newFiles.get(path))
    .toSorted();
}
