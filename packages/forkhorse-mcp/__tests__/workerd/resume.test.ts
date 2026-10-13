import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoreClient } from "../../src/core";
import { createMcpHandler } from "../../src/mcp";

const publicOrigin = "https://resume.fixture.idiot.tax";
const credential = crypto.randomUUID();
const gitToken = crypto.randomUUID();
const nextSteps = [
  "push",
  "request_review",
  "wait_for_checks",
  "fix_checks",
  "address_return",
  "wait_for_owner",
  "done",
];
// Labeled FH-041 contract fixture only: core owns all next-step computation.
const work = nextSteps.map((next, index) => ({
  packet: { id: `fh-${index}`, title: "Resume fixture" },
  repoName: `demo--builder-${index}`,
  claimedAt: "2026-01-01T00:00:00Z",
  forkHead: "a".repeat(40),
  canonicalHead: "b".repeat(40),
  review:
    index === 0
      ? null
      : {
          id: `review-${index}`,
          sha: "a".repeat(40),
          stale: false,
          returned: false,
          receipt: null,
          approved: false,
          promoted: next === "done",
        },
  next,
  hint: `Fixture hint for ${next}.`,
}));

function fixture() {
  const calls: { path: string; method: string; callerMatches: boolean; body: unknown }[] = [];
  const state = { claims: [], fixture: "FH-041 contract", myWork: ["must be overwritten"] };
  const controls = { me: { work } as unknown, status: 201, malformed: false, throws: false };
  const core = createCoreClient({
    authenticate: async (token) =>
      token === credential ? { project: "demo", agent: "builder" } : null,
    enrollAgent: async () => {
      throw new Error("Enrollment is outside this fixture.");
    },
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      calls.push({
        path,
        method: request.method,
        callerMatches: request.headers.get("authorization") === `Bearer ${credential}`,
        body: request.method === "POST" ? await request.json() : null,
      });
      if (path.endsWith("/state")) return Response.json(state);
      if (path.endsWith("/me")) return Response.json(controls.me);
      if (controls.throws) throw new Error(gitToken);
      return Response.json(
        {
          remote: "https://git.fixture.idiot.tax/demo--builder-1.git",
          token: gitToken,
          expiresAt: controls.malformed ? null : "2026-01-01T01:00:00Z",
          providerDetail: "must not be forwarded",
        },
        { status: controls.status },
      );
    },
  });
  const handler = createMcpHandler({ core, publicOrigin });
  async function call(name: string, args: unknown, bearer: string = credential) {
    const response = await handler(
      new Request(`${publicOrigin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    return {
      response,
      body:
        response.status === 200
          ? ((await response.json()) as {
              result: { isError?: boolean; content: { type: string; text: string }[] };
            })
          : null,
    };
  }
  return { calls, controls, call };
}

const outbound = vi.fn(async () => {
  throw new Error("Offline fixture blocks outbound fetch.");
});
beforeAll(() => {
  vi.stubGlobal("fetch", outbound);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(outbound).not.toHaveBeenCalled();
});

describe("FH-042 offline workerd with FH-041 contract fixtures", () => {
  it("preserves caller work and emits one resume line per item for both read tools", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const { calls, call } = fixture();
    for (const name of ["get_context", "status"]) {
      const { body, response } = await call(name, { project: "demo" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body?.result.isError).toBeUndefined();
      const content = body!.result.content;
      expect(JSON.parse(content[0]!.text)).toEqual({
        claims: [],
        fixture: "FH-041 contract",
        myWork: work,
        myUsage: [],
      });
      expect(content.slice(1).map((item) => item.text)).toEqual(
        work.map(
          (item) => `${item.packet.id} on ${item.repoName} → next: ${item.next} — ${item.hint}`,
        ),
      );
    }
    expect(calls.map((entry) => entry.path)).toEqual([
      "/projects/demo/state",
      "/projects/demo/me",
      "/projects/demo/state",
      "/projects/demo/me",
    ]);
    expect(calls.every((entry) => entry.callerMatches && entry.method === "GET")).toBe(true);
  });

  it("handles empty work but refuses missing or malformed FH-041 summaries", async () => {
    const { call, controls } = fixture();
    controls.me = { work: [], forks: [{ token: gitToken }] };
    const empty = await call("get_context", { project: "demo" });
    expect(empty.body!.result.content).toHaveLength(1);
    expect(JSON.parse(empty.body!.result.content[0]!.text).myWork).toEqual([]);
    expect(JSON.stringify(empty.body).includes(gitToken)).toBe(false);
    for (const me of [{ forks: [] }, { work: null }, { work: [{ ...work[0], next: "join" }] }]) {
      controls.me = me;
      const { body } = await call("status", { project: "demo" });
      expect(body?.result.isError).toBe(true);
      expect(body?.result.content[0]?.text).toContain("FH-041 is required");
    }
  });

  it("refreshes with the caller bearer, default/explicit TTL, no caching and no token logs", async () => {
    // Assert booleans for secret comparisons so even a failed assertion cannot print them.
    const spies = ["log", "info", "warn", "error", "debug", "trace"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}),
    );
    try {
      const { calls, call } = fixture();
      for (const ttlSeconds of [undefined, 60, 3600]) {
        const { response, body } = await call("refresh_token", {
          repoName: "demo--builder-1",
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(body?.result.isError).toBeUndefined();
        const result = JSON.parse(body!.result.content[0]!.text);
        expect(Object.keys(result).toSorted()).toEqual(["expiresAt", "remote", "token"]);
        expect(result.token === gitToken).toBe(true);
        expect(result.remote).toBe("https://git.fixture.idiot.tax/demo--builder-1.git");
        expect(result.expiresAt).toBe("2026-01-01T01:00:00Z");
      }
      expect(calls).toEqual(
        [3600, 60, 3600].map((ttlSeconds) => ({
          path: "/projects/demo/forks/demo--builder-1/token",
          method: "POST",
          callerMatches: true,
          body: { scope: "write", ttlSeconds },
        })),
      );
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("rejects invalid inputs and non-agent credentials before core execution", async () => {
    const { calls, call } = fixture();
    for (const args of [
      { repoName: "../canonical" },
      { repoName: "demo--builder-1", project: "foreign" },
      { repoName: "demo--builder-1", token: "not-accepted" },
      ...[0, 59, 3601, 1.5, "3600", null].map((ttlSeconds) => ({
        repoName: "demo--builder-1",
        ttlSeconds,
      })),
    ])
      expect((await call("refresh_token", args)).body?.result.isError).toBe(true);
    for (const bearer of ["invalid", "owner-fixture"])
      expect(
        (await call("refresh_token", { repoName: "demo--builder-1" }, bearer)).response.status,
      ).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("redacts core refusal, malformed success and thrown secret details without retries", async () => {
    const spies = ["log", "info", "warn", "error", "debug", "trace"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}),
    );
    try {
      const { call, controls, calls } = fixture();
      for (const status of [403, 404, 409, 429, 500, 302, 201]) {
        controls.status = status;
        controls.malformed = status === 201;
        const { body } = await call("refresh_token", { repoName: "demo--builder-1" });
        expect(body?.result.isError).toBe(true);
        expect(JSON.stringify(body).includes(gitToken)).toBe(false);
      }
      controls.throws = true;
      const { body } = await call("refresh_token", { repoName: "demo--builder-1" });
      expect(body?.result.isError).toBe(true);
      expect(JSON.stringify(body).includes(gitToken)).toBe(false);
      expect(calls).toHaveLength(8);
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
