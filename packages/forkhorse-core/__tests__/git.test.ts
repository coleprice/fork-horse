import * as git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git/http/web";
import { MemoryFs } from "../src/memory-fs";
import { describe, expect, it } from "vitest";
import { WorkerGit, gitHttp } from "../src/git";
import { FixtureArtifacts } from "./fixtures";
import type { Fork } from "../src/workflow-types";

const bytes = (s: string) => new TextEncoder().encode(s);
const pkt = (s: string) => (bytes(s).length + 4).toString(16).padStart(4, "0") + s;
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function band(payload: Uint8Array): Uint8Array {
  return concat(
    bytes((payload.length + 5).toString(16).padStart(4, "0")),
    new Uint8Array([1]),
    payload,
  );
}
const identity = { name: "Fixture", email: "git@idiot.tax", timestamp: 1, timezoneOffset: 0 };

/** Offline smart-HTTP peer with actual Git objects and packs, never a live remote. */
async function protocolFixture() {
  const fs = new MemoryFs();
  const dir = "/fixture";
  await fs.promises.mkdir(dir);
  await git.init({ fs, dir, defaultBranch: "main" });
  const blob = await git.writeBlob({ fs, dir, blob: bytes("original") });
  const tree = await git.writeTree({
    fs,
    dir,
    tree: [{ mode: "100644", path: "kept.txt", type: "blob", oid: blob }],
  });
  const base = await git.writeCommit({
    fs,
    dir,
    commit: { tree, parent: [], author: identity, committer: identity, message: "Base" },
  });
  const next = await git.writeCommit({
    fs,
    dir,
    commit: { tree, parent: [base], author: identity, committer: identity, message: "Next" },
  });
  const { packfile } = await git.packObjects({ fs, dir, oids: [blob, tree, base, next] });
  const fixture = {
    head: base,
    canonical: base,
    receiveCount: 0,
    command: "",
    reject: false,
    fs,
    dir,
    base,
    next,
  };
  const http: HttpClient = {
    request: async ({ url, method, body }) => {
      const receive = url.includes("git-receive-pack");
      let response: Uint8Array;
      if (method !== "POST") {
        const service = receive ? "git-receive-pack" : "git-upload-pack";
        const head = url.includes("canonical.git") ? fixture.canonical : fixture.head;
        response = bytes(
          pkt(`# service=${service}\n`) +
            "0000" +
            pkt(
              `${head} refs/heads/main\0${receive ? "report-status side-band-64k" : "side-band-64k symref=HEAD:refs/heads/main"}\n`,
            ) +
            "0000",
        );
      } else if (!receive) {
        const nak = bytes(pkt("NAK\n"));
        response = concat(nak, band(packfile!), bytes("0000"));
      } else {
        fixture.receiveCount++;
        const chunks = [];
        let length = 0;
        for await (const chunk of body!) {
          chunks.push(chunk);
          length += chunk.length;
        }
        const sent = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          sent.set(chunk, offset);
          offset += chunk.length;
        }
        const commandLength = parseInt(new TextDecoder().decode(sent.slice(0, 4)), 16);
        fixture.command = new TextDecoder().decode(sent.slice(4, commandLength));
        const packed = sent.slice(commandLength + 4);
        await fs.promises.mkdir(`${dir}/.git/objects/pack`, { recursive: true });
        await fs.promises.writeFile(`${dir}/.git/objects/pack/pushed.pack`, packed);
        await git.indexPack({ fs, dir, filepath: ".git/objects/pack/pushed.pack" });
        response = concat(
          band(
            bytes(
              pkt("unpack ok\n") +
                pkt(fixture.reject ? "ng refs/heads/main stale old id\n" : "ok refs/heads/main\n") +
                "0000",
            ),
          ),
          bytes("0000"),
        );
      }
      return {
        url,
        statusCode: 200,
        statusMessage: "OK",
        headers: {
          "content-type": `application/x-git-${receive ? "receive" : "upload"}-pack-${method === "POST" ? "result" : "advertisement"}`,
        },
        body: (async function* () {
          yield response;
        })(),
      };
    },
  };
  const artifacts = new FixtureArtifacts();
  await artifacts.create("fork");
  const fork: Fork = {
    repoName: "fork",
    agent: "alpha",
    remote: "https://git.idiot.tax/fixture/fork.git",
    createdAt: "2026-10-12T00:00:00Z",
  };
  return { fixture, artifacts, fork, adapter: new WorkerGit(artifacts, http) };
}

