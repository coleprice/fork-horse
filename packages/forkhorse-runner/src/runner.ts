import { loadChecks } from "./checks";
import { runQuickCheck } from "./quick";
import { remoteUrl } from "./git";
import type { AuthorizedReview, Check, FullCheck, CheckReceipt, ContainerPort, ForkRepository, Receipt, RunnerPorts, RunRequest, StoredReceipt } from "./types";

export const LOG_BYTES_PER_STREAM = 32_768;
export const CHECK_TIMEOUT_MS = 120_000;
export const TOKEN_TTL_SECONDS = 180;
const WORKSPACE = "/workspace/repo";
const encoder = new TextEncoder();

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reconstruct a fixed-order representation, independent of RPC object key ordering. */
export function receiptJson(receipt: Receipt): string {
  return JSON.stringify({
    schema: receipt.schema, evidence: receipt.evidence, projectId: receipt.projectId,
    reviewId: receipt.reviewId, forkRepoName: receipt.forkRepoName, commit: receipt.commit,
    generation: receipt.generation, trigger: receipt.trigger,
    checks: receipt.checks.map((r) => ({
      commit: r.commit,
      check: r.check.tier === "quick"
        ? { name: r.check.name, tier: r.check.tier, module: r.check.module }
        : { name: r.check.name, tier: r.check.tier, image: r.check.image, run: r.check.run },
      // Omit new fields for old receipts so their immutable digests remain valid.
      ...(r.runtime !== undefined && { runtime: r.runtime }),
      ...(r.message !== undefined && { message: r.message }),
      imageDigest: r.imageDigest, exitStatus: r.exitStatus, outcome: r.outcome,
      startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs,
      logs: { stdout: r.logs.stdout, stderr: r.logs.stderr, truncated: r.logs.truncated },
      logDigest: r.logDigest,
    })),
  });
}

async function readBounded(stream: ReadableStream | null): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const bytes = new Uint8Array(LOG_BYTES_PER_STREAM);
  let used = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid log stream");
      const keep = Math.min(value.byteLength, bytes.length - used);
      bytes.set(value.subarray(0, keep), used);
      used += keep;
      truncated ||= keep < value.byteLength;
      // Drain without retaining the tail so a full pipe cannot deadlock the process.
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, used)), truncated };
}

async function command(container: ContainerPort, argv: string[], signal: AbortSignal,
  options: ContainerExecOptions = {}): Promise<{ exitCode: number; logs: CheckReceipt["logs"] }> {
  signal.throwIfAborted();
  const process = await container.exec(argv, { ...options, signal });
  signal.throwIfAborted();
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(process.stdout), readBounded(process.stderr), process.exitCode,
  ]);
  signal.throwIfAborted();
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error("Invalid exit status");
  return { exitCode, logs: { stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated } };
}

