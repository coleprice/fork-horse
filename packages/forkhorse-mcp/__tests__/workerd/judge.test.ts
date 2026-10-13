import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureDiffPath, judgeDetail, judgeDiff, judgeFixture } from "../judge-fixture";

const outbound = vi.fn(async () => {
  throw new Error("Offline judge fixtures block outbound fetch.");
});
beforeAll(() => {
  vi.stubGlobal("fetch", outbound);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(outbound).not.toHaveBeenCalled();
});
const advice = {
  project: "demo",
  packet: "FH-judge",
  ranking: ["second", "builder"],
  rationale:
    "Checks pass. Compare diff size, elapsed time and reported tokens; these token figures are agent reports.",
};

describe("FH-063b offline workerd with fixed FH-063 judge contract fixtures", () => {
  it("lists only caller-assigned judge races, preserving advice, reported usage and history", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const { state, call, calls } = judgeFixture();
    state.races[0]!.verdict = {
      ranking: ["second", "builder"],
      rationale: "Advice fixture",
      at: "2026-01-01T00:01:00.000Z",
    };
    for (const status of ["open", "finished"]) {
      state.races[0]!.status = status;
      const reply = await call("list_judge_races", { project: "demo" });
      expect(reply.status).toBe(200);
      expect(reply.cache).toBe("no-store");
      expect(reply.body!.result.isError).toBeUndefined();
      expect(JSON.parse(reply.body!.result.content[0]!.text)).toEqual({ races: [state.races[0]] });
    }
    expect(
      JSON.parse(
        (await call("list_judge_races", { project: "demo" }, "builder")).body!.result.content[0]!
          .text,
      ),
    ).toEqual({ races: [] });
    expect(
      calls.every((entry) => entry.path === "/projects/demo/state" && entry.method === "GET"),
    ).toBe(true);
    // Existing caller-race context also keeps the new judge/advice fields.
    const context = await call("get_context", { project: "demo" }, "builder");
    expect(JSON.parse(context.body!.result.content[0]!.text).myRaces).toEqual(state.races);
  });

  it("reads assigned entrants' detail and diffs with the caller bearer and exact encoded path", async () => {
    const { call, calls } = judgeFixture();
    const detail = await call("get_review", { project: "demo", review: "review-builder" });
    const diff = await call("get_review_diff", {
      project: "demo",
      review: "review-second",
      path: fixtureDiffPath,
    });
    expect(JSON.parse(detail.body!.result.content[0]!.text)).toEqual(judgeDetail);
    expect(JSON.parse(diff.body!.result.content[0]!.text)).toEqual(judgeDiff);
    expect(calls).toEqual([
      {
        path: "/projects/demo/reviews/review-builder",
        query: "",
        method: "GET",
        agent: "judge",
        body: null,
        redirect: "manual",
      },
      {
        path: "/projects/demo/reviews/review-second/diff",
        query: "?path=src%2Fchanged+file.ts",
        method: "GET",
        agent: "judge",
        body: null,
        redirect: "manual",
      },
    ]);
    expect(detail.cache).toBe("no-store");
    expect(diff.cache).toBe("no-store");
  });

  it("handles legacy unassigned races and refuses malformed supplied advice", async () => {
    const { state, call } = judgeFixture();
    Object.assign(state.races[0]!, { judge: undefined });
    Object.assign(state.races[1]!, { judge: null });
    expect(
      JSON.parse(
        (await call("list_judge_races", { project: "demo" })).body!.result.content[0]!.text,
      ),
    ).toEqual({ races: [] });
    for (const malformed of [
      { judge: "invalid/agent", verdict: null },
      {
        judge: "judge",
        verdict: {
          ranking: ["builder", "builder"],
          rationale: "Invalid duplicate fixture",
          at: "2026-01-01T00:01:00Z",
        },
      },
      {
        judge: "judge",
        verdict: { ranking: ["builder", "second"], rationale: "", at: "2026-01-01T00:01:00Z" },
      },
    ]) {
      Object.assign(state.races[0]!, malformed);
      expect((await call("list_judge_races", { project: "demo" })).body!.result.isError).toBe(true);
    }
  });

  it("propagates scoped core refusals without broadening cross-agent reads", async () => {
    const { call, calls } = judgeFixture();
    for (const name of ["get_review", "get_review_diff"]) {
      const args = {
        project: "demo",
        review: "review-foreign",
        ...(name === "get_review_diff" ? { path: fixtureDiffPath } : {}),
      };
      expect((await call(name, args)).body!.result.content[0]!.text).toBe(
        "Core request refused (403).",
      );
      const ownRace = { ...args, review: "review-builder" };
      expect((await call(name, ownRace, "outsider")).body!.result.isError).toBe(true);
      expect((await call(name, ownRace, "other-judge")).body!.result.isError).toBe(true);
      expect((await call(name, ownRace, "builder")).body!.result.isError).toBeUndefined();
    }
    expect(calls).toHaveLength(8);
  });

  it("submits and replaces advisory ranking with exact body; finish refuses without retry", async () => {
    const { state, controls, call, calls } = judgeFixture();
    const first = await call("submit_verdict", advice);
    expect(first.body!.result.isError).toBeUndefined();
    expect(JSON.parse(first.body!.result.content[0]!.text)).toEqual({
      verdict: { ranking: advice.ranking, rationale: advice.rationale, at: controls.adviceAt },
    });
    expect(calls[0]).toEqual({
      path: "/projects/demo/races/FH-judge/verdict",
      query: "",
      method: "POST",
      agent: "judge",
      body: { ranking: advice.ranking, rationale: advice.rationale },
      redirect: "manual",
    });
    controls.adviceAt = "2026-01-01T00:02:00.000Z";
    const replacement = {
      ...advice,
      ranking: ["builder", "second"],
      rationale: "New advice\nLiteral <script>fixture</script>, not executable UI.",
    };
    expect((await call("submit_verdict", replacement)).body!.result.isError).toBeUndefined();
    const saved = structuredClone(state.races[0]!.verdict);
    expect(saved).toEqual({
      ranking: replacement.ranking,
      rationale: replacement.rationale,
      at: controls.adviceAt,
    });
    state.races[0]!.status = "finished";
    const finished = await call("submit_verdict", advice);
    expect(finished.body!.result.content[0]!.text).toBe(
      "Core conflict; refresh status before retrying.",
    );
    expect(state.races[0]!.verdict).toEqual(saved);
    expect(calls).toHaveLength(3);
    expect(calls.every((entry) => entry.path.endsWith("/verdict"))).toBe(true);
  });

  it("leaves assignment and exact entrant permutation enforcement to core", async () => {
    const { state, call, calls } = judgeFixture();
    for (const actor of ["builder", "second", "other-judge", "outsider"]) {
      expect((await call("submit_verdict", advice, actor)).body!.result.content[0]!.text).toBe(
        "Core request refused (403).",
      );
    }
    for (const ranking of [[], ["builder"], ["builder", "unknown"]])
      expect(
        (await call("submit_verdict", { ...advice, ranking })).body!.result.content[0]!.text,
      ).toBe("Core request refused (400).");
    expect(state.races[0]!.verdict).toBeNull();
    expect(
      (await call("claim", { project: "demo", packet: "FH-judge", repoName: "demo--judge-1" }))
        .body!.result.content[0]!.text,
    ).toContain("Core conflict");
    expect(calls).toHaveLength(8);
    expect(calls.some((entry) => /join|promote|approve/.test(entry.path))).toBe(false);
  });

  it("rejects invalid inputs, cross-project calls and owner credentials before execution", async () => {
    const { call, calls } = judgeFixture();
    for (const bad of [
      { ...advice, ranking: ["builder", "builder"] },
      { ...advice, ranking: ["builder", "second", "third", "fourth"] },
      { ...advice, rationale: "" },
      { ...advice, rationale: "x".repeat(2001) },
      { ...advice, ranking: ["invalid/agent"] },
      { ...advice, project: "foreign" },
      { ...advice, judge: "judge" },
      { ...advice, token: "not-accepted" },
    ])
      expect((await call("submit_verdict", bad)).body!.result.isError).toBe(true);
    for (const review of ["../promote", "review/receipt", "", "x".repeat(129)])
      expect((await call("get_review", { project: "demo", review })).body!.result.isError).toBe(
        true,
      );
    for (const path of ["../secret", "/secret", ".git/config", "src\\x", "src//x", ""])
      expect(
        (await call("get_review_diff", { project: "demo", review: "review-builder", path })).body!
          .result.isError,
      ).toBe(true);
    expect((await call("list_judge_races", { project: "foreign" })).body!.result.isError).toBe(
      true,
    );
    for (const actor of ["owner", "invalid"])
      expect((await call("submit_verdict", advice, actor)).status).toBe(401);
    expect(calls).toHaveLength(0);
    for (const rationale of ["x", "x".repeat(2000)])
      expect(
        (await call("submit_verdict", { ...advice, rationale })).body!.result.isError,
      ).toBeUndefined();
  });

  it("preserves truncated/binary evidence and redacts refusal, redirects, provider errors and oversized responses", async () => {
    const { controls, call, calls } = judgeFixture();
    controls.diff = { ...judgeDiff, binary: true, patch: "", truncated: true };
    expect(
      JSON.parse(
        (
          await call("get_review_diff", {
            project: "demo",
            review: "review-builder",
            path: fixtureDiffPath,
          })
        ).body!.result.content[0]!.text,
      ),
    ).toEqual(controls.diff);
    for (const status of [400, 403, 404, 409, 429, 500, 302]) {
      controls.status = status;
      const count = calls.length;
      const reply = await call("submit_verdict", advice);
      expect(reply.body!.result.isError).toBe(true);
      expect(JSON.stringify(reply.body)).not.toContain("fixture-private-provider-detail");
      expect(reply.cache).toBe("no-store");
      expect(calls).toHaveLength(count + 1);
    }
    controls.status = 0;
    controls.throws = true;
    expect(
      (await call("get_review", { project: "demo", review: "review-builder" })).body!.result
        .isError,
    ).toBe(true);
    controls.throws = false;
    controls.oversized = true;
    expect(
      (await call("get_review", { project: "demo", review: "review-builder" })).body!.result
        .content[0]!.text,
    ).toContain("Payload exceeds");
  });

  it("advertises read tools and non-idempotent advice submission without owner tools", async () => {
    const { rpc } = judgeFixture();
    const tools = (await rpc("tools/list", {})).body!.result.tools!;
    for (const name of ["list_judge_races", "get_review", "get_review_diff"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    }
    expect(tools.find((tool) => tool.name === "submit_verdict")!.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(tools.some((tool) => /approve|promote|enroll/.test(tool.name))).toBe(false);
  });
});
