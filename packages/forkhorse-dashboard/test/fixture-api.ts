import type { IncomingMessage, ServerResponse } from "node:http";
import { fixtureActivity, fixtureState } from "./fixtures.ts";

export interface FixtureCall {
  method: string;
  path: string;
}

/** Loopback fixture API only; production build does not mount or bundle these routes. */
export function fixtureMiddleware(calls: FixtureCall[] = []) {
  const demo = fixtureState();
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://fixture.idiot.tax");
    if (!url.pathname.startsWith("/projects/")) {
      next();
      return;
    }
    calls.push({ method: request.method ?? "GET", path: url.pathname });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    function send(data: unknown, status = 200) {
      response.statusCode = status;
      response.end(JSON.stringify(data));
    }
    const match =
      /^\/projects\/(demo|quiet)\/(state|activity|reviews\/([^/]+)\/(approve|promote))$/.exec(
        url.pathname,
      );
    if (!match) {
      send({ error: "Fixture project or route not found." }, 404);
      return;
    }
    const state = match[1] === "demo" ? demo : fixtureState("quiet");
    if (match[2] === "state" && request.method === "GET") {
      send(state);
      return;
    }
    if (match[2] === "activity" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const activity =
        match[1] === "demo" ? fixtureActivity().filter((entry) => entry.sequence > after) : [];
      send({ activity, nextAfter: activity.at(-1)?.sequence ?? after });
      return;
    }
    const review = state.reviews.find((entry) => entry.id === match[3]);
    if (request.method !== "POST") {
      send({ error: "Fixture method not allowed." }, 405);
      return;
    }
    if (!review) {
      send({ error: "Fixture review not found." }, 404);
      return;
    }
    const fork = state.forks.find((entry) => entry.repoName === review.repoName);
    if (fork?.head !== review.sha) {
      send({ error: "Review is stale. Request a fresh review." }, 409);
      return;
    }
    if (!review.receiptDigest) {
      send({ error: "Receipt pending." }, 409);
      return;
    }
    if (match[4] === "approve") {
      review.approval = { sha: review.sha, receiptDigest: review.receiptDigest };
      send({ review });
      return;
    }
    if (!review.approval) {
      send({ error: "Owner approval required." }, 409);
      return;
    }
    review.promoted = true;
    state.ledger.push({
      id: "merge-1",
      review: review.id,
      repoName: state.project.repoName,
      ref: "refs/heads/main",
      before: review.base,
      after: review.sha,
      receiptDigest: review.receiptDigest,
      recordedAt: "2026-10-12T00:20:00.000Z",
    });
    send({ sha: review.sha });
  };
}
