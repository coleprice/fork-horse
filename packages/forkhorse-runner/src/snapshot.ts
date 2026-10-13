import { WorkerEntrypoint } from "cloudflare:workers";
import type { ForkRepository } from "./types";

export const QUICK_READ_BYTES = 2 * 1024 * 1024;
export const QUICK_LIST_PATHS = 2000;
const MAX_ENTRIES = 10_000;

/** Literal repository paths only. Reject aliases instead of normalizing into another file. */
function pathParts(path: unknown, prefix = false): string[] {
  if (typeof path !== "string" || path.length > 4096 || path.startsWith("/") || path.includes("\\") ||
      [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("Invalid path");
  if (prefix && path.endsWith("/")) path = path.slice(0, -1);
  if (prefix && path === "") return [];
  const parts = (path as string).split("/");
  if (parts.length > 64 || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))
    throw new Error("Invalid path");
  return parts;
}

/** Host-owned state: no token operations and no moving refs. Close fences in-flight RPC too. */
export class Snapshot {
  private active = true;
  private bytes = 0;
  private listed = 0;
  private entries = 0;
  private calls = 0;
  private root?: Promise<string>;
  constructor(private repo: Pick<ForkRepository, "readCommit" | "readTree" | "readBlob">,
    private commit: string, private expiresAt = Infinity) {}
  close(): void { this.active = false; }
  private guard(): void {
    if (!this.active || Date.now() >= this.expiresAt) throw new Error("Snapshot closed");
  }
  private async tree(hash: string): Promise<ArtifactsTreeEntry[]> {
    this.guard();
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("Invalid tree hash");
    const tree = await this.repo.readTree(hash);
    this.guard();
    if (!tree || (this.entries += tree.length) > MAX_ENTRIES) throw new Error("Snapshot tree limit");
    const names = new Set<string>();
    for (const e of tree) {
      if (pathParts(e.name).length !== 1 || names.has(e.name) || !/^[a-f0-9]{40}$/.test(e.hash)) throw new Error("Invalid tree");
      names.add(e.name);
    }
    return tree;
  }
  private async rootHash(): Promise<string> {
    this.guard();
    // Reserve synchronously: concurrent read calls cannot start separate traversals of a ref.
    if (!/^[a-f0-9]{40}$/.test(this.commit)) throw new Error("Invalid commit");
    this.root ??= this.repo.readCommit(this.commit).then(c => {
      this.guard();
      if (!c || c.hash !== this.commit) throw new Error("Snapshot unavailable");
      return c.treeHash;
    });
    return this.root;
  }
  private async entry(parts: string[]): Promise<ArtifactsTreeEntry | null> {
    let hash = await this.rootHash();
    for (let i = 0; i < parts.length; i++) {
      const entry = (await this.tree(hash)).find(e => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry;
      if (entry.type !== "tree") throw new Error("Not a directory");
      hash = entry.hash;
    }
    return { name: "", hash, type: "tree", mode: "40000" };
  }
  async read(path: unknown): Promise<string | null> {
    try {
      this.guard();
      if (++this.calls > MAX_ENTRIES) throw new Error("Snapshot call limit");
      const entry = await this.entry(pathParts(path));
      if (!entry) return null;
      if (!((entry.type === "blob" && entry.mode === "100644") || (entry.type === "exec" && entry.mode === "100755"))) throw new Error("Not a regular file");
      this.guard();
      const blob = await this.repo.readBlob(entry.hash);
      this.guard();
      if (!blob || (this.bytes += blob.size) > QUICK_READ_BYTES) throw new Error("Snapshot read limit");
      const bytes = await blob.arrayBuffer();
      this.guard();
      if (bytes.byteLength !== blob.size) throw new Error("Invalid blob");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      // The module may catch this error and return it; never forward provider text or stacks.
      throw new Error("Snapshot read unavailable or limit exceeded.");
    }
  }
  async list(prefix: unknown): Promise<string[]> {
    try {
      this.guard();
      if (++this.calls > MAX_ENTRIES) throw new Error("Snapshot call limit");
      const parts = pathParts(prefix, true);
      const baseParts = typeof prefix === "string" && prefix.endsWith("/") ? parts : parts.slice(0, -1);
      const entry = await this.entry(baseParts);
      if (!entry) return [];
      const paths: string[] = [];
      const visit = async (e: ArtifactsTreeEntry, path: string, depth: number): Promise<void> => {
        this.guard();
        if (depth > 64) throw new Error("Snapshot depth limit");
        if (e.type === "tree") {
          for (const child of await this.tree(e.hash)) await visit(child, path ? `${path}/${child.name}` : child.name, depth + 1);
        } else if ((e.type === "blob" && e.mode === "100644") || (e.type === "exec" && e.mode === "100755")) {
          if (!path.startsWith(prefix as string)) return;
          if (++this.listed > QUICK_LIST_PATHS) throw new Error("Snapshot list limit");
          paths.push(path);
        }
      };
      await visit(entry, baseParts.join("/"), baseParts.length);
      this.guard();
      return paths.toSorted();
    } catch { throw new Error("Snapshot list unavailable or limit exceeded."); }
  }
}

/** Token-free loopback: the nonce selects host-owned state on the execution's Durable Object.
 * Arbitrary RPC objects cannot be serialized into loopback props. The nonce grants only read/list. */
export class QuickFiles extends WorkerEntrypoint<{
  RECEIPT_RUNNER: DurableObjectNamespace<import("./index").ReceiptRunner>;
}, { runnerId: string; snapshotId: string }> {
  read(path: string): Promise<string | null> {
    const { runnerId, snapshotId } = this.ctx.props;
    return this.env.RECEIPT_RUNNER.get(this.env.RECEIPT_RUNNER.idFromString(runnerId)).readSnapshot(snapshotId, path);
  }
  list(prefix: string): Promise<string[]> {
    const { runnerId, snapshotId } = this.ctx.props;
    return this.env.RECEIPT_RUNNER.get(this.env.RECEIPT_RUNNER.idFromString(runnerId)).listSnapshot(snapshotId, prefix);
  }
}
