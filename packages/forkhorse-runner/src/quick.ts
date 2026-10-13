import { Snapshot } from "./snapshot";
import { sha256 } from "./runner";
import type { AuthorizedReview, CheckReceipt, ForkRepository, QuickCheck } from "./types";

export const QUICK_TIMEOUT_MS = 10_000;
export const QUICK_MESSAGE_BYTES = 4096;
export interface QuickPorts {
  loader: Pick<WorkerLoader, "load">;
  files(snapshot: Snapshot): Fetcher | Promise<Fetcher>;
  /** Trusted adapter provenance; never part of a caller request. */
  evidence: "dynamic-worker" | "mocked-worker-loader";
}

/** A trusted main module adapts the check's default function, as in upstream's code harness.
 * No environment/entrypoint imports, tail, secrets, or compatibility with Node are supplied. */
export function quickHarness(module: string): string {
  return `import check from ${JSON.stringify("./" + module)};
export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      if (typeof check !== "function") throw new Error("Invalid check module");
      return new Response("ready");
    }
    try {
      const result = await check(Object.freeze({
        read: path => env.FILES.read(path), list: prefix => env.FILES.list(prefix)
      }));
      if (!result || typeof result.ok !== "boolean" ||
          (result.message !== undefined && typeof result.message !== "string")) throw new Error();
      // Bound inside the isolate AND revalidate outside it: project code is untrusted.
      const message = typeof result.message === "string" ? result.message.slice(0, 4096) : undefined;
      return Response.json({ ok: result.ok, message });
    } catch { return Response.json({ ok: false, message: "Quick check threw or returned an invalid result." }); }
  }
};`;
}

function messageText(value: string): string {
  // Remove control/bidi escapes and stack-shaped lines; never preserve exception objects.
  const clean = [...value].map(character => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ? " " : character;
  }).join("").replace(/\s+at\s+.*$/s, "");
  const bytes = new TextEncoder().encode(clean);
  // stream:true drops an incomplete final codepoint instead of adding bytes for U+FFFD.
  return new TextDecoder().decode(bytes.subarray(0, QUICK_MESSAGE_BYTES), { stream: true });
}

async function responseText(response: Response, limit: number): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Invalid quick response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Quick response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function runQuickCheck(ports: QuickPorts | undefined, repo: ForkRepository,
  review: AuthorizedReview, check: QuickCheck): Promise<CheckReceipt> {
  const started = Date.now();
  const controller = new AbortController();
  const snapshot = new Snapshot(repo, review.commit, started + QUICK_TIMEOUT_MS);
  let imageDigest = "";
  let outcome: CheckReceipt["outcome"] = "infrastructure-error";
  let message = "Quick worker could not start.";
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        snapshot.close();
        controller.abort();
        reject(new Error("Quick deadline"));
      }, QUICK_TIMEOUT_MS);
    });
    await Promise.race([deadline, (async () => {
      const source = await snapshot.read(check.module);
      controller.signal.throwIfAborted();
      if (source === null || !ports) throw new Error("Module or loader unavailable");
      imageDigest = `module:sha256:${await sha256(source)}`;
      controller.signal.throwIfAborted();
      const entrypoint = ports.loader.load({
        compatibilityDate: "2026-10-11", compatibilityFlags: ["disallow_importable_env"],
        mainModule: "harness.js",
        modules: { "harness.js": quickHarness(check.module), [check.module]: source },
        env: { FILES: await ports.files(snapshot) }, globalOutbound: null,
        limits: { cpuMs: QUICK_TIMEOUT_MS },
      }).getEntrypoint();
      // Startup errors (including syntax/import/initialization) are distinct from check exceptions.
      await responseText(await entrypoint.fetch("https://quick.invalid/", { signal: controller.signal }), 32);
      controller.signal.throwIfAborted();
      running = true;
      const body = await responseText(await entrypoint.fetch("https://quick.invalid/", {
        method: "POST", signal: controller.signal,
      }), 32_768);
      controller.signal.throwIfAborted();
      const result: unknown = JSON.parse(body);
      if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean" ||
          ("message" in result && result.message !== undefined && typeof result.message !== "string"))
        throw new Error("Invalid result");
      message = "message" in result && typeof result.message === "string" ? messageText(result.message) : "";
      outcome = result.ok ? "passed" : "failed";
    })()]);
  } catch {
    outcome = controller.signal.aborted ? "timed-out" : running ? "failed" : "infrastructure-error";
    message = outcome === "timed-out" ? "Quick check exceeded its deadline."
      : running ? "Quick check failed." : "Quick worker could not start.";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    snapshot.close();
    // Abort the dispatched fetch, not just the host's wait. Late RPC completions are fenced too.
    controller.abort();
  }
  const finished = Date.now();
  const logs = { stdout: "", stderr: "", truncated: false };
  return { commit: review.commit, check, runtime: "dynamic-worker", imageDigest,
    exitStatus: (outcome as CheckReceipt["outcome"]) === "passed" ? 0 : outcome === "failed" ? 1 : null, outcome, message,
    startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started), logs, logDigest: await sha256(JSON.stringify(logs)) };
}
