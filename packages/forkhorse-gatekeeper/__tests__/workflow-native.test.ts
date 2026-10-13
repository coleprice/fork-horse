import { env, RpcTarget } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { FixtureWorkspace } from "./worker.ts";

declare global {
  namespace Cloudflare { interface Env { WORKSPACES: DurableObjectNamespace<FixtureWorkspace> } }
}
class Queue extends RpcTarget {
  ids: number[] = [];
  observations = 0;
  async authorizeObservation() { this.observations++; }
  async submitAction(id: number, description: { awaitDecision?: boolean; autoApprovable?: boolean }) {
    expect(description.awaitDecision).toBe(true);
    expect(description.autoApprovable).toBeUndefined();
    this.ids.push(id);
  }
}

it("runs each named workflow call over native RPC with real durable approval state and an offline transport", async () => {
  const workspace = env.WORKSPACES.getByName(crypto.randomUUID());
  const queue = new Queue();
  using session = await workspace.workflowSession(queue as unknown as ApprovalQueue);
  expect(await session.context()).toEqual({ project: { id: "fixture" }, myWork: [] });
  expect(queue.observations).toBe(1);
  const calls = [
    () => session.join(),
    () => session.claim("fixture-packet", "fixture-fork"),
    () => session.requestReview("fixture-packet", "fixture-fork", "a".repeat(40)),
    () => session.release("fixture-packet"),
  ];
  for (const [index, call] of calls.entries()) {
    expect(await call()).toBeUndefined();
    expect(await workspace.workflowCalls()).toHaveLength(index);
    await workspace.applyWorkflow(queue.ids[index]!);
    await workspace.applyWorkflow(queue.ids[index]!);
    expect(await workspace.workflowCalls()).toHaveLength(index + 1);
  }
  expect(await workspace.workflowCalls()).toEqual([
    { path: "/join", method: "POST", body: { agent: "fixture-agent", ttlSeconds: 60 } },
    { path: "/packets/fixture-packet/claim", method: "POST", body: { repoName: "fixture-fork" } },
    { path: "/reviews", method: "POST", body: { packet: "fixture-packet", repoName: "fixture-fork", sha: "a".repeat(40) } },
    { path: "/packets/fixture-packet/claim", method: "DELETE", body: null },
  ]);
});
