import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ReceiptRunner } from "./worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChecks } from "../src/checks";
import { QUICK_TIMEOUT_MS } from "../src/quick";
import { Snapshot, QUICK_READ_BYTES, QUICK_LIST_PATHS } from "../src/snapshot";
import { runReviewChecks, requirePassingReceipt, receiptJson, sha256 } from "../src/runner";
import type { Check, QuickCheck } from "../src/types";
import { check, COMMIT, fixture, IMAGE, processResult, request, review } from "./fixtures";
// Vite loads the actual repo check unchanged into the real Dynamic Worker.
// @ts-expect-error raw source is provided by Vite, not the Worker type library.
import largeFilesSource from "../../../.forkhorse/quick/large-files.js?raw";
// @ts-expect-error raw manifest is provided by Vite.
import checksSource from "../../../.forkhorse/checks?raw";

const quick: QuickCheck = { name: "quick", tier: "quick", module: ".forkhorse/quick/check.js" };
const ROOT = "c".repeat(40), DIR = "d".repeat(40), CHECKS = "e".repeat(40), QUICK = "f".repeat(40), MODULE = "1".repeat(40), FILE = "2".repeat(40);
function quickFixture(source = 'export default async ctx => ({ok: (await ctx.read("brand.json")) === "fixture"});', checks: Check[] = [quick]) {
  const f = fixture();
  f.repo.readTree.mockImplementation(async hash => {
    if (hash === ROOT) return [{ name: ".forkhorse", type: "tree", mode: "40000", hash: DIR }, { name: "brand.json", type: "blob", mode: "100644", hash: FILE }];
    if (hash === DIR) return [{ name: "checks", type: "blob", mode: "100644", hash: CHECKS }, { name: "quick", type: "tree", mode: "40000", hash: QUICK }];
    if (hash === QUICK) return [{ name: "check.js", type: "blob", mode: "100644", hash: MODULE }];
    throw new Error("provider-private-tree-error");
  });
  f.repo.readBlob.mockImplementation(async (...args: unknown[]) => new Blob([args[0] === CHECKS ? JSON.stringify(checks) : args[0] === MODULE ? source : "fixture"]));
  return f;
}

async function run(f: ReturnType<typeof quickFixture>) {
  const ns = (env as unknown as { RECEIPT_RUNNER: DurableObjectNamespace<ReceiptRunner> }).RECEIPT_RUNNER;
  return runInDurableObject(ns.get(ns.newUniqueId()), async instance => {
    f.ports.quick = (instance as ReceiptRunner).fixturePorts();
    return runReviewChecks(request, f.ports);
  });
}

describe("registered large-files full tier with explicitly mocked containers under workerd", () => {
  it("registers one checkout command in the default image and keeps the example unregistered", () => {
    const checks = parseChecks(checksSource);
    expect(checks.filter(entry => entry.tier === "quick")).toEqual([
      {name:"brand-quick",tier:"quick",module:".forkhorse/quick/brand.js"},
    ]);
    const large = checks.find(entry => entry.name === "large-files");
    expect(large).toMatchObject({tier:"full",image:"default"});
    expect(large && large.tier === "full" && large.run.startsWith("node -e ")).toBe(true);
  });
  it.each([0, 1])("dispatches the exact registered full command and retains exit %s", async exitCode => {
    const large = parseChecks(checksSource).find(entry => entry.name === "large-files")!;
    const f = fixture();
    f.repo.readBlob.mockResolvedValue(new Blob([JSON.stringify([large])]));
    Object.assign(f.container.images, {default:IMAGE});
    const original = f.container.exec.getMockImplementation()!;
    f.container.exec.mockImplementation(async (argv, options) => argv[0] === "timeout"
      ? processResult(exitCode === 0 ? "All files are below 10 MB." : "", exitCode === 1 ? "fixture file is too large" : "", exitCode)
      : original(argv, options));
    const record = await runReviewChecks(request, f.ports);
    expect(record.receipt.evidence).toBe("mocked-container-port");
    expect(record.receipt.checks[0]).toMatchObject({runtime:"container",exitStatus:exitCode,outcome:exitCode === 0 ? "passed" : "failed"});
    expect(f.container.exec.mock.calls.find(([argv]) => argv[0] === "timeout")?.[0])
      .toEqual(["timeout", "--kill-after=5", "110", "sh", "-c", large.tier === "full" ? large.run : ""]);
  });
});

