import { vi } from "vitest";
import type { AuthorizedReview, Check, ContainerPort, ForkRepository, RunnerPorts, RunRequest, StoredReceipt } from "../src/types";

// All values and container behavior here are fabricated offline fixtures.
export const COMMIT = "a".repeat(40);
export const IMAGE = `registry.idiot.tax/test@sha256:${"b".repeat(64)}`;
export const TOKEN = "fixture-read-token";
export const check: Check = { name: "unit", tier: "full", image: "test", run: "npm test" };
export const request: RunRequest = { reviewId: "review-1", trigger: "review-created" };
export const review: AuthorizedReview = {
  ...request, projectId: "project", forkRepoName: "project--agent-1",
  forkRemote: "https://git.idiot.tax/project--agent-1.git", commit: COMMIT, generation: "run-1",
};

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

export function processResult(stdout = "", stderr = "", exitCode = 0): ExecProcess {
  return {
    stdout: stream(stdout), stderr: stream(stderr), stdin: null, pid: 1, isPty: false,
    exitCode: Promise.resolve(exitCode), kill: vi.fn(), resize: vi.fn(),
    output: vi.fn(async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode })),
  };
}

export function fixture() {
  const events: string[] = [];
  const records: StoredReceipt[] = [];
  let running = false;
  const repo = {
    createToken: vi.fn(async () => {
      events.push("mint-read");
      return { id: "token-1", plaintext: TOKEN, scope: "read" as const, expiresAt: "2099-01-01T00:00:00Z" };
    }),
    revokeToken: vi.fn(async () => { events.push("revoke"); return true; }),
    readCommit: vi.fn(async (_commit: string) => ({
      hash: COMMIT, treeHash: "c".repeat(40), message: "fixture", parents: [],
      author: { name: "fixture", email: "fixture@idiot.tax" },
      committer: { name: "fixture", email: "fixture@idiot.tax" }, authoredAt: 0, committedAt: 0,
    })),
    readTree: vi.fn(async (hash: string): Promise<ArtifactsTreeEntry[]> => hash === "c".repeat(40)
      ? [{ name: ".forkhorse", type: "tree", mode: "40000", hash: "d".repeat(40) }]
      : [{ name: "checks", type: "blob", mode: "100644", hash: "e".repeat(40) }]),
    readBlob: vi.fn(async (_hash: string) => new Blob([JSON.stringify([check])])),
    [Symbol.dispose]: vi.fn(() => events.push("dispose")),
  } satisfies ForkRepository;
  const container = {
    get running() { return running; },
    images: { test: IMAGE },
    start: vi.fn(() => { events.push("start"); running = true; }),
    destroy: vi.fn(async () => { events.push("destroy"); running = false; }),
    setInactivityTimeout: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    exec: vi.fn(async (argv: string[], _options?: ContainerExecOptions): Promise<ExecProcess> => {
      if (argv[0] === "timeout") { events.push("check"); return processResult("tests pass\n"); }
      return processResult(argv.includes("rev-parse") ? `${COMMIT}\n` : "");
    }),
  } satisfies ContainerPort;
  const authority = {
    authorize: vi.fn(async (input: RunRequest) => { events.push("authorize"); return { ...review, ...input }; }),
    storeReceipt: vi.fn(async (record: StoredReceipt) => { events.push("store"); records.push(record); }),
    setReviewReceiptDigest: vi.fn(async () => { events.push("attach"); return true; }),
  };
  const ports: RunnerPorts = {
    authority, container, getFork: vi.fn(async () => repo), evidence: "mocked-container-port",
    // Opaque capability identity, never used for network access by this mock container.
    gitGateway: vi.fn(() => ({}) as Fetcher),
  };
  return { ports, repo, container, authority, events, records };
}
