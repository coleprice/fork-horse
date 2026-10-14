import { HttpError } from "./http";

type Entry = { bytes: Uint8Array | null; modified: number };
const storedByteLimit = 32 * 1024 * 1024;
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Minimal promise filesystem for ephemeral Git metadata, with a stored-byte budget. */
export class MemoryFs {
  private entries = new Map<string, Entry>([["/", { bytes: null, modified: 0 }]]);
  private size = 0;
  private key(path: string): string {
    if (typeof path !== "string") throw failure("EINVAL");
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return "/" + parts.join("/");
  }
  private get(path: string): Entry {
    const entry = this.entries.get(this.key(path));
    if (!entry) throw failure("ENOENT");
    return entry;
  }
  private parent(path: string): string {
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }
  private stats(path: string) {
    const entry = this.get(path);
    return {
      size: entry.bytes?.length ?? 0,
      mode: entry.bytes ? 0o100644 : 0o040000,
      mtimeMs: entry.modified,
      ctimeMs: entry.modified,
      dev: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      isFile: () => entry.bytes !== null,
      isDirectory: () => entry.bytes === null,
      isSymbolicLink: () => false,
    };
  }
  readonly promises = {
    readFile: async (
      path: string,
      options?: string | { encoding?: string },
    ): Promise<Uint8Array | string> => {
      const entry = this.get(path);
      if (!entry.bytes) throw failure("EISDIR");
      return (typeof options === "string" ? options : options?.encoding)
        ? new TextDecoder().decode(entry.bytes)
        : entry.bytes.slice();
    },
    writeFile: async (path: string, content: Uint8Array | string): Promise<void> => {
      path = this.key(path);
      if (this.get(this.parent(path)).bytes !== null) throw failure("ENOTDIR");
      const old = this.entries.get(path);
      if (old?.bytes === null) throw failure("EISDIR");
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
      const size = this.size - (old?.bytes?.length ?? 0) + bytes.length;
      if (size > storedByteLimit)
        throw new HttpError(
          413,
          `Git memory filesystem exceeds the ${storedByteLimit}-byte stored-byte limit; reached ${size} bytes. Repository requires the sandbox Git runner.`,
        );
      this.entries.set(path, { bytes, modified: Date.now() });
      this.size = size;
    },
    mkdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
      path = this.key(path);
      if (this.entries.has(path)) {
        if (options?.recursive && this.get(path).bytes === null) return;
        throw failure("EEXIST");
      }
      const parent = this.parent(path);
      if (!this.entries.has(parent) && options?.recursive)
        await this.promises.mkdir(parent, options);
      if (this.get(parent).bytes !== null) throw failure("ENOTDIR");
      this.entries.set(path, { bytes: null, modified: Date.now() });
    },
    readdir: async (path: string): Promise<string[]> => {
      path = this.key(path);
      if (this.get(path).bytes !== null) throw failure("ENOTDIR");
      return [...this.entries.keys()]
        .filter((key) => key !== path && this.parent(key) === path)
        .map((key) => key.slice(key.lastIndexOf("/") + 1))
        .toSorted();
    },
    unlink: async (path: string): Promise<void> => {
      path = this.key(path);
      const entry = this.get(path);
      if (!entry.bytes) throw failure("EISDIR");
      this.size -= entry.bytes.length;
      this.entries.delete(path);
    },
    rmdir: async (path: string): Promise<void> => {
      path = this.key(path);
      if ((await this.promises.readdir(path)).length) throw failure("ENOTEMPTY");
      this.entries.delete(path);
    },
    stat: async (path: string) => this.stats(path),
    lstat: async (path: string) => this.stats(path),
    readlink: async (_path: string): Promise<string> => {
      throw failure("EINVAL");
    },
    symlink: async (_target: string, _path: string): Promise<void> => {
      throw failure("ENOTSUP");
    },
  };
}
