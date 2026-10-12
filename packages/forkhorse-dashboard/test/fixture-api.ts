import type { IncomingMessage, ServerResponse } from "node:http";
import { fixtureOwnerReceipt, fixtureReceipt, fixtureState } from "./fixtures.ts";

export interface FixtureCall {
  method: string;
  path: string;
}

/** Loopback fixture API only; production build does not mount or bundle these routes. */
export function fixtureMiddleware(calls: FixtureCall[] = []) {
  const states = new Map<string, ReturnType<typeof fixtureState>>();
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://fixture.idiot.tax");
    // Test harness reset; this middleware is excluded from production builds.
    if (url.pathname === "/__fixtures/reset" && request.method === "POST") {
      states.clear();
      response.statusCode = 204;
      response.end();
      return;
    }
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
      /^\/projects\/(demo|quiet|large|first|partial|truncated|superseded|paused|deleted|error|loading|receipts|advisory|recheck|rerun-failed|gating-recheck)\/(state|activity|settings|reviews\/([^/]+)\/(approve|promote|receipt))$/.exec(
        url.pathname,
      );
    if (!match) {
      send({ error: "Fixture project or route not found." }, 404);
      return;
    }
    const id = match[1];
    if (!states.has(id)) states.set(id, fixtureState(id));
    const state = states.get(id)!;
    if (match[2] === "settings" && request.method === "PATCH") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const settings = JSON.parse(body);
          if (typeof settings.requireReceipt !== "boolean") throw new Error("invalid");
          state.project.settings = { requireReceipt: settings.requireReceipt };
          send({ settings: state.project.settings });
        } catch {
          send({ error: "Invalid fixture settings." }, 400);
        }
      });
      return;
    }
    if (match[2] === "state" && request.method === "GET") {
      if (match[1] === "error") {
        send({ error: "Fixture connection unavailable. Try again." }, 503);
        return;
      }
      if (match[1] === "loading") {
        setTimeout(() => send(state), 8000);
        return;
      }
      send(state);
      return;
    }
    if (match[2] === "activity" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const activity = state.activity.filter((entry) => entry.sequence > after);
      send({ activity, nextAfter: activity.at(-1)?.sequence ?? after });
      return;
    }
    const review = state.reviews.find((entry) => entry.id === match[3]);
    if (match[4] === "receipt" && request.method === "GET") {
      if (!review?.receipt?.digest) {
        send({ error: "Receipt not found." }, 404);
        return;
      }
      send(fixtureOwnerReceipt(review));
      return;
    }
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
    if (
      match[4] === "approve" &&
      state.project.settings?.requireReceipt &&
      (!review.receiptDigest || review.receipt?.status !== "passed")
    ) {
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
    if (state.project.settings?.requireReceipt) {
      review.receipt = fixtureReceipt("running", "before-promote");
      review.receiptDigest = null;
      setTimeout(
        () => {
          review.receipt = fixtureReceipt(
            id === "rerun-failed" ? "failed" : "passed",
            "before-promote",
          );
          review.receiptDigest = review.receipt.digest;
          if (id === "rerun-failed") {
            send({ error: "Checks failed before promote." }, 409);
            return;
          }
          review.promoted = true;
          send({ sha: review.sha });
        },
        id === "recheck" ? 8000 : 900,
      );
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
