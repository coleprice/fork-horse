import * as git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git/http/web";
import { MemoryFs } from "./memory-fs";
import { HttpError } from "./http";
import { ZERO_SHA } from "./trees";
import type { ArtifactsBinding } from "./types";
import type { CommitFile, Fork } from "./workflow-types";

export const staleBase = () => new HttpError(409, "stale base, rebase");
const transportLimit = 8 * 1024 * 1024;

/** Bounded raw Git HTTP, with no redirects or provider error text escaping to callers. */
export const gitHttp: HttpClient = {
  async request({ url, method = "GET", headers = {}, body }) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (body)
      for await (const chunk of body) {
        length += chunk.byteLength;
        if (length > transportLimit)
          throw new HttpError(413, "Repository requires the sandbox Git runner.");
        chunks.push(chunk);
      }
    const requestBody = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      requestBody.set(chunk, offset);
      offset += chunk.length;
    }
    const response = await fetch(url, {
      method,
      headers: { ...headers, "User-Agent": "git/2.0 (isomorphic-git)" },
      ...(method === "POST" ? { body: requestBody } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new HttpError(502, "Repository redirects are forbidden.");
    }
    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers),
      body: (async function* () {
        const reader = response.body?.getReader();
        if (!reader) return;
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            size += value.byteLength;
            if (size > transportLimit)
              throw new HttpError(413, "Repository requires the sandbox Git runner.");
            yield value;
          }
        } finally {
          await reader.cancel();
        }
      })(),
    };
  },
};

export interface PreparedPush {
  sha: string;
  push(remote: string, token: string, expected: string): Promise<void>;
}
export interface GitOperations {
  prepareCommit(
    fork: Fork,
    branch: string,
    expected: string,
    files: CommitFile[],
    message: string,
  ): Promise<PreparedPush>;
  preparePromote(fork: Fork, branch: string, sha: string, base: string): Promise<PreparedPush>;
}
const auth = (token: string) => () => ({ username: "x", password: token.split("?expires=")[0]! });

/** The in-Worker implementation is deliberately bounded; FH-007 supplies the large-repo runner. */
export class WorkerGit implements GitOperations {
  constructor(
    private artifacts: ArtifactsBinding,
    private http: HttpClient = gitHttp,
  ) {}

  private async clone(fork: Fork, branch: string, expected: string) {
    const fs = new MemoryFs();
    const dir = "/repo";
    await fs.promises.mkdir(dir);
    using repo = await this.artifacts.get(fork.repoName);
    const token = await repo.createToken("read", 60);
    try {
      if (expected === ZERO_SHA) await git.init({ fs, dir, defaultBranch: branch });
      else {
        await git.clone({
          fs,
          dir,
          http: this.http,
          url: fork.remote,
          ref: branch,
          singleBranch: true,
          noTags: true,
          noCheckout: true,
          onAuth: auth(token.plaintext),
        });
        if ((await git.resolveRef({ fs, dir, ref: "HEAD" })) !== expected) throw staleBase();
      }
    } finally {
      await repo.revokeToken(token.id);
    }
    return { fs, dir };
  }

  private prepared(
    local: Awaited<ReturnType<WorkerGit["clone"]>>,
    branch: string,
    sha: string,
  ): PreparedPush {
    return {
      sha,
      push: async (remote, token, expected) => {
        // isomorphic-git serializes the advertised old OID into receive-pack. The hook
        // fences changes since our canonical read; receive-pack fences changes after discovery.
        try {
          const result = await git.push({
            ...local,
            http: this.http,
            url: remote,
            ref: branch,
            remoteRef: branch,
            force: false,
            onAuth: auth(token),
            onPrePush: ({ remoteRef, localRef }) => {
              if (remoteRef.oid !== expected || localRef.oid !== sha || sha === expected)
                throw staleBase();
              return true;
            },
          });
          if (!result.ok) throw staleBase();
        } catch (error) {
          if (
            error instanceof git.Errors.PushRejectedError ||
            error instanceof git.Errors.GitPushError
          )
            throw staleBase();
          throw error;
        }
      },
    };
  }

  async prepareCommit(
    fork: Fork,
    branch: string,
    expected: string,
    files: CommitFile[],
    message: string,
  ): Promise<PreparedPush> {
    const local = await this.clone(fork, branch, expected);
    let tree =
      expected === ZERO_SHA
        ? undefined
        : (await git.readCommit({ ...local, oid: expected })).commit.tree;
    // Edit Git objects directly: no checkout, symlink traversal, hooks, or repository code execution.
    const edit = async (
      oid: string | undefined,
      parts: string[],
      blob: string,
    ): Promise<string> => {
      const entries = oid ? (await git.readTree({ ...local, oid })).tree : [];
      const name = parts[0]!;
      const existing = entries.find((entry) => entry.path === name);
      let entry;
      if (parts.length > 1) {
        if (existing && existing.type !== "tree")
          throw new HttpError(400, "File parent is not a directory.");
        entry = {
          path: name,
          mode: "040000",
          type: "tree" as const,
          oid: await edit(existing?.oid, parts.slice(1), blob),
        };
      } else {
        if (existing && existing.type !== "blob")
          throw new HttpError(400, "Cannot replace a directory or submodule.");
        if (existing?.mode === "120000")
          throw new HttpError(400, "Cannot overwrite a symbolic link.");
        entry = { path: name, mode: existing?.mode ?? "100644", type: "blob" as const, oid: blob };
      }
      return git.writeTree({
        ...local,
        tree: [...entries.filter((item) => item.path !== name), entry],
      });
    };
    for (const file of files)
      tree = await edit(
        tree,
        file.path.split("/"),
        await git.writeBlob({ ...local, blob: new TextEncoder().encode(file.content) }),
      );
    const identity = {
      name: fork.agent,
      email: `${fork.agent}@idiot.tax`,
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0,
    };
    const sha = await git.writeCommit({
      ...local,
      commit: {
        tree: tree!,
        parent: expected === ZERO_SHA ? [] : [expected],
        author: identity,
        committer: identity,
        message,
      },
    });
    await git.writeRef({ ...local, ref: `refs/heads/${branch}`, value: sha, force: true });
    return this.prepared(local, branch, sha);
  }

  async preparePromote(
    fork: Fork,
    branch: string,
    sha: string,
    base: string,
  ): Promise<PreparedPush> {
    const local = await this.clone(fork, branch, sha);
    if (sha === base) throw staleBase();
    try {
      if (base !== ZERO_SHA && !(await git.isDescendent({ ...local, oid: sha, ancestor: base })))
        throw staleBase();
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) throw staleBase();
      throw error;
    }
    return this.prepared(local, branch, sha);
  }
}
