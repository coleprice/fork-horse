import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChecks, parseChecks } from "../src/checks";
import { forwardGitRead, remoteUrl } from "../src/git";
import { CHECK_TIMEOUT_MS, LOG_BYTES_PER_STREAM, receiptJson, requirePassingReceipt, runReviewChecks, sha256, TOKEN_TTL_SECONDS } from "../src/runner";
import { check, COMMIT, fixture, IMAGE, processResult, request, review, TOKEN } from "./fixtures";

// OFFLINE ACCEPTANCE ONLY: every container process, token, and Supervisor call is mocked.
describe("offline mocked container-port receipts", () => {
  afterEach(() => vi.useRealTimers());

  it("authorizes, checks the exact commit with read extraHeader, revokes, destroys, stores then attaches", async () => {
    const f = fixture();
    const record = await runReviewChecks(request, f.ports);
    expect(record.receipt.evidence).toBe("mocked-container-port");
    expect(record.receipt.checks[0]).toMatchObject({ commit: COMMIT, exitStatus: 0, outcome: "passed", imageDigest: `sha256:${"b".repeat(64)}` });
    expect(f.events).toEqual(["authorize", "mint-read", "start", "revoke", "check", "destroy", "store", "attach", "dispose"]);
    expect(f.repo.createToken).toHaveBeenCalledWith("read", TOKEN_TTL_SECONDS);
    expect(f.container.start).toHaveBeenCalledWith({ image: IMAGE, enableInternet: false, entrypoint: ["sleep", "infinity"] });
    expect(f.container.interceptOutboundHttps).toHaveBeenCalledWith("git.idiot.tax", expect.anything());
    expect(f.repo.readCommit).toHaveBeenCalledWith(COMMIT);
    const fetchCall = f.container.exec.mock.calls.find(([argv]) => argv.includes("fetch"))!;
    expect(fetchCall[0]).toEqual(["git", "fetch", "--no-tags", "--depth=1", "--", review.forkRemote, COMMIT]);
    expect(fetchCall[1]?.env).toMatchObject({ GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}`, GIT_CONFIG_VALUE_1: "false" });
    const checkCall = f.container.exec.mock.calls.find(([argv]) => argv[0] === "timeout")!;
    expect(checkCall[1]?.env).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(record.digest).toBe(await sha256(receiptJson(record.receipt)));
    expect(record.receipt.checks[0]?.logDigest).toBe(await sha256(JSON.stringify(record.receipt.checks[0]?.logs)));
  });

  it("always reruns before promote, with a new token and exact check manifest", async () => {
    const f = fixture();
    await runReviewChecks(request, f.ports);
    const result = await runReviewChecks({ ...request, trigger: "before-promote" }, f.ports);
    expect(result.receipt.trigger).toBe("before-promote");
    expect(f.repo.createToken).toHaveBeenCalledTimes(2);
    expect(f.container.start).toHaveBeenCalledTimes(2);
  });

  it("denies access before opening a repository or minting a token", async () => {
    const f = fixture();
    f.authority.authorize.mockRejectedValue(new Error("Denied"));
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("Denied");
    expect(f.ports.getFork).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
  });

  it("rejects a mutable/unknown image before startup or token creation", async () => {
    const f = fixture();
    f.container.images.test = "test:latest";
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("configured digest");
    expect(f.repo.createToken).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
  });

  it("rejects concurrent/reused containers without destroying another execution", async () => {
    const f = fixture();
    f.container.start();
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("fresh container");
    expect(f.container.destroy).not.toHaveBeenCalled();
  });

  it.each(["fetch", "rev-parse"])("records %s failure without leaking clone output or running the check", async (stage) => {
    const f = fixture();
    const original = f.container.exec.getMockImplementation()!;
    f.container.exec.mockImplementation(async (argv, options) => argv.includes(stage)
      ? processResult(TOKEN, TOKEN, stage === "fetch" ? 1 : 0) : original(argv, options));
    const record = await runReviewChecks(request, f.ports);
    expect(record.receipt.checks[0]?.outcome).toBe("infrastructure-error");
    expect(f.events).not.toContain("check");
    expect(f.repo.revokeToken).toHaveBeenCalledWith("token-1");
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(record)).not.toContain(TOKEN);
  });

  it("records command failure and keeps bounded deterministic logs", async () => {
    const f = fixture();
    const original = f.container.exec.getMockImplementation()!;
    f.container.exec.mockImplementation(async (argv, options) => argv[0] === "timeout"
      ? processResult("x".repeat(LOG_BYTES_PER_STREAM + 1024), "failure", 7) : original(argv, options));
    const record = await runReviewChecks(request, f.ports);
    expect(record.receipt.checks[0]).toMatchObject({ exitStatus: 7, outcome: "failed", logs: { truncated: true, stderr: "failure" } });
    expect(record.receipt.checks[0]?.logs.stdout.length).toBe(LOG_BYTES_PER_STREAM);
  });

  it("enforces a deadline even when the mocked process never exits", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.container.exec.getMockImplementation()!;
    f.container.exec.mockImplementation(async (argv, options) => argv[0] === "timeout"
      ? { ...processResult(), exitCode: new Promise<number>(() => {}) } : original(argv, options));
    const pending = runReviewChecks(request, f.ports);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 1);
    const record = await pending;
    expect(record.receipt.checks[0]).toMatchObject({ outcome: "timed-out", exitStatus: null });
    expect(f.container.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a failed start", async () => {
    const f = fixture();
    f.container.start.mockImplementation(() => { throw new Error("startup failure"); });
    const record = await runReviewChecks(request, f.ports);
    expect(record.receipt.checks[0]?.outcome).toBe("infrastructure-error");
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.repo.revokeToken).toHaveBeenCalledWith("token-1");
  });

  it("fails closed on token revocation and cleanup errors", async () => {
    const f = fixture();
    f.repo.revokeToken.mockRejectedValue(new Error("revocation unavailable"));
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("cleanup failed");
    expect(f.events).not.toContain("check");
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.authority.storeReceipt).not.toHaveBeenCalled();
    expect(f.authority.setReviewReceiptDigest).not.toHaveBeenCalled();
  });

  it("does not publish a passing receipt if destroy fails", async () => {
    const f = fixture();
    f.container.destroy.mockRejectedValue(new Error("destroy failed"));
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("cleanup failed");
    expect(f.authority.storeReceipt).not.toHaveBeenCalled();
  });

  it("runs each defined check in a clean container", async () => {
    const f = fixture();
    f.repo.readBlob.mockResolvedValue(new Blob([JSON.stringify([check, { ...check, name: "integration" }])]));
    const result = await runReviewChecks(request, f.ports);
    expect(result.receipt.checks).toHaveLength(2);
    expect(f.container.destroy).toHaveBeenCalledTimes(2);
    expect(f.repo.createToken).toHaveBeenCalledTimes(2);
  });

  it("never attaches an unstored receipt or overwrites a changed review", async () => {
    const f = fixture();
    f.authority.storeReceipt.mockRejectedValue(new Error("storage failed"));
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("storage failed");
    expect(f.authority.setReviewReceiptDigest).not.toHaveBeenCalled();
    f.authority.storeReceipt.mockResolvedValue();
    f.authority.setReviewReceiptDigest.mockResolvedValue(false);
    await expect(runReviewChecks(request, f.ports)).rejects.toThrow("Review changed");
  });

  it("requires a passing container receipt by default; mocked evidence never grants approval", async () => {
    const f = fixture();
    const record = await runReviewChecks(request, f.ports);
    const expected = { ...review, checks: [check], digest: record.digest };
    await expect(requirePassingReceipt(record, expected)).rejects.toThrow("passing container receipt");
    await expect(requirePassingReceipt(null, expected)).rejects.toThrow("passing container receipt");
    await expect(requirePassingReceipt(null, { ...expected, requireReceipt: false })).resolves.toBeUndefined();
    // Fabricated receipt exercises the production validator; this is not live evidence.
    const synthetic = structuredClone(record);
    synthetic.receipt.evidence = "container";
    synthetic.digest = await sha256(receiptJson(synthetic.receipt));
    await expect(requirePassingReceipt(synthetic, { ...expected, digest: synthetic.digest })).resolves.toBeUndefined();
    await expect(requirePassingReceipt(synthetic, { ...expected, digest: synthetic.digest, commit: "f".repeat(40) })).rejects.toThrow();
    synthetic.receipt.checks[0]!.exitStatus = 1;
    synthetic.digest = await sha256(receiptJson(synthetic.receipt));
    await expect(requirePassingReceipt(synthetic, { ...expected, digest: synthetic.digest })).rejects.toThrow();
  });
});

describe("checks manifest and Git egress", () => {
  it.each([[], [{ ...check, tier: "quick" }], [check, check], [{ ...check, run: "" }], [{ ...check, token: "forbidden" }]].map((value) => ({ value })))("rejects invalid checks $value", ({ value }) => {
    expect(() => parseChecks(JSON.stringify(value))).toThrow();
  });

  it("rejects oversized manifests and symbolic checks files", async () => {
    expect(() => parseChecks(" ".repeat(32_769))).toThrow("too large");
    const f = fixture();
    f.repo.readTree.mockResolvedValue([{ name: ".forkhorse", type: "symlink", mode: "120000", hash: "d".repeat(40) }]);
    await expect(loadChecks(f.repo, COMMIT)).rejects.toThrow();
  });

  it.each(["http://git.idiot.tax/r", "https://user:token@git.idiot.tax/r", "https://git.idiot.tax/r?token=x", "https://git.idiot.tax/r/"])("rejects unsafe remote %s", (remote) => {
    expect(() => remoteUrl(remote)).toThrow();
  });

  it("allows only the selected fork's smart Git read protocol and prevents redirects", async () => {
    const forward = vi.fn<typeof fetch>(async () => new Response("ok"));
    const response = await forwardGitRead(new Request(`${review.forkRemote}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Cookie: "private", "User-Agent": "other" },
    }), review.forkRemote, forward);
    expect(response.status).toBe(200);
    const sent = forward.mock.calls[0]![0] as Request;
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("User-Agent")).toMatch(/^git\//);
    expect(sent.headers.get("Cookie")).toBeNull();
    expect(sent.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    for (const url of [
      `${review.forkRemote}/git-receive-pack`, `${review.forkRemote}/info/refs?service=git-receive-pack`,
      "https://git.idiot.tax/other.git/git-upload-pack", "https://elsewhere.idiot.tax/repo/git-upload-pack",
      review.forkRemote.replace("https:", "http:") + "/git-upload-pack",
    ]) {
      expect((await forwardGitRead(new Request(url), review.forkRemote, forward)).status).toBe(403);
    }
    expect(forward).toHaveBeenCalledOnce();
  });
});

it("executes the offline suite under workerd", () => {
  expect(navigator.userAgent).toContain("Cloudflare-Workers");
});
