import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoreClient } from "../../src/core";
import { createMcpHandler } from "../../src/mcp";

const publicOrigin = "https://usage.fixture.idiot.tax";
const credential = "api_fixture_builder";
const at = "2026-10-13T12:00:00Z";
const reported = {
  inputTokens: 800,
  outputTokens: 0,
  model: "fixture-model",
  source: "reported",
  at,
};
const usage = { reported, metered: null };
const work = [
  {
    packet: { id: "FH-061", title: "Usage fixture" },
    repoName: "demo--builder-1",
    next: "request_review",
    hint: "Fixture review hint.",
  },
];

/** Complete FH-054 standings with optional FH-060 usage fields supplied by each test. */
function race(packet: string, entrants: Record<string, unknown>[]) {
  return {
    packet,
    status: "open",
    finishedAt: null,
    winner: null,
    ledgerEntryId: null,
    entrants: entrants.map((entry) => ({
      claimedAt: at,
      firstPushAt: null,
      reviewRequestedAt: null,
      receiptPassedAt: null,
      approvedAt: null,
      promotedAt: null,
      place: null,
      closedAt: null,
      closedBy: null,
      ...entry,
    })),
  };
}

/** Labeled FH-060 HTTP contract fixture; core owns storage, monotonicity and budget enforcement. */
function fixture() {
  const calls: { path: string; method: string; bearer: boolean; body: unknown }[] = [];
  const controls = { status: 200, throws: false, state: { claims: [], races: [] } as unknown };
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
        bearer: request.headers.get("authorization") === `Bearer ${credential}`,
        body: request.method === "POST" ? await request.json() : null,
      });
      if (controls.throws) throw new Error("provider_fixture_detail_do_not_echo");
      if (controls.status !== 200)
        return Response.json(
          { error: "provider_fixture_detail_do_not_echo" },
          { status: controls.status },
        );
      if (path.endsWith("/state")) return Response.json(controls.state);
      if (path.endsWith("/me")) return Response.json({ work });
      return Response.json({ fixture: "FH-060", usage });
    },
  });
  const handler = createMcpHandler({ core, publicOrigin });
  async function rpc(method: string, params: unknown, bearer = credential) {
    const response = await handler(
      new Request(`${publicOrigin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return {
      response,
      body:
        response.status === 200
          ? ((await response.json()) as {
              result: {
                isError?: boolean;
                content: { text: string }[];
                tools: {
                  name: string;
                  description: string;
                  inputSchema: { required: string[] };
                  annotations: {
                    readOnlyHint: boolean;
                    idempotentHint: boolean;
                    destructiveHint: boolean;
                  };
                }[];
              };
            })
          : null,
    };
  }
  const call = (name: string, args: unknown, bearer = credential) =>
    rpc("tools/call", { name, arguments: args }, bearer);
  return { calls, controls, call, rpc };
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

describe("FH-061 offline workerd with FH-060 contract fixtures", () => {
  it("advertises a write with cumulative self-reporting instructions", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const { rpc, calls } = fixture();
    const { body } = await rpc("tools/list", {});
    const tool = body!.result.tools.find((item) => item.name === "report_usage")!;
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
    });
    expect(tool.inputSchema.required.toSorted()).toEqual([
      "inputTokens",
      "outputTokens",
      "packet",
      "project",
    ]);
    expect(tool.description).toContain("cumulative self-reported");
    expect(tool.description).toContain("before every request_review and when asked");
    expect(calls).toHaveLength(0);
  });

  it("forwards the exact body and caller bearer without selecting another binding or retrying", async () => {
    const { call, calls } = fixture();
    for (const counts of [
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000, model: "fixture-model" },
    ]) {
      const { response, body } = await call("report_usage", {
        project: "demo",
        packet: "FH-061",
        ...counts,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body?.result.isError).toBeUndefined();
      expect(JSON.parse(body!.result.content[0]!.text)).toEqual({ fixture: "FH-060", usage });
      expect(calls.at(-1)).toEqual({
        path: "/projects/demo/usage",
        method: "POST",
        bearer: true,
        body: { packet: "FH-061", ...counts },
      });
    }
    expect(calls).toHaveLength(2);
  });

  it("rejects invalid counts, fields, projects and non-agent credentials before core execution", async () => {
    const { call, calls } = fixture();
    const valid = { project: "demo", packet: "FH-061", inputTokens: 1, outputTokens: 2 };
    for (const field of ["inputTokens", "outputTokens"])
      for (const count of [undefined, -1, 1.5, 1_000_000_001, "1", null])
        expect(
          (await call("report_usage", { ...valid, [field]: count })).body?.result.isError,
        ).toBe(true);
    for (const patch of [
      { project: "foreign" },
      { packet: "../review" },
      { model: 1 },
      { agent: "other" },
      { repoName: "demo--other-1" },
      { source: "metered" },
      { at },
      { token: "owner-fixture" },
    ])
      expect((await call("report_usage", { ...valid, ...patch })).body?.result.isError).toBe(true);
    for (const bearer of ["invalid", "owner-fixture"])
      expect((await call("report_usage", valid, bearer)).response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns sanitized core refusals without retries", async () => {
    const { call, controls, calls } = fixture();
    const args = { project: "demo", packet: "FH-061", inputTokens: 1, outputTokens: 0 };
    for (const status of [400, 403, 409, 429, 500, 302]) {
      controls.status = status;
      const { response, body } = await call("report_usage", args);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body?.result.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain("provider_fixture_detail");
      if (status === 409) expect(body?.result.content[0]?.text).toContain("Core conflict");
    }
    controls.throws = true;
    const { body } = await call("report_usage", args);
    expect(body?.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain("provider_fixture_detail");
    expect(calls).toHaveLength(7);
  });

  it("projects caller usage, both sources and core budget states in both read tools", async () => {
    const { call, calls, controls } = fixture();
    const metered = { inputTokens: 5, outputTokens: 7, source: "metered", at };
    const states = ["unchecked", "within", "near", "over"];
    const review = { agent: "builder", packet: "FH-061", usageAtReview: usage };
    controls.state = {
      myUsage: ["must be overwritten"],
      claims: [
        { packet: "FH-061", agent: "builder", repoName: "demo--builder-1", usage },
        { packet: "foreign", agent: "other", repoName: "demo--other-1", usage },
      ],
      reviews: [review],
      races: states.map((budget, index) => ({
        ...race(`race-${index}`, [
          {
            agent: "builder",
            repoName: `demo--builder-${index + 2}`,
            usage: { reported, metered },
            budget,
          },
          { agent: "other", repoName: "demo--other-1", usage, budget: "near" },
        ]),
        tokenBudget: 1000,
      })),
    };
    for (const name of ["get_context", "status"]) {
      const { body } = await call(name, { project: "demo" });
      expect(body?.result.isError).toBeUndefined();
      const snapshot = JSON.parse(body!.result.content[0]!.text);
      expect(snapshot.myWork).toEqual(work);
      expect(snapshot.myRaces.map((entry: { packet: string }) => entry.packet)).toEqual(
        states.map((_, index) => `race-${index}`),
      );
      expect(snapshot.myRaces[0].entrants[0].usage).toEqual({ reported, metered });
      expect(snapshot.reviews).toEqual([review]);
      expect(snapshot.myUsage).toEqual([
        {
          packet: "FH-061",
          repoName: "demo--builder-1",
          usage,
          tokenBudget: null,
          budget: "unchecked",
        },
        ...states.map((budget, index) => ({
          packet: `race-${index}`,
          repoName: `demo--builder-${index + 2}`,
          usage: { reported, metered },
          tokenBudget: 1000,
          budget,
        })),
      ]);
      // Inconsistent fixture totals prove MCP forwards core's budget, never recalculates it.
      expect(snapshot.myUsage.at(-1).budget).toBe("over");
      expect(body!.result.content[1]!.text).toContain("next: request_review");
    }
    expect(calls.map((entry) => entry.path)).toEqual([
      "/projects/demo/state",
      "/projects/demo/me",
      "/projects/demo/state",
      "/projects/demo/me",
    ]);
    expect(calls.every((entry) => entry.method === "GET" && entry.bearer)).toBe(true);
  });

  it("keeps legacy reports unknown and refuses missing or malformed budget state", async () => {
    const { call, controls } = fixture();
    const claim = { packet: "legacy", agent: "builder", repoName: "demo--builder-1" };
    controls.state = { claims: [claim], races: [race("legacy-race", [claim])] };
    const { body } = await call("status", { project: "demo" });
    expect(JSON.parse(body!.result.content[0]!.text).myUsage).toEqual(
      ["legacy", "legacy-race"].map((packet) => ({
        packet,
        repoName: claim.repoName,
        usage: { reported: null, metered: null },
        tokenBudget: null,
        budget: "unchecked",
      })),
    );
    for (const state of [
      { claims: [] },
      {
        claims: [],
        races: [
          {
            ...race("budgeted", [
              { ...claim, budget: "unchecked", usage: { reported: null, metered: null } },
            ]),
            tokenBudget: 1000,
          },
        ],
      },
    ]) {
      controls.state = state;
      expect((await call("get_context", { project: "demo" })).body?.result.isError).toBeUndefined();
    }
    for (const state of [
      { claims: [], races: [{ ...race("budgeted", [claim]), tokenBudget: 1000 }] },
      {
        claims: [
          { ...claim, usage: { reported: { ...reported, source: "metered" }, metered: null } },
        ],
      },
      {
        claims: [],
        races: [{ ...race("budgeted", [{ ...claim, budget: "safe" }]), tokenBudget: 1000 }],
      },
    ]) {
      controls.state = state;
      expect((await call("status", { project: "demo" })).body?.result.isError).toBe(true);
    }
  });
});
