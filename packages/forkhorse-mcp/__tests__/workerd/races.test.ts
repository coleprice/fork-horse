import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoreClient } from "../../src/core";
import { createMcpHandler } from "../../src/mcp";
import type { RaceState } from "../../src/races";

const publicOrigin = "https://race.fixture.idiot.tax";
const agents = ["builder", "second", "third"];
const tokens = new Map(agents.map((agent) => [agent, crypto.randomUUID()]));
const at = "2026-01-01T00:00:00Z";
const head = "a".repeat(40);

function entrant(agent: string): RaceState["entrants"][number] {
  return {
    agent,
    repoName: `demo--${agent}-1`,
    claimedAt: at,
    firstPushAt: null,
    reviewRequestedAt: null,
    receiptPassedAt: null,
    approvedAt: null,
    promotedAt: null,
    place: null,
    closedAt: null,
    closedBy: null,
  };
}
function race(packet = "FH-race"): RaceState {
  return {
    packet,
    status: "open",
    finishedAt: null,
    winner: null,
    ledgerEntryId: null,
    entrants: agents.map(entrant),
  };
}
function work(next = "wait_for_owner") {
  return {
    packet: { id: "FH-race", title: "Race fixture" },
    repoName: "demo--builder-1",
    claimedAt: at,
    forkHead: head,
    canonicalHead: "b".repeat(40),
    review: { id: "review-fixture", approved: true, receipt: { status: "passed" } },
    next,
    hint: `Core fixture hint for ${next}.`,
  };
}

