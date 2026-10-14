import { createCoreClient } from "../src/core";
import { createMcpHandler } from "../src/mcp";

const origin = "https://judge.fixture.idiot.tax";
const at = "2026-01-01T00:00:00.000Z";
const sha = "a".repeat(40);
export const fixtureDiffPath = "src/changed file.ts";
const entrants = ["builder", "second"].map((agent) => ({
  agent,
  repoName: `demo--${agent}-1`,
  claimedAt: at,
  firstPushAt: at,
  reviewRequestedAt: at,
  receiptPassedAt: at,
  approvedAt: null,
  promotedAt: null,
  place: null,
  closedAt: null,
  closedBy: null,
  promoteRejected: null,
  usage: {
    reported:
      agent === "builder" ? { inputTokens: 120, outputTokens: 40, source: "reported", at } : null,
    metered: null,
  },
}));
export const judgeState = {
  fixture: "FH-063 fixed-contract fixture; no live core, authorization or provider acceptance",
  claims: [],
  packets: [
    { id: "FH-judge", mode: "race" },
    { id: "FH-other", mode: "race" },
  ],
  races: ["FH-judge", "FH-other"].map((packet) => ({
    packet,
    status: "open",
    finishedAt: null,
    winner: null,
    ledgerEntryId: null,
    places: [],
    entrants,
    judge: packet === "FH-judge" ? "judge" : "other-judge",
    verdict: null as null | { ranking: string[]; rationale: string; at: string },
  })),
};
export const judgeDetail = {
  review: {
    id: "review-builder",
    packet: "FH-judge",
    agent: "builder",
    repoName: "demo--builder-1",
    sha,
    base: "b".repeat(40),
    createdAt: at,
    stale: false,
    promoted: false,
    returned: null,
    approval: null,
    receipt: { status: "passed", digest: "fixture-digest", durationMs: 40, checks: [] },
    usageAtReview: {
      reported: { inputTokens: 120, outputTokens: 40, source: "reported", at },
      metered: null,
    },
  },
  packet: {
    id: "FH-judge",
    title: "Judge fixture",
    goal: "Offline contract validation",
    paths: ["src/"],
    acceptance: ["Workerd fixture"],
  },
  changes: {
    base: "b".repeat(40),
    head: sha,
    fileCount: 1,
    truncated: false,
    files: [{ path: fixtureDiffPath, status: "modified" }],
  },
  commits: [],
  commitsTruncated: false,
  promotion: null,
  blockers: [],
};
export const judgeDiff = {
  path: fixtureDiffPath,
  status: "modified",
  binary: false,
  truncated: false,
  patch:
    "--- a/src/changed file.ts\n+++ b/src/changed file.ts\n@@ -1 +1 @@\n-fixture before\n+fixture after\n",
};

/** Fake core policy only; core must enforce the confirmed full retained roster independently. */
export function judgeFixture() {
  const state = structuredClone(judgeState);
  const tokens = new Map(
    ["judge", "builder", "second", "other-judge", "outsider"].map((agent) => [
      agent,
      crypto.randomUUID(),
    ]),
  );
  const calls: {
    path: string;
    query: string;
    method: string;
    agent: string | undefined;
    body: unknown;
    redirect: RequestRedirect;
  }[] = [];
  const controls = {
    status: 0,
    throws: false,
    oversized: false,
    detail: structuredClone(judgeDetail) as unknown,
    diff: structuredClone(judgeDiff) as unknown,
    adviceAt: "2026-01-01T00:01:00.000Z",
  };
  const core = createCoreClient({
    authenticate: async (token) => {
      const agent = [...tokens].find(([, value]) => value === token)?.[0];
      return agent ? { project: "demo", agent } : null;
    },
    enrollAgent: async () => {
      throw new Error("No fixture enrollment.");
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const agent = [...tokens].find(
        ([, value]) => request.headers.get("authorization") === `Bearer ${value}`,
      )?.[0];
      const data = request.method === "POST" ? await request.json() : null;
      calls.push({
        path: url.pathname,
        query: url.search,
        method: request.method,
        agent,
        body: data,
        redirect: request.redirect,
      });
      if (controls.throws) throw new Error("fixture-private-provider-detail");
      if (controls.status)
        return Response.json(
          { error: "fixture-private-provider-detail" },
          { status: controls.status },
        );
      if (controls.oversized) return Response.json({ data: "x".repeat(1024 * 1024) });
      if (url.pathname.endsWith("/state")) return Response.json(state);
      if (url.pathname.endsWith("/me")) return Response.json({ work: [] });
      const detail =
        /^\/projects\/demo\/reviews\/(review-builder|review-second|review-foreign)(\/diff)?$/.exec(
          url.pathname,
        );
      if (detail) {
        const owner = detail[1] === "review-second" ? "second" : "builder";
        const packet = detail[1] === "review-foreign" ? "FH-other" : "FH-judge";
        const race = state.races.find((candidate) => candidate.packet === packet)!;
        if (agent !== owner && race.judge !== agent) return Response.json({}, { status: 403 });
        if (detail[2]) {
          if (url.searchParams.get("path") !== fixtureDiffPath)
            return Response.json({}, { status: 404 });
          return Response.json(controls.diff);
        }
        return Response.json(controls.detail);
      }
      const advice = /^\/projects\/demo\/races\/([^/]+)\/verdict$/.exec(url.pathname);
      if (advice) {
        const race = state.races.find((candidate) => candidate.packet === advice[1]);
        if (!race) return Response.json({}, { status: 404 });
        if (race.judge !== agent) return Response.json({}, { status: 403 });
        if (race.status === "finished") return Response.json({}, { status: 409 });
        const input = data as { ranking: string[]; rationale: string };
        const names = race.entrants.map((entrant) => entrant.agent);
        if (
          input.ranking.length !== names.length ||
          new Set(input.ranking).size !== names.length ||
          input.ranking.some((name) => !names.includes(name))
        )
          return Response.json({}, { status: 400 });
        race.verdict = { ...input, at: controls.adviceAt };
        return Response.json({ verdict: race.verdict });
      }
      if (url.pathname.endsWith("/claim")) return Response.json({}, { status: 409 });
      return Response.json({}, { status: 404 });
    },
  });
  const handler = createMcpHandler({ core, publicOrigin: origin });
  async function rpc(method: string, params: unknown, actor = "judge") {
    const response = await handler(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(actor) ?? "invalid-fixture"}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body:
        response.status === 200
          ? ((await response.json()) as {
              result: {
                isError?: boolean;
                content: { text: string }[];
                tools?: {
                  name: string;
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
  const call = (name: string, args: unknown, actor = "judge") =>
    rpc("tools/call", { name, arguments: args }, actor);
  return { state, calls, controls, rpc, call };
}
