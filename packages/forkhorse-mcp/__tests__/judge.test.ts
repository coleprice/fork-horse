import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureDiffPath, judgeDetail, judgeDiff, judgeFixture } from "./judge-fixture";
import expectedCapture from "./judge-capture.fixture.json";

describe("FH-063b labeled offline MCP capture", () => {
  it("captures judge tools through the real MCP facade with fixture data and no credentials", async () => {
    const { state, controls, call } = judgeFixture();
    const advice = {
      project: "demo",
      packet: "FH-judge",
      ranking: ["second", "builder"],
      rationale:
        "Receipts pass; compare diff size and elapsed time. Tokens are reported, not independently measured. This ranking is advice; the owner promotes.",
    };
    const captures = [];
    for (const [tool, args] of [
      ["list_judge_races", { project: "demo" }],
      ["get_review", { project: "demo", review: "review-builder" }],
      ["get_review_diff", { project: "demo", review: "review-builder", path: fixtureDiffPath }],
      ["submit_verdict", advice],
      ["list_judge_races", { project: "demo" }],
    ] as const) {
      const reply = await call(tool, args);
      expect(reply.status).toBe(200);
      expect(reply.body!.result.isError).toBeUndefined();
      captures.push({ tool, args, response: JSON.parse(reply.body!.result.content[0]!.text) });
    }
    expect(captures[1]!.response).toEqual(judgeDetail);
    expect(captures[2]!.response).toEqual(judgeDiff);
    expect(captures[3]!.response).toEqual({
      verdict: { ranking: advice.ranking, rationale: advice.rationale, at: controls.adviceAt },
    });
    expect(captures[4]!.response).toEqual({ races: [state.races[0]] });
    const captured = {
      fixture:
        "FH-063b offline fixed-contract MCP capture, not live authorization or deployment evidence",
      captures,
    };
    expect(captured).toEqual(expectedCapture);
    const destination = process.env.FH063_CAPTURE_PATH;
    if (destination) writeFileSync(destination, JSON.stringify(captured, null, 2) + "\n");
  });
});