/** Offline FH-052/053 HTTP contract fixtures, not the core race implementation. */
function fixture() {
  const state: Record<string, unknown> = {
    fixture: "FH-052/053 wire contract; no live services",
    packets: [
      { id: "FH-standard", title: "Legacy fixture" },
      { id: "FH-race", mode: "race" },
    ],
    claims: [],
    races: [race()],
    myRaces: ["must be overwritten"],
  };
  const controls = {
    writeStatus: 201,
    work: [work()] as unknown,
    claim: entrant("builder") as unknown,
  };
  const calls: { path: string; method: string; agent: string | undefined; body: unknown }[] = [];
  const core = createCoreClient({
    authenticate: async (token) => {
      const agent = agents.find((candidate) => tokens.get(candidate) === token);
      return agent ? { project: "demo", agent } : null;
    },
    enrollAgent: async () => {
      throw new Error("No fixture enrollment.");
    },
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const agent = agents.find(
        (candidate) => request.headers.get("authorization") === `Bearer ${tokens.get(candidate)}`,
      );
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path, method: request.method, agent, body });
      if (path.endsWith("/state")) return Response.json(state);
      if (path.endsWith("/me")) return Response.json({ work: controls.work });
      if (controls.writeStatus !== 201)
        return Response.json(
          { error: "fixture refusal; provider details must not escape" },
          { status: controls.writeStatus },
        );
      if (path.endsWith("/join"))
        return Response.json({ repoName: `demo--${agent}-2` }, { status: 201 });
      if (path.endsWith("/claim")) return Response.json(controls.claim, { status: 201 });
      return Response.json({ fixture: true, sha: head }, { status: 201 });
    },
  });
  const handler = createMcpHandler({ core, publicOrigin });
  async function rpc(method: string, params: unknown, agent = "builder") {
    const response = await handler(
      new Request(`${publicOrigin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(agent)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as {
      result: {
        isError?: boolean;
        content: { text: string }[];
        tools?: { name: string; description: string }[];
      };
    };
  }
  const call = (name: string, args: unknown = { project: "demo" }, agent = "builder") =>
    rpc("tools/call", { name, arguments: args }, agent);
  const submit = (agent = "builder") =>
    call(
      "submit_work",
      {
        project: "demo",
        packet: "FH-race",
        files: [{ path: "src/race.ts", content: "fixture" }],
        message: "fixture race commit",
      },
      agent,
    );
  return { state, controls, calls, call, submit, rpc };
}

const outbound = vi.fn(async () => {
  throw new Error("Offline race fixtures block outbound fetch.");
});
beforeAll(() => {
  vi.stubGlobal("fetch", outbound);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(outbound).not.toHaveBeenCalled();
});

describe("FH-054 offline workerd against fixed FH-052/053 fixtures", () => {
  it("shows default/explicit packet modes, caller standings and unchanged authoritative resume hints", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const { state, controls, call, calls } = fixture();
    const own = race();
    own.entrants[1]!.firstPushAt = at;
    own.entrants[2]!.reviewRequestedAt = at;
    const foreign = { ...race("FH-foreign"), entrants: [entrant("other")] };
    state.races = [own, foreign];
    for (const next of [
      "push",
      "request_review",
      "wait_for_checks",
      "fix_checks",
      "address_return",
      "wait_for_owner",
      "done",
    ]) {
      controls.work = [work(next)];
      for (const tool of ["get_context", "status"]) {
        const { result } = await call(tool);
        expect(result.isError).toBeUndefined();
        const context = JSON.parse(result.content[0]!.text);
        expect(context.packets).toEqual([
          { id: "FH-standard", title: "Legacy fixture", mode: "standard" },
          { id: "FH-race", mode: "race" },
        ]);
        expect(context.races).toEqual([own, foreign]);
        expect(context.myRaces).toEqual([own]);
        expect(context.myWork).toEqual(controls.work);
        expect(result.content[1]!.text).toBe(
          `FH-race on demo--builder-1 → next: ${next} — Core fixture hint for ${next}.`,
        );
        expect(result.content[2]!.text).toContain("builder on demo--builder-1: Claimed");
        expect(result.content[2]!.text).toContain("second on demo--second-1: First push");
        expect(result.content[2]!.text).toContain("third on demo--third-1: Review requested");
        expect(result.content[2]!.text).not.toContain("other");
      }
    }
    expect(
      calls.every(
        (entry, index) =>
          entry.agent === "builder" &&
          entry.method === "GET" &&
          entry.path === (index % 2 ? "/projects/demo/me" : "/projects/demo/state"),
      ),
    ).toBe(true);
  });

  it("keeps finished/closed races visible with places, string ledger id and photo-finish evidence", async () => {
    const { state, controls, call } = fixture();
    const finished = race();
    Object.assign(finished, {
      status: "finished",
      finishedAt: at,
      winner: "second",
      ledgerEntryId: "ledger-fixture-id",
    });
    Object.assign(finished.entrants[0]!, {
      approvedAt: at,
      place: 2,
      closedAt: at,
      closedBy: "race-finished",
      promoteRejected: { at, expected: head, found: "b".repeat(40) },
    });
    Object.assign(finished.entrants[1]!, {
      promotedAt: at,
      place: 1,
      closedAt: at,
      closedBy: "race-finished",
    });
    Object.assign(finished.entrants[2]!, {
      receiptPassedAt: at,
      place: 3,
      closedAt: at,
      closedBy: "release",
    });
    state.races = [finished];
    controls.work = [];
    for (const tool of ["get_context", "status"]) {
      const { result } = await call(tool);
      expect(JSON.parse(result.content[0]!.text).myRaces).toEqual([finished]);
      expect(JSON.parse(result.content[0]!.text).myWork).toEqual([]);
      const line = result.content[1]!.text;
      for (const text of [
        "race finished",
        "winner second",
        "ledger ledger-fixture-id",
        "Approved",
        "Promoted",
        "Checks passed",
        "place 1",
        "place 2",
        "place 3",
        "closed by release",
        "promote rejected",
        `expected ${head}`,
        `found ${"b".repeat(40)}`,
      ])
        expect(line).toContain(text);
    }
  });

  it("forwards each entrant's claim and own fork without inventing race authority", async () => {
    const { controls, call, calls, rpc } = fixture();
    for (const agent of agents) {
      controls.claim = { packet: "FH-race", ...entrant(agent) };
      const { result } = await call(
        "claim",
        { project: "demo", packet: "FH-race", repoName: `demo--${agent}-1` },
        agent,
      );
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual(controls.claim);
    }
    expect(calls).toEqual(
      agents.map((agent) => ({
        path: "/projects/demo/packets/FH-race/claim",
        method: "POST",
        agent,
        body: { repoName: `demo--${agent}-1` },
      })),
    );
    await call("claim", { project: "demo", packet: "FH-race" });
    expect(calls.at(-1)!.body).toEqual({});
    // Core owns cap, repeat/closed entry, finished race, foreign fork and cross-packet conflict refusals.
    for (const status of [409, 409, 409, 409, 403, 409]) {
      controls.writeStatus = status;
      const count = calls.length;
      const { result } = await call("claim", {
        project: "demo",
        packet: "FH-race",
        repoName: "demo--builder-1",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe(
        status === 409
          ? "Core conflict; refresh status before retrying."
          : "Core request refused (403).",
      );
      expect(calls).toHaveLength(count + 1);
    }
    const tools = (await rpc("tools/list", {})).result.tools!;
    expect(tools.find((tool) => tool.name === "claim")!.description).toContain(
      "at most three distinct agents ever",
    );
  });

  it("commits to each caller's immutable entrant fork despite overlapping race paths and a later join", async () => {
    const { state, calls, submit, call } = fixture();
    // A stray standard binding must never override an explicit race binding.
    state.claims = [{ packet: "FH-race", agent: "builder", repoName: "demo--builder-old" }];
    await call("join", { project: "demo", agent: "builder" });
    for (const agent of agents) expect((await submit(agent)).result.isError).toBeUndefined();
    const commits = calls.filter((entry) => entry.path.endsWith("/commit"));
    expect(commits).toEqual(
      agents.map((agent) => ({
        path: `/projects/demo/forks/demo--${agent}-1/commit`,
        method: "POST",
        agent,
        body: {
          packet: "FH-race",
          files: [{ path: "src/race.ts", content: "fixture" }],
          message: "fixture race commit",
        },
      })),
    );
    const review = await call("request_review", {
      project: "demo",
      packet: "FH-race",
      repoName: "demo--builder-1",
      sha: head,
    });
    expect(review.result.isError).toBeUndefined();
    expect(calls.at(-1)).toEqual({
      path: "/projects/demo/reviews",
      method: "POST",
      agent: "builder",
      body: { packet: "FH-race", repoName: "demo--builder-1", sha: head },
    });
  });

  it("refuses missing, closed, foreign, duplicate and finished entrant bindings without commit or standard fallback", async () => {
    for (const mutate of [
      (entry: RaceState) => {
        entry.entrants = [];
      },
      (entry: RaceState) => {
        entry.entrants = [entrant("second")];
      },
      (entry: RaceState) => {
        entry.entrants = [entrant("builder"), entrant("builder")];
      },
      (entry: RaceState) => {
        entry.entrants[0]!.closedAt = at;
        entry.entrants[0]!.closedBy = "release";
      },
      (entry: RaceState) => {
        entry.entrants[0]!.closedAt = at;
        entry.entrants[0]!.closedBy = "owner";
      },
      (entry: RaceState) => {
        entry.status = "finished";
      },
    ]) {
      const { state, submit, calls } = fixture();
      const entry = race();
      mutate(entry);
      state.races = [entry];
      state.claims = [{ packet: "FH-race", agent: "builder", repoName: "demo--builder-old" }];
      expect((await submit()).result.isError).toBe(true);
      expect(calls.map((call) => call.path)).toEqual(["/projects/demo/state"]);
    }
    const { state, submit, calls } = fixture();
    state.races = [];
    expect((await submit()).result.isError).toBe(true);
    state.races = [race(), race()];
    expect((await submit()).result.isError).toBe(true);
    state.races = [race()];
    state.packets = [{ id: "FH-race", mode: "standard" }];
    expect((await submit()).result.isError).toBe(true);
    state.packets = [
      { id: "FH-race", mode: "race" },
      { id: "FH-race", mode: "race" },
    ];
    expect((await submit()).result.isError).toBe(true);
    expect(calls.every((entry) => entry.path.endsWith("/state"))).toBe(true);
  });

  it("handles legacy state and nonparticipants while rejecting malformed race contracts", async () => {
    const { state, call, controls, submit } = fixture();
    state.races = [{ ...race(), entrants: [entrant("other")] }];
    controls.work = [];
    expect(JSON.parse((await call("status")).result.content[0]!.text).myRaces).toEqual([]);
    delete state.races;
    state.packets = [{ id: "FH-standard" }];
    expect((await call("status")).result.isError).toBeUndefined();
    for (const malformed of [
      null,
      [{ ...race(), ledgerEntryId: 7 }],
      [{ ...race(), entrants: [...race().entrants, entrant("fourth")] }],
      [{ ...race(), entrants: [{ ...entrant("builder"), closedAt: undefined }] }],
      [{ ...race(), entrants: [{ ...entrant("builder"), repoName: "../canonical" }] }],
    ]) {
      state.races = malformed;
      expect((await call("status")).result.isError).toBe(true);
      expect((await submit()).result.isError).toBe(true);
    }
  });
});
