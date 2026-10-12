import { expect, it } from "vitest";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView, reviewQueue } from "../../forkhorse-dashboard/src/model.ts";

it("projects real wire review states and removes superseded stale rows under workerd", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
  const wire = fixtureState("superseded");
  expect(reviewQueue(stateView(wire))).toHaveLength(0);
  wire.reviews[0].promoted = false;
  const queue = reviewQueue(stateView(wire));
  expect(queue.map((review) => review.id)).toEqual(["review-1"]);
  wire.reviews[0].approval = { sha: wire.reviews[0].sha, receiptDigest: wire.reviews[0].receiptDigest };
  expect(reviewQueue(stateView(wire))[0].status).toBe("approved");
  wire.reviews[0].approval.receiptDigest = "9".repeat(64);
  expect(reviewQueue(stateView(wire))[0].status).toBe("stale");
});
