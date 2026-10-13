import { describe, expect, it } from "vitest";
import { ReviewReader } from "../src/review-detail";
import { ZERO_SHA } from "../src/trees";
import { FixtureArtifacts, BEFORE, AFTER } from "./fixtures";

const hash = (n: number) => n.toString(16).padStart(40, "0");
const entry = (name: string, n: number): ArtifactsTreeEntry => ({ name, hash: hash(n), mode: "100644", type: "blob" });
const commit = (sha: string, parents: string[], committedAt = 1, message = "Fixture subject"): ArtifactsCommitMetadata => ({
  hash: sha, treeHash: hash(10), parents, message, committedAt, authoredAt: committedAt,
  author: { name: "Fixture author", email: "author@idiot.tax" }, committer: { name: "Fixture author", email: "author@idiot.tax" },
});
async function fixture() {
  const artifacts = new FixtureArtifacts();
  await artifacts.create("fixture");
  const repo = await artifacts.get("fixture");
  return { artifacts, repo, reader: new ReviewReader(repo) };
}

describe("bounded exact-commit review reads in workerd (offline Artifacts fixtures)", () => {
  it("sorts and caps files, counts the full change, handles modes and never resolves moving refs", async () => {
    const f = await fixture();
    const changes = await f.reader.changes(BEFORE, AFTER);
    expect(changes.public).toEqual({ base: BEFORE, head: AFTER, fileCount: 4, truncated: false, files: [
      { path: "added.txt", status: "added" }, { path: "mode.sh", status: "modified" },
      { path: "removed.txt", status: "deleted" }, { path: "src/index.ts", status: "modified" },
    ] });
    f.artifacts.changedPaths = Array.from({ length: 205 }, (_, i) => `file-${String(204 - i).padStart(3, "0")}`);
    const capped = await new ReviewReader(f.repo).changes(BEFORE, AFTER);
    expect(capped.public).toMatchObject({ fileCount: 205, truncated: true });
    expect(capped.public.files).toHaveLength(200);
    expect(capped.public.files[0]!.path).toBe("file-000");
    expect(capped.public.files.at(-1)!.path).toBe("file-199");
    await expect(f.reader.diff("file-204", capped)).rejects.toMatchObject({ status: 404 });
    expect(f.artifacts.calls.some(c => c.method === "log" || c.method === "createToken")).toBe(false);
  });

  it("returns base..head through both merge parents, excludes all base ancestry, caps 50 and parses only final trailers", async () => {
    const f = await fixture();
    f.artifacts.reviewCommits.set(BEFORE, commit(BEFORE, [hash(500)]));
    f.artifacts.reviewCommits.set(hash(500), commit(hash(500), []));
    for (let i = 1; i <= 52; i++) f.artifacts.reviewCommits.set(hash(i), commit(hash(i), [i === 1 ? BEFORE : hash(i - 1)], i));
    f.artifacts.reviewCommits.set(AFTER, commit(AFTER, [hash(52), hash(700)], 100,
      "Subject\n\nFork-Horse-Packet: prose\n\nFork-Horse-Packet: FH-039\nFork-Horse-Agent: fixture\n"));
    f.artifacts.reviewCommits.set(hash(700), commit(hash(700), [hash(500)], 90, "Side\n\nFork-Horse-Agent: prose\nnot a trailer"));
    const result = await f.reader.history(BEFORE, AFTER);
    expect(result.commitsTruncated).toBe(true);
    expect(result.commits).toHaveLength(50);
    expect(result.commits[0]).toEqual({ sha: AFTER, subject: "Subject", authorName: "Fixture author", packetTrailer: "FH-039", agentTrailer: "fixture" });
    expect(result.commits[1]).toMatchObject({ sha: hash(700), packetTrailer: null, agentTrailer: null });
    expect(JSON.stringify(result)).not.toContain("@idiot.tax");
    expect(result.commits.some(c => c.sha === BEFORE || c.sha === hash(500))).toBe(false);
  });

  it("supports the empty base and unchanged histories", async () => {
    const f = await fixture();
    expect((await f.reader.changes(ZERO_SHA, BEFORE)).public.files.every(file => file.status === "added")).toBe(true);
    expect(await f.reader.history(BEFORE, BEFORE)).toEqual({ commits: [], commitsTruncated: false });
  });

  it.each(["../escape", "a/b", "a\\b", ".git", "a\u0000b"])("rejects unsafe tree components: %s", async name => {
    const f = await fixture();
    f.artifacts.reviewTrees.set("3".repeat(40), [entry(name, 30)]);
    await expect(f.reader.changes(BEFORE, AFTER)).rejects.toThrow("Invalid repository object");
  });

  it("bounds tree entries, cycles, depth and ancestry reads", async () => {
    const f = await fixture();
    f.artifacts.reviewTrees.set("3".repeat(40), Array.from({ length: 20001 }, (_, i) => entry(`f${i}`, 30)));
    await expect(f.reader.changes(BEFORE, AFTER)).rejects.toMatchObject({ status: 413 });
    f.artifacts.reviewTrees.set("3".repeat(40), [{ name: "loop", hash: "3".repeat(40), mode: "40000", type: "tree" }]);
    await expect(new ReviewReader(f.repo).changes(BEFORE, AFTER)).rejects.toThrow("Invalid repository object");
    for (let i = 0; i < 66; i++) f.artifacts.reviewTrees.set(i ? hash(i) : "3".repeat(40), [{ name: "d", hash: hash(i + 1), mode: "40000", type: "tree" }]);
    await expect(new ReviewReader(f.repo).changes(BEFORE, AFTER)).rejects.toMatchObject({ status: 413 });
    f.artifacts.reviewCommits.set(AFTER, commit(AFTER, [hash(2100)]));
    for (let i = 1; i <= 2100; i++) f.artifacts.reviewCommits.set(hash(i), commit(hash(i), i === 1 ? [] : [hash(i - 1)]));
    await expect(new ReviewReader(f.repo).history(ZERO_SHA, AFTER)).rejects.toMatchObject({ status: 413 });
    expect(f.artifacts.calls.filter(c => c.method === "readCommit").length).toBeLessThan(2060);
  });

  it("rejects oversized metadata before UTF-8 encoding and bounds author fields", async () => {
    const f = await fixture();
    f.artifacts.reviewCommits.set(AFTER, commit(AFTER, [], 1, "x".repeat(65537)));
    await expect(f.reader.history(ZERO_SHA, AFTER)).rejects.toMatchObject({ status: 413 });
    const hugeAuthor = commit(AFTER, []);
    hugeAuthor.author.name = "x".repeat(4097);
    f.artifacts.reviewCommits.set(AFTER, hugeAuthor);
    await expect(new ReviewReader(f.repo).history(ZERO_SHA, AFTER)).rejects.toMatchObject({ status: 413 });
  });

  it("renders additions, deletions, replacements and missing newlines as unified diffs", async () => {
    const f = await fixture();
    f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["old\n"]));
    f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["new"]));
    const changes = await f.reader.changes(BEFORE, AFTER);
    expect(await f.reader.diff("src/index.ts", changes)).toEqual({ path: "src/index.ts", status: "modified", binary: false, truncated: false,
      patch: '--- "a/src/index.ts"\n+++ "b/src/index.ts"\n@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n' });
    expect((await f.reader.diff("added.txt", changes)).patch).toContain('--- /dev/null\n+++ "b/added.txt"\n@@ -0,0 +1,1 @@\n+old\n');
    expect((await f.reader.diff("removed.txt", changes)).patch).toContain('+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n');
    expect((await f.reader.diff("mode.sh", changes)).patch).toBe("");
    for (const path of ["same.txt", "missing", "../src/index.ts", "%2e%2e/x"])
      await expect(f.reader.diff(path, changes)).rejects.toMatchObject({ status: 404 });
  });

  it.each([new Uint8Array([97, 0, 98]), new Uint8Array([0xc3, 0x28])])("detects NUL and invalid UTF-8 before text diffing", async bytes => {
    const f = await fixture();
    f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["old"]));
    f.artifacts.reviewBlobs.set("8".repeat(40), new Blob([bytes]));
    const changes = await f.reader.changes(BEFORE, AFTER);
    expect(await f.reader.diff("src/index.ts", changes)).toMatchObject({ binary: true, patch: "", truncated: false });
  });

  it("caps patches in UTF-8 bytes and refuses oversized blobs before materializing content", async () => {
    const f = await fixture();
    f.artifacts.reviewBlobs.set("7".repeat(40), new Blob(["before\n"]));
    f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["🐎\n".repeat(30000)]));
    const changes = await f.reader.changes(BEFORE, AFTER);
    const result = await f.reader.diff("src/index.ts", changes);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.patch).length).toBeLessThanOrEqual(65536);
    expect(result.patch).not.toContain("\ufffd");
    f.artifacts.reviewBlobs.set("8".repeat(40), new Blob(["x".repeat(1024 * 1024 + 1)]));
    await expect(f.reader.diff("src/index.ts", changes)).rejects.toMatchObject({ status: 413 });
  });

  it("treats symlink bytes as content and gitlinks as commit references without following either", async () => {
    const f = await fixture();
    f.artifacts.reviewTrees.set("3".repeat(40), []);
    f.artifacts.reviewTrees.set("4".repeat(40), [
      { name: "link", hash: hash(900), mode: "120000", type: "symlink" },
      { name: "submodule", hash: hash(901), mode: "160000", type: "gitlink" },
    ]);
    f.artifacts.reviewBlobs.set(hash(900), new Blob(["../../outside"]));
    const changes = await f.reader.changes(BEFORE, AFTER);
    expect((await f.reader.diff("link", changes)).patch).toContain("+../../outside");
    expect((await f.reader.diff("submodule", changes)).patch).toContain(`+Subproject commit ${hash(901)}`);
    expect(f.artifacts.calls.filter(c => c.method === "readBlob")).toHaveLength(1);
  });
});
