import { env, RpcTarget } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatekeeperVendor } from "../src/worker/index.ts";
import type { ApprovalQueue, GitCache, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentForkSession } from "../src/fork-types.d.ts";
import type { FixtureWorkspace } from "./worker.ts";
import { encodePktLine, FLUSH_PKT } from "@gadgets/gatekeeper-kit/git-transport";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import brand from "../../../brand.json";
import { markIconUrl } from "../../forkhorse-dashboard/src/mark.ts";

declare global {
  namespace Cloudflare { interface Env {
    VENDOR: Service<GatekeeperVendor>; VENDOR_HTTP: Fetcher; CONNECT_CALLBACK: Service<GatekeeperConnectCallback>;
    WORKSPACES: DurableObjectNamespace<FixtureWorkspace>;
  } }
}
const ORIGIN = "https://core.fixture.idiot.tax";
const REMOTE = "https://git.fixture.idiot.tax/fixture--alpha-1.git";
const OLD = "a".repeat(40), NEXT = "b".repeat(40);
const CREDENTIAL = "fixture-agent-credential-only";
let head = OLD, role = "agent", agent = "alpha", scopes: string[], pushes: string[], unauthorized = false;
let moveDuringPush = false, badGrant = false, redirectCore = false, redirectGit = false;
let pulls: string[] = [];
let workflowCalls: { path: string; method: string; body: unknown }[] = [];
let workflowMode: "standard" | "race" = "standard";
let workflowFailure = false;
const state = () => { const value = fixtureState("fixture"); value.packets.push({ id: "workflow-packet", mode: workflowMode, title: "Workflow fixture", goal: "Fixture", paths: [], acceptance: [] }); return value; };
function packets(lines: string[]): string {
  const chunks = [...lines.map(encodePktLine), FLUSH_PKT];
  return chunks.map(c => new TextDecoder().decode(c)).join("");
}
beforeEach(() => {
  workflowCalls = []; workflowMode = "standard"; workflowFailure = false;
  head = OLD; role = "agent"; agent = "alpha"; scopes = []; pushes = []; unauthorized = false; moveDuringPush = false; badGrant = false; redirectCore = false; redirectGit = false; pulls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ORIGIN) {
      expect(request.redirect).toBe("manual");
      if (redirectCore) return new Response(null, { status: 302, headers: { location: "https://foreign.idiot.tax" } });
      expect(request.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
      if (url.pathname.endsWith("/me")) return Response.json({ role, agent,
        forks: [{ repoName: "fixture--alpha-1", remote: REMOTE, head, createdAt: "2026-01-01T00:00:00Z" }], work: [],
      }, { status: unauthorized ? 401 : 200 });
      if (url.pathname.endsWith("/state")) return Response.json(state());
      if (url.pathname.endsWith("/reviews/workflow-review") && request.method === "GET") {
        return Response.json({ review: { id: "workflow-review", receipt: null } });
      }
      if (url.pathname.endsWith("/join") || url.pathname.endsWith("/packets/workflow-packet/claim") || url.pathname.endsWith("/reviews")) {
        const body = request.method === "DELETE" ? null : await request.json();
        workflowCalls.push({ path: url.pathname, method: request.method, body });
        if (workflowFailure) return new Response("fixture-secret-error", { status: 503 });
        return Response.json({ token: "fixture-join-secret-never-return", repoName: "fixture--alpha-2", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      if (url.pathname.endsWith("/forks/fixture--alpha-1/token")) {
        const requested = await request.json<{ scope: string; ttlSeconds: number }>();
        scopes.push(requested.scope); expect(requested.ttlSeconds).toBe(60);
        return Response.json({ repoName: "fixture--alpha-1", remote: badGrant ? "https://other.idiot.tax/repo" : REMOTE,
          scope: requested.scope, token: "fixture-git-token?expires=fixture", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
    }
    if (request.url === `${REMOTE}/git-upload-pack`) {
      expect(request.headers.get("git-protocol")).toBe("version=2");
      expect(request.headers.get("user-agent")).toBe("git/2.0 (gatekeeper)");
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("x:fixture-git-token")}`);
      pulls.push(new TextDecoder().decode(await request.arrayBuffer()));
      return new Response(packets(["packfile", "\x01fixture-pack"]));
    }
    if (request.url === `${REMOTE}/git-receive-pack`) {
      expect(request.redirect).toBe("manual");
      if (redirectGit) return new Response(null, { status: 307, headers: { location: "https://foreign.idiot.tax" } });
      expect(request.headers.get("user-agent")).toBe("git/2.0 (gatekeeper)");
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("x:fixture-git-token")}`);
      const body = new TextDecoder().decode(await request.arrayBuffer()); pushes.push(body);
      expect(body).toContain(`${OLD} ${NEXT} refs/heads/main`);
      if (moveDuringPush) return new Response(packets(["unpack ok", "ng refs/heads/main stale old sha"]));
      head = NEXT;
      return new Response(packets(["unpack ok", "ok refs/heads/main"]));
    }
    throw new Error("Unexpected offline fixture request.");
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function refuse(operation: () => PromiseLike<unknown>, pattern: string) {
  try { await operation(); } catch (error) { expect(String(error)).toContain(pattern); return; }
  throw new Error("Expected refusal");
}
async function begin() { return (await env.FIXTURE.begin()).url; }
async function submit(url: string, credential = CREDENTIAL) {
  return env.VENDOR_HTTP.fetch(url, { method: "POST", headers: {
    origin: "https://os.fixture.idiot.tax", "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ coreOrigin: ORIGIN, project: "fixture", agentCredential: credential }).toString() });
}
async function connect() {
  const url = await begin();
  const form = await env.VENDOR_HTTP.fetch(url);
  expect(form.status).toBe(200); expect(form.headers.get("referrer-policy")).toBe("same-origin"); await form.text();
  const response = await submit(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("fixture-handoff-ticket"); expect(html).not.toContain(CREDENTIAL);
  return { user: await env.FIXTURE.account(), url };
}

class Cache extends RpcTarget {
  advertised: string[] = [];
  builds = 0;
  consumed = "";
  async consumePack(pack: ReadableStream<Uint8Array>): Promise<string[]> {
    this.consumed = new TextDecoder().decode(await new Response(pack).arrayBuffer()); return [OLD];
  }
  ancestor = true;
  async advertiseCommit(sha: string) { this.advertised.push(sha); }
  async isAncestor(): Promise<boolean> { return this.ancestor; }
  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    this.builds++;
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("fixture-pack")); c.close(); } });
  }
}
class Queue extends RpcTarget {
  readonly cache = new Cache();
  observations = 0;
  submitted: { id: number; description: any }[] = [];
  loseReply = false;
  async authorizeObservation() { this.observations++; }
  async getGitCache() { return this.cache; }
  async submitAction(id: number, description: unknown) {
    this.submitted.push({ id, description });
    if (this.loseReply) throw new Error("Synthetic lost queue reply");
  }
}
async function resource() {
  const { user } = await connect();
  const workspace = env.WORKSPACES.getByName(crypto.randomUUID());
  await workspace.bind(user as unknown as Parameters<typeof workspace.bind>[0], `${ORIGIN}/projects/fixture/forks/fixture--alpha-1`);
  const gatekeeper = workspace;
  const queue = new Queue();
  const session = await gatekeeper.startSession(queue as unknown as ApprovalQueue) as AgentForkSession;
  return { user, gatekeeper, queue, session };
}

it("connects an enrolled agent, advertises only its owned resource and embeds the real sidebar", async () => {
  const icon = { url: markIconUrl(brand.mark) };
  expect(await env.VENDOR.describe()).toMatchObject({ displayName: brand.name, logo: icon, providesAuth: false, autoProvisionsAccount: false });
  expect(await env.VENDOR.getSupportedResources()).toMatchObject([{ title: "Agent fork", icon }]);
  const { user, url } = await connect();
  expect(await user.describe()).toMatchObject({ displayName: `${brand.name} · alpha`, uniqueName: "alpha · fixture", providesUi: { title: brand.name } });
  expect((await user.getSupportedResources())).toHaveLength(1);
  expect(await user.getSupportedResources()).toMatchObject([{ icon }]);
  expect((await submit(url)).status).toBe(400);
  await refuse(() => user.getGatekeeperClassFor(`${ORIGIN}/projects/fixture/forks/fixture--foreign-1`), "does not own");
  await refuse(() => user.getGatekeeperClassFor(`${ORIGIN}/projects/other/forks/fixture--alpha-1`), "outside");
  const frame = await user.startAppUi!({ isAdmin: true });
  expect(frame.iframeHtml).toContain("Ask an agent");
  const batch = await (frame.ui as any).snapshot();
  expect(batch.state.claims.filter((claim: { active: boolean }) => claim.active)).toHaveLength(3);
  expect(batch.state.recentActivity).toHaveLength(3);
  expect(batch.state.blockers[0].reason).toContain("overlaps");
  expect(batch.state.reviews.map((review: { status: string }) => review.status)).toEqual(["pending", "stale", "pending"]);
  frame.ui[Symbol.dispose]();
  expect(scopes).toEqual([]);
});

it("refuses owner credentials, changed agent identity, unsafe origins and cross-origin form posts", async () => {
  role = "owner";
  expect((await submit(await begin())).status).toBe(400);
  role = "agent";
  const { user } = await connect();
  agent = "beta";
  await refuse(() => user.describe(), "enrolled agent");
  const url = await begin();
  expect((await env.VENDOR_HTTP.fetch(url, { method: "POST", body: "", headers: {
    origin: "https://foreign.idiot.tax", "content-type": "application/x-www-form-urlencoded",
  } })).status).toBe(403);
  const invalid = await env.VENDOR_HTTP.fetch(url, { method: "POST", headers: {
    origin: "https://os.fixture.idiot.tax", "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ coreOrigin: "http://127.0.0.1", project: "fixture", agentCredential: CREDENTIAL }).toString() });
  expect(invalid.status).toBe(400);
});

it("advertises heads and submits approval without minting or pushing until apply; retry is idempotent", async () => {
  const { gatekeeper, queue, session } = await resource();
  expect(await session.getHead()).toEqual({ repoName: "fixture--alpha-1", branch: "main", commitId: OLD });
  expect(queue.observations).toBe(1); expect(queue.cache.advertised).toEqual([OLD]);
  await session.push("main", NEXT);
  expect(scopes).toEqual([]); expect(pushes).toEqual([]);
  expect(queue.submitted[0].description).toMatchObject({ pushedCommits: [NEXT], awaitDecision: true, implementsRevert: false });
  await gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache);
  expect(head).toBe(NEXT); expect(scopes).toEqual(["write"]); expect(queue.cache.builds).toBe(1);
  await gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache);
  expect(pushes).toHaveLength(1);
});

it("recovers an ambiguous approval submission using the same action ID without an early write", async () => {
  const { gatekeeper, queue, session } = await resource();
  queue.loseReply = true;
  await refuse(() => session.push("main", NEXT), "interrupted");
  await refuse(() => session.push("main", "c".repeat(40)), "same branch and commit");
  expect(scopes).toEqual([]); expect(pushes).toEqual([]);
  queue.loseReply = false;
  await session.push("main", NEXT);
  expect(queue.submitted.map(action => action.id)).toEqual([1, 1]);
  await gatekeeper.applyAction(1, queue.cache as unknown as GitCache);
  await gatekeeper.applyAction(1, queue.cache as unknown as GitCache);
  expect(pushes).toHaveLength(1);
});

it("can approve or reject an OS-queued action after its submission reply was lost", async () => {
  const { gatekeeper, queue, session } = await resource();
  queue.loseReply = true;
  await refuse(() => session.push("main", NEXT), "interrupted");
  await gatekeeper.applyAction(1, queue.cache as unknown as GitCache);
  expect(head).toBe(NEXT);
  await refuse(() => session.push("main", "c".repeat(40)), "interrupted");
  await gatekeeper.rejectAction(2);
  await refuse(() => gatekeeper.applyAction(2, queue.cache as unknown as GitCache), "not pending");
  expect(pushes).toHaveLength(1);
});

it("rejects non-fast-forward pushes, unsupported branches and stale approved heads without a write token", async () => {
  const { gatekeeper, queue, session } = await resource();
  queue.cache.ancestor = false;
  await refuse(() => session.push("main", NEXT), "fast-forward");
  queue.cache.ancestor = true;
  await refuse(() => session.push("other", NEXT), "default branch");
  await session.push("main", NEXT);
  head = "c".repeat(40);
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "Fork moved");
  expect(scopes).toEqual([]); expect(pushes).toEqual([]);
  await gatekeeper.rejectAction(queue.submitted[0].id);
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "not pending");
});

it("keeps the wire CAS and refuses token remote substitution", async () => {
  const { gatekeeper, queue, session } = await resource();
  await session.push("main", NEXT); moveDuringPush = true;
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "Git push failed");
  expect(head).toBe(OLD);
  badGrant = true; moveDuringPush = false;
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "Git push failed");
  expect(pushes).toHaveLength(1);
});

it("rechecks revoked credentials and stops previously created fork capabilities", async () => {
  const { user, queue, session, gatekeeper } = await resource();
  await session.push("main", NEXT);
  unauthorized = true;
  await refuse(() => session.getHead(), "authorization");
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "authorization");
  unauthorized = false;
  await user.revoke();
  await refuse(() => session.getHead(), "connection unavailable");
  expect(scopes).toEqual([]);
});

it("stages reconnect credentials until the exact Workshop stage is committed", async () => {
  const { user } = await connect();
  const { url } = await user.reconnect();
  expect((await submit(url)).status).toBe(200);
  await refuse(() => user.commitReconnect("wrong-stage"), "stage unavailable");
  await user.commitReconnect(await env.FIXTURE.reconnectStage());
  expect((await user.describe()).uniqueName).toBe("alpha · fixture");
});

it("pulls through kit protocol v2 with a read token and refuses redirects", async () => {
  const { gatekeeper, queue, session } = await resource();
  await session.getHead();
  await gatekeeper.gitPull([OLD], queue.cache as unknown as GitCache, { type: "commit", commitHistory: { kind: "depth", depth: 1 } });
  expect(pulls).toHaveLength(1);
  expect(pulls[0]).toContain(`want ${OLD}`);
  expect(pulls[0]).not.toContain("have ");
  expect(queue.cache.consumed).toContain("fixture-pack");
  expect(scopes).toEqual(["read"]);
  redirectCore = true;
  await refuse(() => session.getHead(), "Core request failed");
  redirectCore = false;
  await session.push("main", NEXT);
  redirectGit = true;
  await refuse(() => gatekeeper.applyAction(queue.submitted[0].id, queue.cache as unknown as GitCache), "Git push failed");
  expect(pushes).toEqual([]);
});

it("publishes Stable Code Mode types, exact resource addresses, and six distinct eligible kinds", async () => {
  const { user, gatekeeper } = await resource();
  expect(await gatekeeper.describeFork()).toMatchObject({
    url: `${ORIGIN}/projects/fixture/forks/fixture--alpha-1`,
    snippet: `Agent-owned Git fork. Attach this exact address: ${ORIGIN}/projects/fixture/forks/fixture--alpha-1`,
  });
  expect((await user.getSupportedResources())[0]!.description).toContain(`${ORIGIN}/projects/fixture/forks/<repoName>`);
  const types = await gatekeeper.forkTypes();
  for (const method of ["context", "join", "claim", "release", "requestReview", "readReview", "readReceipts"]) expect(types).toContain(`${method}(`);
  expect(types).toContain("export type ContextResponse");
  expect(types).not.toMatch(/from ["']\./);
  expect((await gatekeeper.autoApprovable()).map(kind => kind.tag)).toEqual(["claim", "race-entry", "join", "push", "request-review", "release"]);
});

it("runs production workflow calls through the account provider, with observations and no early writes", async () => {
  const { session, gatekeeper, queue } = await resource();
  expect(await session.context()).toMatchObject({ project: { id: "fixture" }, myWork: [] });
  expect(await session.readReview("workflow-review")).toMatchObject({ review: { id: "workflow-review" } });
  expect(await session.readReceipts("workflow-review")).toEqual({ receipt: null });
  expect(queue.observations).toBe(3);
  const operations = [
    () => session.join(),
    () => session.claim("workflow-packet", "fixture--alpha-1"),
    () => session.requestReview("workflow-packet", "fixture--alpha-1", OLD),
    () => session.release("workflow-packet"),
  ];
  for (const [index, operation] of operations.entries()) {
    expect(await operation()).toBeUndefined();
    expect(workflowCalls).toHaveLength(index);
    const action = queue.submitted[index]!;
    expect(action.description).toMatchObject({ awaitDecision: true, autoApprovable: true });
    await gatekeeper.applyAction(action.id, queue.cache as unknown as GitCache);
    await gatekeeper.applyAction(action.id, queue.cache as unknown as GitCache);
    expect(workflowCalls).toHaveLength(index + 1);
  }
  expect(workflowCalls).toEqual([
    { path: "/projects/fixture/join", method: "POST", body: { agent: "alpha", ttlSeconds: 60 } },
    { path: "/projects/fixture/packets/workflow-packet/claim", method: "POST", body: { repoName: "fixture--alpha-1" } },
    { path: "/projects/fixture/reviews", method: "POST", body: { packet: "workflow-packet", repoName: "fixture--alpha-1", sha: OLD } },
    { path: "/projects/fixture/packets/workflow-packet/claim", method: "DELETE", body: null },
  ]);
  expect(JSON.stringify(queue.submitted)).not.toContain("fixture-join-secret");
});

it("classifies race entry from core and prevents push/workflow queue conflicts", async () => {
  const { session, gatekeeper, queue } = await resource();
  workflowMode = "race";
  await session.claim("workflow-packet", "fixture--alpha-1");
  expect(queue.submitted[0]!.description.actionKind.tag).toBe("race-entry");
  await refuse(() => session.push("main", NEXT), "pending workflow");
  await gatekeeper.rejectAction(queue.submitted[0]!.id);
  await session.push("main", NEXT);
  expect(queue.submitted[1]!.description.actionKind.tag).toBe("push");
  await refuse(() => session.join(), "pending push");
  await gatekeeper.rejectAction(queue.submitted[1]!.id);
  workflowMode = "standard";
  await session.claim("workflow-packet");
  expect(queue.submitted[2]!.description.actionKind.tag).toBe("claim");
  workflowMode = "race";
  await refuse(() => gatekeeper.applyAction(queue.submitted[2]!.id, queue.cache as unknown as GitCache), "kind changed");
  expect(workflowCalls).toEqual([]);
});

it("does not disclose provider errors or retry an uncertain joined fork", async () => {
  const { session, gatekeeper, queue, user } = await resource();
  await session.join();
  workflowFailure = true;
  await refuse(() => gatekeeper.applyAction(queue.submitted[0]!.id, queue.cache as unknown as GitCache), "outcome uncertain");
  workflowFailure = false;
  await refuse(() => gatekeeper.applyAction(queue.submitted[0]!.id, queue.cache as unknown as GitCache), "will not be sent again");
  expect(workflowCalls).toHaveLength(1);
  await user.revoke();
  await refuse(() => session.context(), "connection unavailable");
});

it("uses the injected Stable provider bearer for every workflow HTTP call instead of the draft key", async () => {
  const { CoreClient } = await import("../src/worker/core-client.ts");
  const getBearer = vi.fn(async () => `Bearer ${CREDENTIAL}` as const);
  const client = new CoreClient({ coreOrigin: ORIGIN, project: "fixture", agentCredential: "fixture-unused-draft-credential" }, "alpha", () => {}, { getBearer });
  await client.context();
  await client.executeWorkflow({ kind: "join" });
  await client.executeWorkflow({ kind: "claim", packet: "workflow-packet" });
  await client.executeWorkflow({ kind: "requestReview", packet: "workflow-packet", repoName: "fixture--alpha-1", sha: OLD });
  await client.executeWorkflow({ kind: "release", packet: "workflow-packet" });
  await client.readReview("workflow-review");
  await client.readReceipts("workflow-review");
  expect(getBearer).toHaveBeenCalledTimes(14);
  for (const args of getBearer.mock.calls) expect(args).toEqual([{ origin: ORIGIN, project: "fixture" }]);
});
