import { usageScenarios, usageFixtureState, usageFixtureDetail } from "./usage-fixtures.ts";
import { collisionScenarios, collisionFixtureState } from "./collision-fixtures.ts";
import { readFileSync } from "node:fs";
import { raceScenarios, raceFixtureState } from "./race-fixtures.ts";
import { forkScenarios, forkFixtureState } from "./fork-graph-fixtures.ts";
import { needsScenarios, needsFixtureState } from "./needs-you-fixtures.ts";
import {
  reviewScenarios,
  reviewFixtureState,
  reviewFixtureDetail,
  reviewFixtureDiff,
} from "./review-fixtures.ts";
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
    if (url.pathname === "/__fixtures/owner-bundle" && request.method === "GET") {
      const project = forkScenarios.includes(url.searchParams.get("scenario") ?? "")
        ? url.searchParams.get("scenario")!
        : "fork-hero";
      try {
        const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
        const config = JSON.stringify({ projects: [{ id: project, label: project }] });
        response.setHeader("Content-Type", "text/html");
        response.setHeader("Cache-Control", "no-store");
        response.end(
          html.replace(
            "</body>",
            `<script id="dashboard-config" type="application/json">${config}</script><script type="module" src="/test/owner-theme-fixture.ts"></script></body>`,
          ),
        );
      } catch {
        response.statusCode = 503;
        response.end("Build the owner dashboard first.");
      }
      return;
    }
    if (/^\/app\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname) && request.method === "GET") {
      try {
        response.setHeader(
          "Content-Type",
          url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        );
        response.end(
          readFileSync(
            new URL(`../dist/assets/${url.pathname.split("/").at(-1)}`, import.meta.url),
          ),
        );
      } catch {
        response.statusCode = 404;
        response.end("Fixture build asset missing.");
      }
      return;
    }
    if (url.pathname === "/__fixtures/gatekeeper-bundle" && request.method === "GET") {
      try {
        response.setHeader("Content-Type", "text/html");
        response.setHeader("Cache-Control", "no-store");
        response.end(
          readFileSync(
            new URL("../../forkhorse-gatekeeper/dist/sidebar.html", import.meta.url),
            "utf8",
          ),
        );
      } catch {
        response.statusCode = 503;
        response.end("Build the gatekeeper sidebar assets first.");
      }
      return;
    }
    // Test harness reset; this middleware is excluded from production builds.
    if (url.pathname === "/__fixtures/reset" && request.method === "POST") {
      states.clear();
      response.statusCode = 204;
      response.end();
      return;
    }
    if (url.pathname === "/__fixtures/fork-live-push" && request.method === "POST") {
      const state = states.get("fork-live");
      if (state) {
        const previous = state.activity.find((a) => a.repoName === "fixture-fork-3")!;
        const at = new Date().toISOString();
        state.activity.push({
          ...previous,
          sequence: state.activity.length + 100,
          recordedAt: at,
          eventTimestamp: at,
        });
      }
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
    const usageRoute = /^\/projects\/([^/]+)\/(state|activity|reviews\/([^/]+))$/.exec(url.pathname);
    if (usageRoute && usageScenarios.includes(usageRoute[1])) {
      if (!states.has(usageRoute[1])) states.set(usageRoute[1], usageFixtureState(usageRoute[1]));
      const state = states.get(usageRoute[1])!;
      if (usageRoute[2] === "state") send(state);
      else if (usageRoute[2] === "activity") send({ activity: [], nextAfter: 0 });
      else if (!state.reviews.some((r) => r.id === usageRoute[3])) send({ error: "Fixture review not found" }, 404);
      else send(usageFixtureDetail(state, usageRoute[3]));
      return;
    }
    const collisionRoute = /^\/projects\/([^/]+)\/(state|activity|reviews\/([^/]+)|blockers\/([^/]+)\/resolve)$/.exec(url.pathname);
    if (collisionRoute && collisionScenarios.includes(collisionRoute[1])) {
      const id = collisionRoute[1];
      if (!states.has(id)) states.set(id, collisionFixtureState(id));
      const state = states.get(id)!;
      if (collisionRoute[2] === "state") send(state);
      else if (collisionRoute[2] === "activity") send({ activity: [], nextAfter: 0 });
      else if (collisionRoute[3]) {
        const review = state.reviews.find((r) => r.id === collisionRoute[3]);
        if (!review) send({ error: "Fixture review missing" }, 404);
        else send({ ...reviewFixtureDetail({ ...state, reviews: [review] }), packet: state.packets.find((p) => p.id === review.packet)! });
      } else if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const blocker = state.blockers.find((b) => b.id === collisionRoute[4]);
          if (id === "collision-missing" || !blocker) {
            state.blockers = state.blockers.filter((b) => b.id !== collisionRoute[4]);
            send({ error: "Fixture collision missing" }, 404);
            return;
          }
          if (id === "collision-error") { send({ error: "Fixture raw error must stay hidden" }, 503); return; }
          try {
            const { reason } = JSON.parse(body);
            if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 200) throw new Error("reason");
            blocker.resolved ??= { at: new Date().toISOString(),
              by: id === "collision-race-release" ? "release" : id === "collision-race-promote" ? "promote" : "owner",
              ...(id.startsWith("collision-race") ? {} : { reason }) };
            send({ blocker });
          } catch { send({ error: "Invalid fixture reason" }, 400); }
        });
      } else send({ error: "Fixture method unavailable" }, 405);
      return;
    }
    const raceRoute = /^\/projects\/([^/]+)\/(state|activity|reviews\/([^/]+))$/.exec(url.pathname);
    if (raceRoute && raceScenarios.includes(raceRoute[1])) {
      const id = raceRoute[1];
      const state = raceFixtureState(id);
      if (raceRoute[2] === "state") {
        if (id === "race-error") send({ error: "Offline race error fixture" }, 503);
        else if (id === "race-loading") setTimeout(() => send(state), 8000);
        else send(state);
      } else if (raceRoute[2] === "activity")
        send({ activity: [], nextAfter: state.activity.at(-1)?.sequence ?? 0 });
      else {
        const review = state.reviews.find((candidate) => candidate.id === raceRoute[3]);
        if (!review) send({ error: "Fixture review not found" }, 404);
        else
          send({
            ...reviewFixtureDetail({ ...state, reviews: [review] }),
            packet: state.packets[0],
          });
      }
      return;
    }
    const forkRoute = /^\/projects\/([^/]+)\/(state|activity)$/.exec(url.pathname);
    if (forkRoute && forkScenarios.includes(forkRoute[1])) {
      if (!states.has(forkRoute[1])) states.set(forkRoute[1], forkFixtureState(forkRoute[1]));
      const state = states.get(forkRoute[1])!;
      send(forkRoute[2] === "state" ? state : { activity: [], nextAfter: 0 });
      return;
    }
    const needsRoute = /^\/projects\/([^/]+)\/(state|activity|reviews\/([^/]+))$/.exec(
      url.pathname,
    );
    if (needsRoute && needsScenarios.includes(needsRoute[1])) {
      const id = needsRoute[1];
      const state = needsFixtureState(id);
      if (needsRoute[2] === "state") send(state);
      else if (needsRoute[2] === "activity") send({ activity: [], nextAfter: 0 });
      else {
        const review = state.reviews.find((r) => r.id === needsRoute[3]);
        if (!review) send({ error: "Fixture review not found." }, 404);
        else
          send({
            ...reviewFixtureDetail({ ...state, reviews: [review] }),
            packet: state.packets.find((p) => p.id === review.packet)!,
          });
      }
      return;
    }
    const detailRoute =
      /^\/projects\/([^/]+)\/(state|activity|reviews\/([^/]+)(?:\/(diff|return|approve|promote|receipt))?)$/.exec(
        url.pathname,
      );
    if (detailRoute && reviewScenarios.includes(detailRoute[1])) {
      const id = detailRoute[1];
      if (!states.has(id)) states.set(id, reviewFixtureState(id));
      const state = states.get(id)!;
      const review = state.reviews[0];
      const route = detailRoute[2];
      const action = detailRoute[4];
      if (route === "state") {
        send(state);
        return;
      }
      if (route === "activity") {
        send({ activity: state.activity, nextAfter: state.activity.at(-1)?.sequence ?? 0 });
        return;
      }
      if (detailRoute[3] !== review.id) {
        send({ error: "Review not found." }, 404);
        return;
      }
      if (!action) {
        if (id === "review-error") send({ error: "Fixture detail unavailable" }, 503);
        else if (id === "review-not-found") send({ error: "Review not found." }, 404);
        else if (id === "review-loading") setTimeout(() => send(reviewFixtureDetail(state)), 8000);
        else send(reviewFixtureDetail(state));
        return;
      }
      if (action === "diff") {
        const path = url.searchParams.get("path") ?? "";
        if (
          path === "missing.txt" ||
          !reviewFixtureDetail(state).changes.files.some((f) => f.path === path)
        )
          send({ error: "Path not in changes" }, 404);
        else send(reviewFixtureDiff(path));
        return;
      }
      if (action === "receipt") {
        send(fixtureOwnerReceipt(review));
        return;
      }
      if (request.method !== "POST") {
        send({ error: "Method not allowed" }, 405);
        return;
      }
      if (action === "return") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (id === "review-conflict" || review.promoted) {
            // Synthetic other-tab promotion becomes authoritative before the conflict response.
            review.promoted = true;
            review.approval = { sha: review.sha, receiptDigest: review.receiptDigest };
            state.ledger = reviewFixtureState("review-promoted").ledger;
            send({ error: "Review promoted." }, 409);
            return;
          }
          try {
            const { reason } = JSON.parse(body);
            if (typeof reason !== "string" || reason.length < 1 || reason.length > 2000)
              throw new Error("Invalid reason");
            review.returned = { reason, at: new Date().toISOString() };
            send({ review });
          } catch {
            send({ error: "Invalid reason" }, 400);
          }
        });
        return;
      }
      if (review.returned) {
        send({ error: "Review was returned to the agent." }, 409);
        return;
      }
      if (action === "approve") {
        review.approval = { sha: review.sha, receiptDigest: review.receiptDigest };
        send({ review });
        return;
      }
      review.promoted = true;
      send({ sha: review.sha });
      return;
    }
    const match =
      /^\/projects\/(demo|quiet|large|first|partial|truncated|superseded|paused|deleted|error|loading|receipts|advisory|recheck|rerun-failed|gating-recheck|history-required|history-advisory)\/(state|activity|settings|reviews\/([^/]+)\/(approve|promote|receipt))$/.exec(
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
