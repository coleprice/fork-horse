import { HttpError } from "./http";
import { ZERO_SHA } from "./trees";
import type { Repository } from "./types";

const SHA = /^[a-f0-9]{40}$/;
const MAX_ENTRIES = 20000;
const MAX_COMMITS = 2048;
const MAX_BLOB = 1024 * 1024;
const MAX_PATCH = 64 * 1024;
const encoder = new TextEncoder();
const limit = () => new HttpError(413, "Review exceeds the bounded read limit.");
const invalid = () => new Error("Invalid repository object");
type Entry = Pick<ArtifactsTreeEntry, "hash" | "mode" | "type">;
export interface ReviewFile { path: string; status: "added" | "modified" | "deleted" }

/** Git paths are data, never filesystem paths or refs. Reject ambiguous tree components. */
function component(name: string): boolean {
  return !!name && name !== "." && name !== ".." && name.toLowerCase() !== ".git" &&
    !/[\\/\u0000-\u001f\u007f]/.test(name);
}

/** Request-local cache and hard object/byte budgets for exact-commit repository reads. */
export class ReviewReader {
  private commits = new Map<string, ArtifactsCommitMetadata>();
  private entries = 0;
  private metadataBytes = 0;
  constructor(private repo: Repository) {}

  private async commit(sha: string): Promise<ArtifactsCommitMetadata> {
    if (!SHA.test(sha)) throw invalid();
    const cached = this.commits.get(sha);
    if (cached) return cached;
    if (this.commits.size >= MAX_COMMITS) throw limit();
    const commit = await this.repo.readCommit(sha);
    if (!commit || commit.hash !== sha || !SHA.test(commit.treeHash) ||
        commit.parents.length > 64 || !commit.parents.every(p => SHA.test(p)) ||
        !Number.isFinite(commit.committedAt)) throw invalid();
    if (encoder.encode(commit.message).length > MAX_PATCH ||
        encoder.encode(commit.author.name).length > 4096) throw limit();
    this.metadataBytes += encoder.encode(commit.message).length + encoder.encode(commit.author.name).length;
    if (this.metadataBytes > 2 * MAX_BLOB) throw limit();
    this.commits.set(sha, commit);
    return commit;
  }

  private async snapshot(sha: string): Promise<Map<string, Entry>> {
    const files = new Map<string, Entry>();
    if (sha === ZERO_SHA) return files;
    const root = (await this.commit(sha)).treeHash;
    const visit = async (hash: string, prefix: string, ancestors: Set<string>): Promise<void> => {
      if (ancestors.has(hash)) throw invalid();
      if (ancestors.size >= 64) throw limit();
      const tree = await this.repo.readTree(hash);
      if (!tree) throw invalid();
      this.entries += tree.length;
      if (this.entries > MAX_ENTRIES) throw limit();
      const names = new Set<string>();
      for (const entry of tree) {
        if (!component(entry.name) || !SHA.test(entry.hash) || names.has(entry.name) ||
            !["tree", "blob", "exec", "symlink", "gitlink"].includes(entry.type)) throw invalid();
        names.add(entry.name);
        const path = prefix + entry.name;
        if (encoder.encode(path).length > 4096) throw limit();
        if (entry.type === "tree") await visit(entry.hash, path + "/", new Set([...ancestors, hash]));
        else files.set(path, { hash: entry.hash, mode: entry.mode, type: entry.type });
      }
    };
    await visit(root, "", new Set());
    return files;
  }

  async changes(base: string, head: string) {
    const before = await this.snapshot(base), after = await this.snapshot(head);
    const files: ReviewFile[] = [...new Set([...before.keys(), ...after.keys()])].sort()
      .filter(path => before.get(path)?.hash !== after.get(path)?.hash ||
        before.get(path)?.mode !== after.get(path)?.mode || before.get(path)?.type !== after.get(path)?.type)
      .map(path => ({ path, status: !before.has(path) ? "added" : !after.has(path) ? "deleted" : "modified" }));
    return { before, after, public: { base, head, fileCount: files.length, truncated: files.length > 200, files: files.slice(0, 200) } };
  }

