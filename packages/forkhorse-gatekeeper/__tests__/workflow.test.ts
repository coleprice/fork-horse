import { expect, it, vi } from "vitest";
import { WorkflowActions, type WorkflowContext, type WorkflowWrite } from "../src/worker/workflow.ts";
import { workflowSource } from "../src/worker/workflow-source.ts";

// Local workerd fixture only. Production provider integration is a separate gate.
function fixture() {
  const data = new Map<string, unknown>();
  const store = {
    get<T>(key: string) { return data.get(key) as T | undefined; },
    put<T>(key: string, value: T) { data.set(key, structuredClone(value)); },
    list<T>({ prefix }: { prefix?: string } = {}) {
      return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))) as Map<string, T>;
    },
  };
  const context = { project: { id: "fixture" }, packets: [{ id: "fixture-packet", mode: "standard" }], myWork: [] } as unknown as WorkflowContext;
  const identity = vi.fn(async () => ({ agent: "fixture-agent", work: context.myWork }));
  const request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => context);
  const source = workflowSource({ identity, request });
  const queue = { authorizeObservation: vi.fn(async () => {}), submitAction: vi.fn(async (_id: number, _description: unknown) => {}) };
  const actions = new WorkflowActions(store as unknown as DurableObjectStorage["kv"], source);
  return { data, store, context, identity, request, source, queue, actions };
}
const cases: [WorkflowWrite, string, string, unknown][] = [
  [{ kind: "join" }, "/join", "POST", { agent: "fixture-agent", ttlSeconds: 60 }],
  [{ kind: "claim", packet: "fixture-packet", repoName: "fixture-fork" }, "/packets/fixture-packet/claim", "POST", { repoName: "fixture-fork" }],
  [{ kind: "claim", packet: "fixture-packet" }, "/packets/fixture-packet/claim", "POST", {}],
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
  expect(f.request).not.toHaveBeenCalled();
  await resumed.apply(1);
  expect(f.request).toHaveBeenCalledOnce();
});

it("can approve an action whose queue reply was lost", async () => {
  const f = fixture();
  f.queue.submitAction.mockRejectedValueOnce(new Error("fixture-lost-reply"));
  await expect(f.actions.submit(f.queue, { kind: "join" })).rejects.toThrow("interrupted");
  await f.actions.apply(1);
  expect(f.request).toHaveBeenCalledOnce();
});

it("never repeats an uncertain join or review after a lost core response", async () => {
  for (const operation of [cases[0]![0], cases[3]![0]]) {
    const f = fixture();
    await f.actions.submit(f.queue, operation);
    f.request.mockRejectedValue(new Error("fixture-secret-in-error"));
    await expect(f.actions.apply(1)).rejects.toThrow("outcome uncertain");
    const resumed = new WorkflowActions(f.store as unknown as DurableObjectStorage["kv"], f.source);
    await expect(resumed.apply(1)).rejects.toThrow("will not be sent again");
    await expect(resumed.submit(f.queue, operation)).rejects.toThrow("outcome uncertain");
    await expect(resumed.reject(1)).rejects.toThrow("already sent");
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.stringify([...f.data])).not.toContain("fixture-secret");
  }
});

it("denial prevents writes and revoked authorization is rechecked on apply", async () => {
  const f = fixture();
  await f.actions.submit(f.queue, { kind: "join" });
  await f.actions.reject(1);
  await expect(f.actions.apply(1)).rejects.toThrow("not pending");
  await f.actions.submit(f.queue, { kind: "release", packet: "fixture" });
  f.identity.mockRejectedValue(new Error("Fixture revoked"));
  await expect(f.actions.apply(2)).rejects.toThrow("revoked");
  expect(f.request).not.toHaveBeenCalled();
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
  expect(f.request).not.toHaveBeenCalled();
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
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockImplementationOnce(async () => {
    f.identity.mockRejectedValue(new Error("Fixture revoked during read"));
    return f.context;
  });
  await expect(f.actions.context(f.queue)).rejects.toThrow("revoked during read");
});
