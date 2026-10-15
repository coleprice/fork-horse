import { expect, it, vi } from "vitest";
import { WorkflowActions, type WorkflowContext, type WorkflowWrite } from "../src/worker/workflow.ts";
import { workflowSource } from "../src/worker/workflow-source.ts";

// Local workerd fixture only. Production provider integration is covered by vendor tests.
function fixture() {
  const data = new Map<string, unknown>();
  const store = {
    get<T>(key: string) { return data.get(key) as T | undefined; },
    put<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
    list<T>({ prefix }: { prefix?: string } = {}) {
      return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))) as Map<string, T>;
    },
  };
  const context = { project: { id: "fixture" }, packets: [{ id: "fixture-packet", mode: "standard" }], myWork: [], forks: [{ repoName: "fixture-fork", agent: "fixture-agent", createdAt: "2026-01-01" }], claims: [], races: [], reviews: [] } as unknown as WorkflowContext;
  const identity = vi.fn(async () => ({ agent: "fixture-agent", work: context.myWork, forks: context.forks.filter(fork => fork.agent === "fixture-agent") }));
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => context);
  const source = workflowSource({ project: "fixture", identity, request });
  const queue = { authorizeObservation: vi.fn(async () => {}), submitAction: vi.fn(async (_id: number, _description: unknown) => {}) };
  const actions = new WorkflowActions(store as unknown as DurableObjectStorage["kv"], source);
  return { data, store, context, identity, request, source, queue, actions };
}
const cases: [WorkflowWrite, string, string, unknown][] = [
  [{ kind: "join" }, "/join", "POST", { agent: "fixture-agent", ttlSeconds: 60 }],
  [{ kind: "claim", packet: "fixture-packet", repoName: "fixture-fork" }, "/packets/fixture-packet/claim", "POST", { repoName: "fixture-fork" }],
  [{ kind: "claim", packet: "fixture-packet" }, "/packets/fixture-packet/claim", "POST", { repoName: "fixture-fork" }],
  [{ kind: "requestReview", packet: "fixture-packet", repoName: "fixture-fork", sha: "a".repeat(40) }, "/reviews", "POST", { packet: "fixture-packet", repoName: "fixture-fork", sha: "a".repeat(40) }],
  [{ kind: "release", packet: "fixture-packet" }, "/packets/fixture-packet/claim", "DELETE", undefined],
];

it("authorizes context as an observation, retaining the core resume shape", async () => {
  const f = fixture();
  expect(await f.actions.context(f.queue)).toEqual(f.context);
  expect(f.queue.authorizeObservation).toHaveBeenCalledOnce();
  expect(f.queue.submitAction).not.toHaveBeenCalled();
  expect(f.request).toHaveBeenCalledExactlyOnceWith("/state");
  expect(f.identity).toHaveBeenCalledTimes(3);
});