  /** Full set difference excludes every ancestor of base, including merged side branches. */
  async history(base: string, head: string) {
    const walk = async (start: string, excluded: Set<string>): Promise<Set<string>> => {
      const found = new Set<string>(), pending = start === ZERO_SHA ? [] : [start];
      while (pending.length) {
        const sha = pending.pop()!;
        if (found.has(sha) || excluded.has(sha)) continue;
        found.add(sha);
        const commit = await this.commit(sha);
        pending.push(...commit.parents);
      }
      return found;
    };
    const excluded = await walk(base, new Set());
    const included = await walk(head, excluded);
    const commits = [...included].map(sha => this.commits.get(sha)!)
      .sort((a, b) => b.committedAt - a.committedAt || a.hash.localeCompare(b.hash));
    return { commits: commits.slice(0, 50).map(commit => ({
      sha: commit.hash, subject: commit.message.split(/\r?\n/, 1)[0]!, authorName: commit.author.name,
      packetTrailer: trailer(commit.message, "Fork-Horse-Packet"),
      agentTrailer: trailer(commit.message, "Fork-Horse-Agent"),
    })), commitsTruncated: commits.length > 50 };
  }

  async diff(path: string, changes: Awaited<ReturnType<ReviewReader["changes"]>>) {
    const file = changes.public.files.find(file => file.path === path);
    if (!file) throw new HttpError(404, "Changed path not found.");
    const content = async (entry: Entry | undefined): Promise<string | null> => {
      if (!entry) return "";
      // A gitlink names a commit, never a blob to follow into a submodule.
      if (entry.type === "gitlink") return `Subproject commit ${entry.hash}\n`;
      const blob = await this.repo.readBlob(entry.hash);
      if (!blob) throw invalid();
      if (blob.size > MAX_BLOB) throw limit();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.includes(0)) return null;
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return null; }
    };
    const before = await content(changes.before.get(path));
    const after = await content(changes.after.get(path));
    if (before === null || after === null) return { ...file, binary: true, patch: "", truncated: false };
    return { ...file, binary: false, ...patch(path, file.status, before, after) };
  }
}

/** Only the final trailer paragraph counts; prose mentioning a trailer is not provenance. */
function trailer(message: string, key: string): string | null {
  const paragraphs = message.trimEnd().split(/\r?\n\s*\r?\n/);
  if (paragraphs.length < 2) return null;
  const lines = paragraphs.at(-1)!.split(/\r?\n/);
  if (!lines.every(line => /^[A-Za-z0-9-]+: .+$/.test(line))) return null;
  const values = lines.filter(line => line.toLowerCase().startsWith(key.toLowerCase() + ": "));
  return values.length ? values.at(-1)!.slice(key.length + 2).trim() || null : null;
}

/** Linear-time unified replacement hunk, with shared edges trimmed to three context lines.
 * Avoids quadratic diff work for adversarial input. A capped patch is explicitly incomplete. */
function patch(path: string, status: ReviewFile["status"], before: string, after: string) {
  if (before === after) return { patch: "", truncated: false };
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before), b = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3), context = Math.min(3, suffix);
  const oldCount = a.length - suffix + context - start, newCount = b.length - suffix + context - start;
  // Quote paths as Git does, preventing tabs/quotes from changing header interpretation.
  const label = (side: string) => JSON.stringify(`${side}/${path}`);
  let result = `--- ${status === "added" ? "/dev/null" : label("a")}\n+++ ${status === "deleted" ? "/dev/null" : label("b")}\n@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@\n`;
  let size = encoder.encode(result).length, truncated = false;
  const append = (mark: string, line: string): boolean => {
    const value = mark + line + (line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
    const bytes = encoder.encode(value).length;
    if (size + bytes > MAX_PATCH) { truncated = true; return false; }
    size += bytes; result += value; return true;
  };
  const groups: [string, string[], number, number][] = [
    [" ", a, start, prefix], ["-", a, prefix, a.length - suffix],
    ["+", b, prefix, b.length - suffix], [" ", a, a.length - suffix, a.length - suffix + context],
  ];
  outer: for (const [mark, source, from, to] of groups)
    for (let i = from; i < to; i++) if (!append(mark, source[i]!)) break outer;
  return { patch: result, truncated };
}