describe("production isomorphic-git adapter over an offline smart-HTTP peer", () => {
  it("creates a real commit preserving existing files, and sends the exact old SHA in receive-pack", async () => {
    const { fixture: f, adapter, fork, artifacts } = await protocolFixture();
    const prepared = await adapter.prepareCommit(
      fork,
      "main",
      f.base,
      [{ path: "src/new.ts", content: "new text" }],
      "Fixture change",
    );
    await prepared.push(fork.remote, "fixture-write-token?expires=123", f.base);
    expect(f.receiveCount).toBe(1);
    expect(f.command.startsWith(`${f.base} ${prepared.sha} refs/heads/main\0`)).toBe(true);
    const commit = await git.readCommit({ fs: f.fs, dir: f.dir, oid: prepared.sha });
    expect(commit.commit.parent).toEqual([f.base]);
    expect(
      new TextDecoder().decode(
        (await git.readBlob({ fs: f.fs, dir: f.dir, oid: prepared.sha, filepath: "kept.txt" }))
          .blob,
      ),
    ).toBe("original");
    expect(
      new TextDecoder().decode(
        (await git.readBlob({ fs: f.fs, dir: f.dir, oid: prepared.sha, filepath: "src/new.ts" }))
          .blob,
      ),
    ).toBe("new text");
    expect(artifacts.calls.filter((call) => call.method === "createToken")).toMatchObject([
      { scope: "read", ttl: 60 },
    ]);
    expect(artifacts.calls.filter((call) => call.method === "revokeToken")).toHaveLength(1);
  });

  it("promotes a real descendant and refuses a changed advertised canonical head before POST", async () => {
    const { fixture: f, adapter, fork } = await protocolFixture();
    f.head = f.next;
    const prepared = await adapter.preparePromote(fork, "main", f.next, f.base);
    f.canonical = "e".repeat(40);
    await expect(
      prepared.push("https://git.idiot.tax/fixture/canonical.git", "fixture-write", f.base),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.receiveCount).toBe(0);
    f.canonical = f.base;
    await prepared.push("https://git.idiot.tax/fixture/canonical.git", "fixture-write", f.base);
    expect(f.command.startsWith(`${f.base} ${f.next} refs/heads/main\0`)).toBe(true);
  });

  it("maps a server-side old-SHA rejection to stale base and never force-pushes", async () => {
    const { fixture: f, adapter, fork } = await protocolFixture();
    f.head = f.next;
    f.reject = true;
    const prepared = await adapter.preparePromote(fork, "main", f.next, f.base);
    await expect(
      prepared.push("https://git.idiot.tax/fixture/canonical.git", "fixture-write", f.base),
    ).rejects.toMatchObject({ status: 409, message: "stale base, rebase" });
    expect(f.receiveCount).toBe(1);
    expect(f.command.startsWith(`${f.base} ${f.next}`)).toBe(true);
  });

  it("refuses non-fast-forward and moved source preparation, revoking read tokens on failure", async () => {
    const { fixture: f, adapter, fork, artifacts } = await protocolFixture();
    await expect(adapter.preparePromote(fork, "main", f.base, f.next)).rejects.toMatchObject({
      status: 409,
    });
    await expect(adapter.preparePromote(fork, "main", f.next, f.base)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      adapter.preparePromote(fork, "main", f.base, "e".repeat(40)),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.receiveCount).toBe(0);
    expect(artifacts.calls.filter((call) => call.method === "revokeToken")).toHaveLength(3);
  });

  it("uses native workerd fetch and sends a git User-Agent on a successful response", async () => {
    const response = await gitHttp.request({ url: "https://git.idiot.tax/ok", method: "GET" });
    expect(response.statusCode).toBe(200);
    let received = "";
    for await (const chunk of response.body!) received += new TextDecoder().decode(chunk);
    expect(received).toBe("git/2.0 (isomorphic-git)");
  });

  it("refuses an actual outbound 302 without following or leaking provider details", async () => {
    await expect(gitHttp.request({ url: "https://git.idiot.tax/redirect" })).rejects.toMatchObject({
      status: 502,
      message: "Repository redirects are forbidden.",
    });
  });

  it("bounds cumulative streamed responses from native workerd fetch at 16 MiB", async () => {
    const bounded = await gitHttp.request({ url: "https://git.idiot.tax/limit" });
    let size = 0;
    for await (const chunk of bounded.body!) size += chunk.byteLength;
    expect(size).toBe(16 * 1024 * 1024);
    const large = await gitHttp.request({ url: "https://git.idiot.tax/oversized" });
    await expect((async () => {
      for await (const _chunk of large.body!) {
        /* drain until the cumulative transport limit refuses the response */
      }
    })()).rejects.toMatchObject({
      status: 413,
      message:
        "Git HTTP response exceeds the 16777216-byte transport limit; reached 16777217 bytes. Repository requires the sandbox Git runner.",
    });
  });

  it("sends exactly 16 MiB and refuses a cumulative request one byte larger before fetch", async () => {
    const body = async function* (extra: boolean) {
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < 16; i++) yield chunk;
      if (extra) yield new Uint8Array(1);
    };
    const bounded = await gitHttp.request({
      url: "https://git.idiot.tax/request-limit",
      method: "POST",
      body: body(false),
    });
    let received = "";
    for await (const chunk of bounded.body!) received += new TextDecoder().decode(chunk);
    expect(bounded.statusCode).toBe(200);
    expect(received).toBe("16777216");
    // This peer would return 502 if fetch happened before the request-size check.
    await expect(
      gitHttp.request({
        url: "https://git.idiot.tax/redirect",
        method: "POST",
        body: body(true),
      }),
    ).rejects.toMatchObject({
      status: 413,
      message:
        "Git HTTP request exceeds the 16777216-byte transport limit; reached 16777217 bytes. Repository requires the sandbox Git runner.",
    });
  });

  it("keeps the memory filesystem at 32 MiB and distinguishes its cumulative byte limit", async () => {
    const fs = new MemoryFs();
    await fs.promises.writeFile("/pack", new Uint8Array(31 * 1024 * 1024));
    await fs.promises.writeFile("/index", new Uint8Array(1024 * 1024));
    expect((await fs.promises.stat("/pack")).size).toBe(31 * 1024 * 1024);
    expect((await fs.promises.stat("/index")).size).toBe(1024 * 1024);
    await expect(fs.promises.writeFile("/extra", new Uint8Array(1))).rejects.toMatchObject({
      status: 413,
      message:
        "Git memory filesystem exceeds the 33554432-byte stored-byte limit; reached 33554433 bytes. Repository requires the sandbox Git runner.",
    });
    await expect(fs.promises.stat("/extra")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