describe("real Dynamic Worker loader in local workerd; Artifacts and containers are fixtures", () => {
  afterEach(() => vi.useRealTimers());
  it("runs a quick-only check with exact-commit token-free loopback reads and module provenance", async () => {
    const f = quickFixture();
    f.ports.container = undefined;
    const record = await run(f);
    expect(record.receipt).toMatchObject({ evidence: "dynamic-worker", checks: [{ runtime: "dynamic-worker", outcome: "passed" }] });
    expect(record.receipt.checks[0]?.imageDigest).toMatch(/^module:sha256:[a-f0-9]{64}$/);
    expect(f.repo.readCommit.mock.calls.every(([sha]) => sha === COMMIT)).toBe(true);
    expect(f.repo.createToken).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
  });
  it.each([
    ['export default async () => ({ok:false,message:"bad brand"});', "failed", "bad brand"],
    ['export default async () => { throw new Error("private-provider-stack-token"); };', "failed", "Quick check threw or returned an invalid result."],
    ['export default ???', "infrastructure-error", "Quick worker could not start."],
    ['throw new Error("private-provider-stack-token"); export default async () => ({ok:true});', "infrastructure-error", "Quick worker could not start."],
  ])("classifies and sanitizes module %s", async (source, outcome, message) => {
    const f = quickFixture(source);
    const record = await run(f);
    expect(record.receipt.checks[0]).toMatchObject({ outcome, message });
    expect(JSON.stringify(record)).not.toContain("private-provider-stack-token");
  });
  it("blocks fetch and TCP network and supplies only FILES", async () => {
    const f = quickFixture(`import {connect} from "cloudflare:sockets";
      export default async () => {
        let blocked = 0;
        try { await fetch("https://network.idiot.tax/"); } catch { blocked++; }
        try { const s = connect({hostname:"network.idiot.tax",port:443}); await s.opened; } catch { blocked++; }
        return {ok:blocked === 2};
      };`);
    const record = await run(f);
    expect(record.receipt.checks[0]?.outcome).toBe("passed");
  });
  it("cannot import the parent environment", async () => {
    const f = quickFixture('import {env} from "cloudflare:workers"; export default async () => { try { return {ok:!!env.FILES}; } catch { return {ok:false}; } };');
    const record = await run(f);
    expect(record.receipt.checks[0]?.outcome).toBe("failed");
  });
  it("runs quick first, skips every full check on failure without starting or minting", async () => {
    const f = quickFixture('export default async () => ({ok:false});', [check, quick]);
    const record = await run(f);
    expect(record.receipt.checks.map(r => r.check.tier)).toEqual(["quick", "full"]);
    expect(record.receipt.checks[1]).toMatchObject({ outcome: "failed", durationMs: null, message: "Skipped: a quick check failed." });
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
  it("runs mixed suites while retaining mocked-container evidence", async () => {
    const f = quickFixture('export default async ctx => ({ok:(await ctx.list(".forkhorse/quick/")).join() === ".forkhorse/quick/check.js"});', [check, quick]);
    const record = await run(f);
    expect(record.receipt.evidence).toBe("mocked-container-port");
    expect(record.receipt.checks.map(r => r.outcome)).toEqual(["passed", "passed"]);
    expect(f.container.start).toHaveBeenCalledOnce();
  });
  it("bounds UTF-8 messages and removes control escapes", async () => {
    const f = quickFixture('export default async () => ({ok:false,message:"\\u001b" + "🐎".repeat(4000)});');
    const record = await run(f);
    const message = record.receipt.checks[0]!.message!;
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(4096);
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("�");
  });
  it("enforces the real 10-second deadline and blocks full execution", async () => {
    const f = quickFixture('export default async () => { await new Promise(r => setTimeout(r, 60000)); return {ok:true}; };', [quick, check]);
    const start = Date.now();
    const record = await run(f);
    expect(record.receipt.checks[0]?.outcome).toBe("timed-out");
    expect(Date.now() - start).toBeGreaterThanOrEqual(QUICK_TIMEOUT_MS - 100);
    expect(Date.now() - start).toBeLessThan(QUICK_TIMEOUT_MS + 3000);
    expect(f.container.start).not.toHaveBeenCalled();
  }, 15_000);
  it("accepts exact quick proof in required mode, rejects altered source/runtime and fake loaders; advisory ignores receipts", async () => {
    const f = quickFixture();
    const record = await run(f);
    const expected = { ...review, checks: [quick], digest: record.digest,
      moduleDigests: { [quick.module]: record.receipt.checks[0]!.imageDigest } };
    await expect(requirePassingReceipt(record, expected)).resolves.toBeUndefined();
    await expect(requirePassingReceipt(record, { ...expected, moduleDigests: {} })).rejects.toThrow();
    await expect(requirePassingReceipt(null, { ...expected, requireReceipt: false })).resolves.toBeUndefined();
    for (const mutation of ["runtime", "evidence", "digest", "commit"] as const) {
      const altered = structuredClone(record);
      if (mutation === "runtime") altered.receipt.checks[0]!.runtime = "container";
      if (mutation === "evidence") altered.receipt.evidence = "mocked-worker-loader";
      if (mutation === "digest") altered.receipt.checks[0]!.imageDigest = `module:sha256:${"0".repeat(64)}`;
      if (mutation === "commit") altered.receipt.commit = "f".repeat(40);
      altered.digest = await sha256(receiptJson(altered.receipt));
      await expect(requirePassingReceipt(altered, { ...expected, digest: altered.digest })).rejects.toThrow();
    }
  });
});

describe("snapshot bounds with fixture Artifacts under workerd", () => {
  it.each(["../brand.json", "/brand.json", "a//b", "a/./b", "a/../b", "a\\b", ".git/config", "a\0b"])("rejects unsafe path %s", async path => {
    const f = quickFixture();
    await expect(new Snapshot(f.repo, COMMIT).read(path)).rejects.toThrow("Snapshot read unavailable");
    expect(f.repo.readCommit).not.toHaveBeenCalled();
  });
  it("accounts aggregate and concurrent UTF-8 reads, including repeated reads", async () => {
    const f = quickFixture();
    f.repo.readBlob.mockResolvedValue(new Blob(["🐎".repeat(QUICK_READ_BYTES / 8)]));
    const snapshot = new Snapshot(f.repo, COMMIT);
    const results = await Promise.allSettled([snapshot.read("brand.json"), snapshot.read("brand.json"), snapshot.read("brand.json")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("bounds paths cumulatively and sanitizes provider errors", async () => {
    const f = quickFixture();
    f.repo.readTree.mockResolvedValue(Array.from({length: QUICK_LIST_PATHS}, (_, i) => ({ name: `f${i}`, type: "blob", mode: "100644", hash: FILE })));
    const snapshot = new Snapshot(f.repo, COMMIT);
    expect(await snapshot.list("")).toHaveLength(QUICK_LIST_PATHS);
    await expect(snapshot.list("")).rejects.toThrow("Snapshot list unavailable or limit exceeded.");
    f.repo.readTree.mockRejectedValue(new Error("secret-provider-body"));
    await expect(new Snapshot(f.repo, COMMIT).read("f")).rejects.toThrow(/^Snapshot read unavailable or limit exceeded\.$/);
  });
  it("returns null for absent files and rejects symlinks and malformed UTF-8", async () => {
    const f = quickFixture();
    expect(await new Snapshot(f.repo, COMMIT).read("missing")).toBeNull();
    f.repo.readBlob.mockResolvedValue(new Blob([new Uint8Array([255])]));
    await expect(new Snapshot(f.repo, COMMIT).read("brand.json")).rejects.toThrow();
    f.repo.readTree.mockResolvedValue([{ name: "brand.json", type: "symlink", mode: "120000", hash: FILE }]);
    await expect(new Snapshot(f.repo, COMMIT).read("brand.json")).rejects.toThrow();
  });
  it("revokes pending reads and prevents later access", async () => {
    const f = quickFixture();
    let resolve!: (blob: Blob) => void;
    let started!: () => void;
    const reading = new Promise<void>(r => { started = r; });
    f.repo.readBlob.mockImplementation(() => new Promise(r => { resolve = r; started(); }));
    const snapshot = new Snapshot(f.repo, COMMIT);
    const pending = snapshot.read("brand.json");
    await reading;
    snapshot.close(); resolve(new Blob(["private"]));
    await expect(pending).rejects.toThrow();
    await expect(snapshot.list("")).rejects.toThrow();
  });
  it("parses only the exact quick manifest contract", () => {
    expect(parseChecks(JSON.stringify([quick]))).toEqual([quick]);
    for (const bad of [{...quick,run:"x"}, {...quick,image:"x"}, {...quick,module:".forkhorse/quick/../bad.js"}, {...quick,module:"other.js"}])
      expect(() => parseChecks(JSON.stringify([bad]))).toThrow();
  });
});

describe("stat metadata in local workerd with fixture Artifacts", () => {
  it("exposes stat through the real FILES loopback", async () => {
    const f = quickFixture(`export default async ctx => {
      const stat = await ctx.stat("brand.json");
      return {ok:stat.size === 7 && stat.binary === false && await ctx.stat("missing") === null};
    };`);
    expect((await run(f)).receipt.checks[0]?.outcome).toBe("passed");
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
  it.each([0, 8191, 8192])("detects NUL only within the first 8 KiB (offset %s)", async offset => {
    const f = quickFixture();
    const bytes = new Uint8Array(9000).fill(255); // Invalid UTF-8 is valid stat input.
    bytes[offset] = 0;
    const blob = new Blob([bytes]);
    const slice = vi.spyOn(blob, "slice");
    const wholeRead = vi.spyOn(blob, "arrayBuffer");
    f.repo.readBlob.mockResolvedValue(blob);
    expect(await new Snapshot(f.repo, COMMIT).stat("brand.json")).toEqual({size:9000,binary:offset < 8192});
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 8192);
    expect(wholeRead).not.toHaveBeenCalled();
  });
  it("handles empty and executable files and absent paths", async () => {
    const f = quickFixture();
    expect(await new Snapshot(f.repo, COMMIT).stat("missing")).toBeNull();
    f.repo.readTree.mockResolvedValue([{name:"brand.json",type:"exec",mode:"100755",hash:FILE}]);
    f.repo.readBlob.mockResolvedValue(new Blob([]));
    expect(await new Snapshot(f.repo, COMMIT).stat("brand.json")).toEqual({size:0,binary:false});
  });
  it.each(["../brand.json", "/brand.json", "a//b", "a/./b", "a/../b", "a\\b", ".git/config", "a\0b", "", "a/", "a/.GIT/b", "a\u007fb"])("rejects unsafe stat path %s", async path => {
    const f = quickFixture();
    await expect(new Snapshot(f.repo, COMMIT).stat(path)).rejects.toThrow(/^Snapshot stat unavailable or limit exceeded\.$/);
    expect(f.repo.readCommit).not.toHaveBeenCalled();
  });
  it.each(["symlink", "gitlink", "tree"] as const)("rejects non-regular %s entries", async type => {
    const f = quickFixture();
    f.repo.readTree.mockResolvedValue([{name:"brand.json",type,mode:type === "symlink" ? "120000" : type === "gitlink" ? "160000" : "40000",hash:FILE}]);
    await expect(new Snapshot(f.repo, COMMIT).stat("brand.json")).rejects.toThrow();
    expect(f.repo.readBlob).not.toHaveBeenCalled();
  });
  it("fails closed on missing objects and sanitizes provider exceptions", async () => {
    const f = quickFixture();
    f.repo.readBlob.mockResolvedValue(null as unknown as Blob);
    await expect(new Snapshot(f.repo, COMMIT).stat("brand.json")).rejects.toThrow(/^Snapshot stat unavailable or limit exceeded\.$/);
    f.repo.readBlob.mockRejectedValue(new Error("private-provider-body"));
    await expect(new Snapshot(f.repo, COMMIT).stat("brand.json")).rejects.toThrow(/^Snapshot stat unavailable or limit exceeded\.$/);
  });
  it("shares the read budget with concurrent stat samples", async () => {
    const f = quickFixture();
    f.repo.readBlob.mockResolvedValue(new Blob(["x".repeat(QUICK_READ_BYTES - 8192)]));
    const snapshot = new Snapshot(f.repo, COMMIT);
    await snapshot.read("brand.json");
    const results = await Promise.allSettled([snapshot.stat("brand.json"), snapshot.stat("brand.json")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("reuses validated immutable tree metadata for a repository-wide scan", async () => {
    const f = quickFixture();
    f.repo.readTree.mockResolvedValue(Array.from({length:300}, (_, i) => ({name:`f${i}`,type:"blob",mode:"100644",hash:FILE})));
    f.repo.readBlob.mockResolvedValue(new Blob(["x"]));
    const snapshot = new Snapshot(f.repo, COMMIT);
    const paths = await snapshot.list("");
    const stats = await Promise.all(paths.map(path => snapshot.stat(path)));
    expect(stats).toHaveLength(300);
    expect(stats.every(stat => stat?.size === 1 && !stat.binary)).toBe(true);
    expect(f.repo.readTree).toHaveBeenCalledOnce();
  });
  it("rejects fetched trees beyond the entry budget", async () => {
    const f = quickFixture();
    f.repo.readTree.mockResolvedValue(Array.from({length:10_001}, (_, i) => ({name:`f${i}`,type:"blob",mode:"100644",hash:FILE})));
    await expect(new Snapshot(f.repo, COMMIT).stat("f0")).rejects.toThrow();
    expect(f.repo.readBlob).not.toHaveBeenCalled();
  });
  it("revokes pending stat calls and fences closed capabilities", async () => {
    const f = quickFixture();
    let resolve!: (blob: Blob) => void;
    let started!: () => void;
    const reading = new Promise<void>(r => { started = r; });
    f.repo.readBlob.mockImplementation(() => new Promise(r => { resolve = r; started(); }));
    const snapshot = new Snapshot(f.repo, COMMIT);
    const pending = snapshot.stat("brand.json");
    await reading;
    snapshot.close(); resolve(new Blob(["private"]));
    await expect(pending).rejects.toThrow();
    await expect(snapshot.stat("brand.json")).rejects.toThrow();
  });
  it.each([9_999_999, 10_000_000, 10_000_001])("runs the unregistered stat example at %s bytes without materializing the file", async size => {
    const f = quickFixture(largeFilesSource);
    const original = f.repo.readBlob.getMockImplementation()!;
    const blob = new Blob([new Uint8Array(size)]);
    const wholeRead = vi.spyOn(blob, "arrayBuffer");
    f.repo.readBlob.mockImplementation(async hash => hash === FILE ? blob : original(hash));
    const result = (await run(f)).receipt.checks[0]!;
    expect(result.outcome).toBe(size < 10_000_000 ? "passed" : "failed");
    if (size >= 10_000_000) {
      expect(result.message).toContain(`brand.json: ${size} bytes`);
      expect(result.message).toContain("32 MB");
      expect(result.message).toContain("docs/large-files.md");
    }
    expect(wholeRead).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
  });
});

it("enforces the aggregate read budget through the real loopback and sanitizes caught provider errors", async () => {
  const f = quickFixture(`export default async ctx => {
    try { await ctx.read("brand.json"); await ctx.read("brand.json"); return {ok:true}; }
    catch (error) { return {ok:false,message:error.message}; }
  };`);
  const original = f.repo.readBlob.getMockImplementation()!;
  f.repo.readBlob.mockImplementation(async hash => hash === FILE ? new Blob(["x".repeat(QUICK_READ_BYTES / 2)]) : original(hash));
  const record = await run(f);
  expect(record.receipt.checks[0]).toMatchObject({outcome:"failed",message:"Snapshot read unavailable or limit exceeded."});
});

it("revokes the file capability and aborts dispatched fetch on a deadline (explicit fake-loader seam)", async () => {
  vi.useFakeTimers();
  const f = quickFixture();
  let signal: AbortSignal | null | undefined;
  let snapshot!: Snapshot;
  f.ports.quick = {
    evidence: "mocked-worker-loader", files: value => { snapshot = value; return {} as Fetcher; },
    loader: { load: () => ({getEntrypoint: () => ({fetch: async (_url: unknown, init: RequestInit) => {
      if (init.method !== "POST") return new Response("ready");
      signal = init.signal;
      return new Promise<Response>(() => {});
    }})} as unknown as WorkerStub) },
  };
  try {
    const pending = runReviewChecks(request, f.ports);
    await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS + 1);
    const record = await pending;
    expect(signal?.aborted).toBe(true);
    await expect(snapshot.read("brand.json")).rejects.toThrow();
    expect(record.receipt).toMatchObject({evidence:"mocked-worker-loader",checks:[{outcome:"timed-out"}]});
    await expect(requirePassingReceipt(record, {...review,checks:[quick],digest:record.digest})).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});

it("lists literal file prefixes, executable files, and refuses mutable object references", async () => {
  const f = quickFixture();
  expect(await new Snapshot(f.repo, COMMIT).list("bra")).toEqual(["brand.json"]);
  f.repo.readTree.mockResolvedValue([{name:"brand.json",type:"exec",mode:"100755",hash:FILE}]);
  expect(await new Snapshot(f.repo, COMMIT).read("brand.json")).toBe("fixture");
  f.repo.readTree.mockResolvedValue([{name:"brand.json",type:"blob",mode:"100644",hash:"main"}]);
  await expect(new Snapshot(f.repo, COMMIT).read("brand.json")).rejects.toThrow();
});
