import { env, RpcTarget } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatekeeperVendor } from "../src/worker/index.ts";
import type { ApprovalQueue, GitCache, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentForkSession } from "../src/fork-types.d.ts";
import type { FixtureWorkspace } from "./worker.ts";
import { encodePktLine, FLUSH_PKT } from "@gadgets/gatekeeper-kit/git-transport";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import brand from "../../../brand.json";

declare global {
  namespace Cloudflare { interface Env {
    VENDOR: Service<GatekeeperVendor>; VENDOR_HTTP: Fetcher; CONNECT_CALLBACK: Service<GatekeeperConnectCallback>;
    WORKSPACES: DurableObjectNamespace<FixtureWorkspace>;
  } }
}
const ORIGIN = "https://core.fixture.idiot.tax";
const REMOTE = "https://git.fixture.idiot.tax/fork-alpha.git";
const OLD = "a".repeat(40), NEXT = "b".repeat(40);
const CREDENTIAL = "fixture-agent-credential-only";
let head = OLD, role = "agent", agent = "alpha", scopes: string[], pushes: string[], unauthorized = false;
let moveDuringPush = false, badGrant = false, redirectCore = false, redirectGit = false;
let pulls: string[] = [];
const state = () => fixtureState("fixture");
function packets(lines: string[]): string {
  const chunks = [...lines.map(encodePktLine), FLUSH_PKT];
  return chunks.map(c => new TextDecoder().decode(c)).join("");
}
beforeEach(() => {
  head = OLD; role = "agent"; agent = "alpha"; scopes = []; pushes = []; unauthorized = false; moveDuringPush = false; badGrant = false; redirectCore = false; redirectGit = false; pulls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ORIGIN) {
      expect(request.redirect).toBe("manual");
      if (redirectCore) return new Response(null, { status: 302, headers: { location: "https://foreign.idiot.tax" } });
      expect(request.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
      if (url.pathname.endsWith("/me")) return Response.json({ role, agent,
        forks: [{ repoName: "fork-alpha", remote: REMOTE, head, createdAt: "2026-01-01T00:00:00Z" }],
      }, { status: unauthorized ? 401 : 200 });
      if (url.pathname.endsWith("/state")) return Response.json(state());
      if (url.pathname.endsWith("/forks/fork-alpha/token")) {
        const requested = await request.json<{ scope: string; ttlSeconds: number }>();
        scopes.push(requested.scope); expect(requested.ttlSeconds).toBe(60);
        return Response.json({ repoName: "fork-alpha", remote: badGrant ? "https://other.idiot.tax/repo" : REMOTE,
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
  await workspace.bind(user as unknown as Parameters<typeof workspace.bind>[0], `${ORIGIN}/projects/fixture/forks/fork-alpha`);
  const gatekeeper = workspace;
  const queue = new Queue();
  const session = await gatekeeper.startSession(queue as unknown as ApprovalQueue) as AgentForkSession;
  return { user, gatekeeper, queue, session };
}

it("connects an enrolled agent, advertises only its owned resource and embeds the real sidebar", async () => {
  expect(await env.VENDOR.describe()).toMatchObject({ displayName: brand.name, providesAuth: false, autoProvisionsAccount: false });
  const { user, url } = await connect();
  expect(await user.describe()).toMatchObject({ uniqueName: "alpha · fixture", providesUi: { title: brand.name } });
  expect((await user.getSupportedResources())).toHaveLength(1);
  expect((await submit(url)).status).toBe(400);
  await refuse(() => user.getGatekeeperClassFor(`${ORIGIN}/projects/fixture/forks/foreign`), "does not own");
  await refuse(() => user.getGatekeeperClassFor(`${ORIGIN}/projects/other/forks/fork-alpha`), "outside");
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
  expect(await session.getHead()).toEqual({ repoName: "fork-alpha", branch: "main", commitId: OLD });
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