async function runCheck(ports: RunnerPorts, repo: ForkRepository, review: AuthorizedReview,
  check: FullCheck, image: string): Promise<CheckReceipt> {
  const container = ports.container;
  if (!container) throw new Error("Container binding required");
  const started = Date.now();
  const controller = new AbortController();
  let token: ArtifactsCreateTokenResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof command>> | undefined;
  let outcome: CheckReceipt["outcome"] = "infrastructure-error";
  try {
    // Mint before starting the container/deadline, so an in-flight mint cannot outlive cleanup.
    // Authorization already succeeded; slow control-plane I/O cannot leave a billable container.
    const minted = await repo.createToken("read", TOKEN_TTL_SECONDS);
    token = minted;
    if (minted.scope !== "read" || !minted.plaintext || /[\r\n\0]/.test(minted.plaintext)) throw new Error("Invalid read token");
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Check deadline exceeded"));
      }, CHECK_TIMEOUT_MS);
    });
    const execute = async () => {
      await container.interceptOutboundHttps(remoteUrl(review.forkRemote).hostname, ports.gitGateway(review.forkRemote));
      controller.signal.throwIfAborted();
      container.start({ image, enableInternet: false, entrypoint: ["sleep", "infinity"] });
      await container.setInactivityTimeout(CHECK_TIMEOUT_MS);
      controller.signal.throwIfAborted();
      const env = {
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
        GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.plaintext}`,
        GIT_CONFIG_KEY_1: "http.followRedirects", GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "http.userAgent", GIT_CONFIG_VALUE_2: "git/2.47.0",
      };
      const prepare = async (argv: string[], cwd?: string) => {
        const output = await command(container, argv, controller.signal, { env, cwd });
        if (output.exitCode !== 0) throw new Error("Checkout failed");
        return output;
      };
      await prepare(["git", "init", WORKSPACE]);
      await prepare(["git", "fetch", "--no-tags", "--depth=1", "--", review.forkRemote, review.commit], WORKSPACE);
      await prepare(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", review.commit], WORKSPACE);
      const head = await prepare(["git", "rev-parse", "HEAD"], WORKSPACE);
      if (head.logs.truncated || head.logs.stdout.trim() !== review.commit) throw new Error("Checkout mismatch");
      // Credentials were per-command env, never git config or a clone URL. Revoke before untrusted code.
      if (!await repo.revokeToken(minted.id)) throw new Error("Token revocation unconfirmed");
      token = undefined;
      controller.signal.throwIfAborted();
      return command(container, ["timeout", "--kill-after=5", "110", "sh", "-c", check.run],
        controller.signal, { cwd: WORKSPACE });
    };
    result = await Promise.race([execute(), deadline]);
    outcome = result.exitCode === 0 ? "passed" : "failed";
  } catch {
    // Never persist provider/clone exception text: it can contain credentials or command env.
    outcome = controller.signal.aborted ? "timed-out" : "infrastructure-error";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
  // Always attempt both cleanup actions. Cleanup failure prevents publication of any receipt.
  const cleanup = await Promise.allSettled([
    container.destroy(),
    token ? repo.revokeToken(token.id).then((revoked) => {
      if (!revoked) throw new Error("Token revocation unconfirmed");
    }) : Promise.resolve(),
  ]);
  if (cleanup.some((entry) => entry.status === "rejected")) throw new Error("Runner cleanup failed");
  const finished = Date.now();
  const logs = result?.logs ?? { stdout: "", stderr: "", truncated: false };
  return {
    commit: review.commit, check, runtime: "container", imageDigest: image.slice(image.lastIndexOf("sha256:")),
    exitStatus: result?.exitCode ?? null, outcome,
    startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started), logs, logDigest: await sha256(JSON.stringify(logs)),
  };
}

/** Shared by the Durable Object adapter and the explicitly mocked offline acceptance suite. */
export async function runReviewChecks(request: RunRequest, ports: RunnerPorts): Promise<StoredReceipt> {
  if (!request.reviewId || !["review-created", "before-promote"].includes(request.trigger)) throw new Error("Invalid run request");
  const review = await ports.authority.authorize(request);
  if (review.reviewId !== request.reviewId || review.trigger !== request.trigger ||
      !/^[a-f0-9]{40}$/.test(review.commit) || !review.projectId || !review.forkRepoName || !review.generation) {
    throw new Error("Invalid authorization result");
  }
  remoteUrl(review.forkRemote);
  if (ports.container?.running) throw new Error("Runner requires a fresh container");
  using repo = await ports.getFork(review.forkRepoName);
  const checks = await loadChecks(repo, review.commit);
  const receipts: CheckReceipt[] = [];
  // Execution order is quick-first even if the manifest starts with a full check.
  const ordered = [...checks.filter(c => c.tier === "quick"), ...checks.filter(c => c.tier === "full")];
  let quickFailed = false;
  let fullImages: Map<string, string> | undefined;
  for (const check of ordered) {
    if (check.tier === "quick") {
      const receipt = await runQuickCheck(ports.quick, repo, review, check);
      receipts.push(receipt);
      quickFailed ||= receipt.outcome !== "passed";
    } else if (quickFailed) {
      const now = new Date().toISOString();
      const logs = { stdout: "", stderr: "", truncated: false };
      receipts.push({ commit: review.commit, check, runtime: "container", imageDigest: "", exitStatus: null,
        outcome: "failed", startedAt: now, finishedAt: now, durationMs: null,
        message: "Skipped: a quick check failed.", logs, logDigest: await sha256(JSON.stringify(logs)) });
    } else {
      if (!fullImages) {
        fullImages = new Map();
        // Preserve full-tier preflight: validate every image before any container starts.
        for (const full of checks) if (full.tier === "full") {
          const images = ports.container?.images;
          const image = images && Object.hasOwn(images, full.image) ? images[full.image] : undefined;
          if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Check image must resolve to a configured digest");
          fullImages.set(full.name, image);
        }
      }
      const image = fullImages.get(check.name)!;
      receipts.push(await runCheck(ports, repo, review, check, image));
    }
  }
  const hasQuick = checks.some(c => c.tier === "quick");
  const hasFull = checks.some(c => c.tier === "full");
  const evidence: Receipt["evidence"] = hasQuick && ports.quick?.evidence !== "dynamic-worker" ? "mocked-worker-loader"
    : hasFull && ports.evidence !== "container" ? ports.evidence
    : hasQuick ? hasFull ? "mixed" : "dynamic-worker" : ports.evidence;
  const receipt: Receipt = {
    schema: 1, evidence, projectId: review.projectId, reviewId: review.reviewId,
    forkRepoName: review.forkRepoName, commit: review.commit, generation: review.generation,
    trigger: review.trigger, checks: receipts,
  };
  const record = { digest: await sha256(receiptJson(receipt)), receipt };
  await ports.authority.storeReceipt(record);
  if (!await ports.authority.setReviewReceiptDigest(review, record.digest)) throw new Error("Review changed during checks");
  return record;
}

/** Approval gate helper. FH-005 must call with current server-owned review/check expectations. */
export async function requirePassingReceipt(record: StoredReceipt | null, expected: {
  projectId: string; reviewId: string; forkRepoName: string; commit: string; generation: string;
  checks: Check[]; digest: string | null; requireReceipt?: boolean;
  /** Digests independently read by core from the exact reviewed commit. */
  moduleDigests?: Record<string, string>;
}): Promise<void> {
  if (expected.requireReceipt === false) return;
  if (!record || record.receipt.schema !== 1 || !["container", "dynamic-worker", "mixed"].includes(record.receipt.evidence) ||
      record.digest !== expected.digest || await sha256(receiptJson(record.receipt)) !== record.digest ||
      ["projectId", "reviewId", "forkRepoName", "commit", "generation"].some((key) =>
        record.receipt[key as keyof Receipt] !== expected[key as keyof typeof expected]) ||
      !expected.checks.length || record.receipt.checks.length !== expected.checks.length ||
      record.receipt.checks.some((r, i) => {
        const checks = [...expected.checks.filter(c => c.tier === "quick"), ...expected.checks.filter(c => c.tier === "full")];
        const check = checks[i];
        if (r.commit !== expected.commit || r.outcome !== "passed" || r.exitStatus !== 0 ||
            !check || r.check.name !== check.name || r.check.tier !== check.tier) return true;
        if (check.tier === "quick") return r.check.tier !== "quick" || r.check.module !== check.module ||
          r.runtime !== "dynamic-worker" || !["dynamic-worker", "mixed"].includes(record.receipt.evidence) ||
          !/^module:sha256:[a-f0-9]{64}$/.test(r.imageDigest) || r.imageDigest !== expected.moduleDigests?.[check.module];
        return r.check.tier !== "full" || r.check.image !== check.image || r.check.run !== check.run ||
          (r.runtime !== undefined && r.runtime !== "container") || !["container", "mixed"].includes(record.receipt.evidence);
      })) {
    throw new Error("A current passing check receipt is required");
  }
}