for (const [operation, path, method, body] of cases) {
  it(`queues ${operation.kind}${"repoName" in operation ? " with a fork" : ""} and sends the exact core route only on apply`, async () => {
    const f = fixture();
    const sentinel = "fixture-token-must-never-escape";
    f.request.mockImplementation(async (_path, init) => init ? { token: sentinel, repoName: "new-fixture-fork" } : f.context);
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    try {
      expect(await f.actions.submit(f.queue, operation)).toBeUndefined();
      expect(f.request.mock.calls.filter(([, init]) => init)).toEqual([]);
      const [id, description] = f.queue.submitAction.mock.calls[0]!;
      expect(description).toMatchObject({ implementsRevert: false, awaitDecision: true });
      expect(description).toHaveProperty("autoApprovable", true);
      expect(description).toHaveProperty("actionKind");
      expect(await f.actions.apply(id)).toBeUndefined();
      expect(f.request.mock.calls.filter(([, init]) => init)).toEqual([[path, {
        method, ...(body ? { body: JSON.stringify(body) } : {}),
      }]]);
      await f.actions.apply(id);
      expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
      expect(JSON.stringify([...f.data])).not.toContain(sentinel);
      expect(JSON.stringify(f.queue.submitAction.mock.calls)).not.toContain(sentinel);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
}

it("recovers a lost submission with the same action ID, including after controller recreation", async () => {
  const f = fixture();
  f.queue.submitAction.mockRejectedValueOnce(new Error("fixture-secret-in-error"));
  await expect(f.actions.submit(f.queue, { kind: "join" })).rejects.toThrow("submission interrupted");
  const resumed = new WorkflowActions(f.store as unknown as DurableObjectStorage["kv"], f.source);
  await resumed.submit(f.queue, { kind: "join" });
  await resumed.submit(f.queue, { kind: "join" });
  expect(f.queue.submitAction.mock.calls.map(([id]) => id)).toEqual([1, 1]);
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(0);
  await resumed.apply(1);
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
});

it("can approve an action whose queue reply was lost", async () => {
  const f = fixture();
  f.queue.submitAction.mockRejectedValueOnce(new Error("fixture-lost-reply"));
  await expect(f.actions.submit(f.queue, { kind: "join" })).rejects.toThrow("interrupted");
  await f.actions.apply(1);
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
});

it("keeps the fence when context is unavailable after a lost response", async () => {
  const f = fixture();
  await f.actions.submit(f.queue, { kind: "join" });
  f.request.mockImplementation(async (_path, init) => { if (init) throw new Error("fixture-secret"); return f.context; });
  await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
  f.request.mockRejectedValue(new Error("fixture-secret"));
  const resumed = new WorkflowActions(f.store as unknown as DurableObjectStorage["kv"], f.source);
  await expect(resumed.apply(1)).rejects.toThrow("outcome uncertain");
  await expect(resumed.submit(f.queue, { kind: "join" })).rejects.toThrow("outcome uncertain");
  await expect(resumed.reject(1)).rejects.toThrow("outcome uncertain");
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
  expect(JSON.stringify([...f.data])).not.toContain("fixture-secret");
});

const claim = { packet: "fixture-packet", agent: "fixture-agent", repoName: "fixture-fork", createdAt: "2026-01-01", paths: [], usage: { reported: null, metered: null } };
for (const kind of ["claim", "race", "join", "requestReview", "release"] as const) {
  function setup() {
    const f = fixture();
    const operation: WorkflowWrite = kind === "race" || kind === "claim" ? { kind: "claim", packet: "fixture-packet", repoName: "fixture-fork" } : kind === "release" ? { kind, packet: "fixture-packet" } : kind === "requestReview" ? { kind, packet: "fixture-packet", repoName: "fixture-fork", sha: "a".repeat(40) } : { kind };
    if (kind === "race") {
      f.context.packets[0]!.mode = "race";
      f.context.races = [{ packet: "fixture-packet", entrants: [] }] as unknown as WorkflowContext["races"];
    }
    if (kind === "release") f.context.claims.push(claim);
    function applied() {
      if (kind === "claim") f.context.claims.push(claim);
      if (kind === "race") f.context.races[0]!.entrants.push({ ...claim, claimedAt: claim.createdAt, closedAt: null } as unknown as WorkflowContext["races"][number]["entrants"][number]);
      if (kind === "join") f.context.forks.push({ repoName: "fixture-new-fork", agent: "fixture-agent" } as WorkflowContext["forks"][number]);
      if (kind === "requestReview") f.context.reviews.push({ ...claim, sha: "a".repeat(40) } as unknown as WorkflowContext["reviews"][number]);
      if (kind === "release") f.context.claims = [];
    }
    return { ...f, operation, applied };
  }
  it(`reconciles an applied ${kind} from context after a lost reply without another write`, async () => {
    const f = setup();
    await f.actions.submit(f.queue, f.operation);
    f.request.mockImplementation(async (_path, init) => { if (init) { f.applied(); throw new Error("fixture-lost-reply"); } return f.context; });
    await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
    const resumed = new WorkflowActions(f.store as unknown as DurableObjectStorage["kv"], f.source);
    await resumed.context(f.queue);
    expect(resumed.hasPending()).toBe(false);
    await resumed.apply(1);
    expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
  });
  it(`allows only one evidence-based retry of an absent ${kind}`, async () => {
    const f = setup();
    await f.actions.submit(f.queue, f.operation);
    f.request.mockImplementation(async (_path, init) => { if (init) throw new Error("fixture-not-applied"); return f.context; });
    await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
    await f.actions.context(f.queue);
    await f.actions.submit(f.queue, f.operation);
    await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
    await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
    expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(2);
    expect(f.actions.hasPending()).toBe(true);
    f.applied();
    await f.actions.context(f.queue);
    expect(f.actions.hasPending()).toBe(false);
  });
}

it("does not mistake existing or multiple newly discovered forks for one successful join", async () => {
  const f = fixture();
  await f.actions.submit(f.queue, { kind: "join" });
  f.request.mockImplementation(async (_path, init) => { if (init) throw new Error("fixture-lost-reply"); return f.context; });
  await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
  f.context.forks.push(...["new-one", "new-two"].map(repoName => ({ repoName, agent: "fixture-agent" } as WorkflowContext["forks"][number])));
  await f.actions.context(f.queue);
  await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
});

it("denial prevents writes and revoked authorization is rechecked on apply", async () => {
  const f = fixture();
  await f.actions.submit(f.queue, { kind: "join" });
  await f.actions.reject(1);
  await expect(f.actions.apply(1)).rejects.toThrow("not pending");
  await f.actions.submit(f.queue, { kind: "release", packet: "fixture" });
  f.identity.mockRejectedValue(new Error("Fixture revoked"));
  await expect(f.actions.apply(2)).rejects.toThrow("revoked");
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(0);
});

it("refuses conflicting pending actions and malformed paths or commit IDs before queuing", async () => {
  const f = fixture();
  for (const operation of [
    { kind: "claim", packet: "../owner" },
    { kind: "claim", packet: ".." },
    { kind: "claim", packet: "fixture", repoName: "other/fork" },
    { kind: "requestReview", packet: "fixture", repoName: "fixture", sha: "0".repeat(40) },
  ] as WorkflowWrite[]) await expect(f.actions.submit(f.queue, operation)).rejects.toThrow();
  expect(f.queue.submitAction).not.toHaveBeenCalled();
  await f.actions.submit(f.queue, { kind: "join" });
  await expect(f.actions.submit(f.queue, { kind: "release", packet: "fixture" })).rejects.toThrow("pending workflow");
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(0);
});

it("uses authenticated /me work instead of any untrusted state summary", async () => {
  const f = fixture();
  f.request.mockResolvedValue({ project: { id: "fixture" }, myWork: ["foreign-work"] });
  expect((await f.actions.context(f.queue)).myWork).toEqual([]);
});

it("denied observations do not read and revocation during a context read prevents disclosure", async () => {
  const f = fixture();
  f.queue.authorizeObservation.mockRejectedValueOnce(new Error("Fixture denied"));
  await expect(f.actions.context(f.queue)).rejects.toThrow("denied");
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(0);
  f.request.mockImplementationOnce(async () => {
    f.identity.mockRejectedValue(new Error("Fixture revoked during read"));
    return f.context;
  });
  await expect(f.actions.context(f.queue)).rejects.toThrow("revoked during read");
});


it("serializes reconciliation behind an in-flight write and retains its pre-write evidence", async () => {
  const f = fixture();
  let complete!: () => void;
  let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const reply = new Promise<void>(resolve => { complete = resolve; });
  await f.actions.submit(f.queue, { kind: "join" });
  f.request.mockImplementation(async (_path, init) => {
    if (init) {
      started(); await reply;
      f.context.forks.push({ repoName: "new-fork", agent: "fixture-agent" } as WorkflowContext["forks"][number]);
      throw new Error("Fixture lost reply");
    }
    return structuredClone(f.context);
  });
  const applying = f.actions.apply(1).catch(error => error);
  await inFlight;
  const reading = f.actions.context(f.queue);
  complete();
  expect(String(await applying)).toContain("outcome uncertain");
  await reading;
  expect(f.actions.hasPending()).toBe(false);
  expect(f.request.mock.calls.filter(([, init]) => init)).toHaveLength(1);
});

it("keeps a claim's resolved fork fixed while waiting for approval", async () => {
  const f = fixture();
  await f.actions.submit(f.queue, { kind: "claim", packet: "fixture-packet" });
  f.context.forks.push({ repoName: "newer-fork", agent: "fixture-agent", createdAt: "2026-02-01" } as WorkflowContext["forks"][number]);
  await f.actions.apply(1);
  const write = f.request.mock.calls.find(([, init]) => init)!;
  expect(JSON.parse(String(write[1]!.body))).toEqual({ repoName: "fixture-fork" });
});

it("prepares a claim from /packets and the caller's latest fork without reading full context", async () => {
  const f = fixture();
  f.context.forks.unshift({ repoName: "latest-fork", agent: "fixture-agent", createdAt: "2026-03-01" } as WorkflowContext["forks"][number]);
  f.context.forks.push({ repoName: "foreign-newer-fork", agent: "other-agent", createdAt: "2026-04-01" } as WorkflowContext["forks"][number]);
  await f.actions.submit(f.queue, { kind: "claim", packet: "fixture-packet" });
  expect(f.request).toHaveBeenCalledExactlyOnceWith("/packets");
  expect(f.queue.submitAction.mock.calls[0]![1]).toMatchObject({
    title: "Claim fixture-packet", description: "Claim packet fixture-packet on fork latest-fork.",
  });
});
