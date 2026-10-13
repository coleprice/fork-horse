import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Claim, Packet, ReceiptSummary, Review, WorkItem } from "../src/workflow-types";
import { AFTER, BEFORE } from "./fixtures";
import { TestSupervisor } from "./worker";

const OWNER = "offline-fixture-owner-token";
const THIRD = "a".repeat(40);
const claimedAt = "2026-10-12T10:00:00.000Z";
function api(id: string, path: string, token: string, method = "GET", data?: unknown) {
  return worker.fetch(
    new Request(`https://api.idiot.tax/projects/${id}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    env,
  );
}
async function inside<T>(
  id: string,
  fn: (instance: TestSupervisor, storage: DurableObjectStorage) => Promise<T>,
) {
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
  return runInDurableObject(stub, async (instance, state) => {
    if (!(instance instanceof TestSupervisor))
      throw new Error("Expected offline fixture supervisor");
    return fn(instance, state.storage);
  });
}
function review(repoName: string, values: Partial<Review> = {}): Review {
  return {
    id: "review-current",
    packet: "resume",
    agent: "alpha",
    repoName,
    sha: AFTER,
    base: BEFORE,
    stale: false,
    promoted: false,
    returned: null,
    receiptDigest: null,
    receipt: null,
    approval: null,
    receiptGeneration: "private-execution-identity",
    createdAt: claimedAt,
    ...values,
  };
}
function receipt(status: ReceiptSummary["status"]): ReceiptSummary {
  return {
    status,
    trigger: "review-created",
    digest: null,
    startedAt: claimedAt,
    finishedAt: status === "running" ? null : claimedAt,
    durationMs: null,
    checks: [],
  };
}
async function setup(requireReceipt = true, head = AFTER, values?: Partial<Review>) {
  const id = `resume-${crypto.randomUUID().slice(0, 8)}`;
  const response = await worker.fetch(
    new Request("https://api.idiot.tax/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ id, requireReceipt, agents: ["alpha", "beta"] }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  const agents = (await response.json<{ agents: { apiToken: string }[] }>()).agents;
  const alpha = agents[0]!.apiToken,
    beta = agents[1]!.apiToken;
  const joined = await api(id, "/join", alpha, "POST", { agent: "alpha" });
  expect(joined.status).toBe(201);
  const { repoName } = await joined.json<{ repoName: string }>();
  await inside(id, async (instance, storage) => {
    instance.fixture.heads.set(repoName, head);
    await storage.put("packet:resume", {
      id: "resume",
      title: "Resume work",
      goal: "Continue",
      paths: ["src"],
      acceptance: [],
    } satisfies Packet);
    await storage.put("claim:resume", {
      packet: "resume",
      agent: "alpha",
      repoName,
      paths: ["src"],
      createdAt: claimedAt,
    } satisfies Claim);
    if (values) await storage.put("review:review-current", review(repoName, values));
  });
  return { id, alpha, beta, repoName };
}
async function me(f: Awaited<ReturnType<typeof setup>>, token = f.alpha) {
  const response = await api(f.id, "/me?agent=beta&role=owner", token);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json<{ work: WorkItem[] }>();
}

describe("/me resume summary under workerd with offline Artifacts", () => {
  const cases: {
    name: string;
    next: WorkItem["next"];
    head?: string;
    required?: boolean;
    review?: Partial<Review>;
  }[] = [
    { name: "unchanged fork without review", head: BEFORE, next: "push" },
    { name: "changed fork without review", next: "request_review" },
    { name: "stored stale review is excluded", review: { stale: true }, next: "request_review" },
    {
      name: "stale review excluded on unchanged fork",
      head: BEFORE,
      review: { stale: true },
      next: "push",
    },
    {
      name: "head mismatch precedes running checks",
      head: THIRD,
      review: { receipt: receipt("running") },
      next: "request_review",
    },
    {
      name: "return at reviewed head precedes running checks",
      review: { returned: { reason: "Update", at: claimedAt }, receipt: receipt("running") },
      next: "address_return",
    },
    {
      name: "push after return needs a new review",
      head: THIRD,
      review: { returned: { reason: "Update", at: claimedAt } },
      next: "request_review",
    },
    {
      name: "required running checks",
      review: { receipt: receipt("running") },
      next: "wait_for_checks",
    },
    {
      name: "advisory running checks",
      required: false,
      review: { receipt: receipt("running") },
      next: "wait_for_checks",
    },
    ...(["failed", "infrastructure-error", "timed-out"] as const).map((status) => ({
      name: `required ${status} checks`,
      review: { receipt: receipt(status) },
      next: "fix_checks" as const,
    })),
    { name: "required missing receipt", review: {}, next: "fix_checks" },
    {
      name: "required passed checks",
      review: { receipt: receipt("passed") },
      next: "wait_for_owner",
    },
    {
      name: "advisory failed checks",
      required: false,
      review: { receipt: receipt("failed") },
      next: "wait_for_owner",
    },
    { name: "advisory missing receipt", required: false, review: {}, next: "wait_for_owner" },
    {
      name: "approved review still waits for owner",
      review: { receipt: receipt("passed"), approval: { sha: AFTER, receiptDigest: null } },
      next: "wait_for_owner",
    },
    {
      name: "promoted precedes return, changed head and running checks",
      head: THIRD,
      review: {
        promoted: true,
        returned: { reason: "Update", at: claimedAt },
        receipt: receipt("running"),
      },
      next: "done",
    },
  ];
  it.each(cases)("$name → $next", async (test) => {
    const f = await setup(test.required ?? true, test.head ?? AFTER, test.review);
    const { work } = await me(f);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      packet: { id: "resume", title: "Resume work" },
      repoName: f.repoName,
      claimedAt,
      forkHead: test.head ?? AFTER,
      canonicalHead: BEFORE,
      next: test.next,
    });
    expect(Object.keys(work[0]!).toSorted()).toEqual([
      "canonicalHead",
      "claimedAt",
      "forkHead",
      "hint",
      "next",
      "packet",
      "repoName",
      "review",
    ]);
    expect(work[0]!.hint.length).toBeGreaterThan(0);
    expect(work[0]!.hint.length).toBeLessThanOrEqual(200);
    expect(work[0]!.hint).not.toMatch(/[<>\n\r]/);
    expect(JSON.stringify(work)).not.toContain("private-execution-identity");
    if (!test.review || test.review.stale) expect(work[0]!.review).toBeNull();
    else {
      expect(Object.keys(work[0]!.review!).toSorted()).toEqual([
        "approved",
        "id",
        "promoted",
        "receipt",
        "returned",
        "sha",
        "stale",
      ]);
      expect(work[0]!.review!.approved).toBe(!!test.review.approval);
      expect(work[0]!.review!.stale).toBe(!test.review.promoted && (test.head ?? AFTER) !== AFTER);
    }
  });

  it("selects the latest non-stale matching packet/fork review, independent of storage order", async () => {
    const f = await setup();
    await inside(f.id, async (_, storage) => {
      await storage.put(
        "review:z-old",
        review(f.repoName, { id: "z-old", createdAt: "2026-10-10T10:00:00.000Z", promoted: true }),
      );
      await storage.put(
        "review:a-latest",
        review(f.repoName, { id: "a-latest", receipt: receipt("passed") }),
      );
      for (const [id, fields] of [
        ["stale", { stale: true }],
        ["foreign", { agent: "beta" }],
        ["other-packet", { packet: "other" }],
        ["other-fork", { repoName: `${f.id}--alpha-2` }],
      ] as const)
        await storage.put(
          `review:${id}`,
          review(f.repoName, { id, createdAt: "2026-10-13T10:00:00.000Z", ...fields }),
        );
    });
    expect((await me(f)).work[0]).toMatchObject({
      review: { id: "a-latest" },
      next: "wait_for_owner",
    });
  });

  it("returns only live caller claims on registered caller forks; owner and other agent work is empty", async () => {
    const f = await setup();
    await inside(f.id, async (_, storage) => {
      const claim = (await storage.get<Claim>("claim:resume"))!;
      const packet = (await storage.get<Packet>("packet:resume"))!;
      for (const id of ["second", "foreign", "orphan", "canonical"])
        await storage.put(`packet:${id}`, { ...packet, id });
      await storage.put("claim:second", { ...claim, packet: "second" });
      await storage.put("claim:foreign", { ...claim, packet: "foreign", agent: "beta" });
      await storage.put("claim:orphan", { ...claim, packet: "orphan", repoName: "orphan" });
      await storage.put("claim:canonical", { ...claim, packet: "canonical", repoName: f.id });
    });
    expect((await me(f)).work.map((item) => item.packet.id)).toEqual(["resume", "second"]);
    expect((await me(f, OWNER)).work).toEqual([]);
    expect((await me(f, f.beta)).work).toEqual([]);
    expect((await api(f.id, "/packets/resume/claim", OWNER, "DELETE")).status).toBe(200);
    expect((await me(f)).work.map((item) => item.packet.id)).toEqual(["second"]);
  });

  it("uses the imported default branch and reports head drift without changing durable reviews", async () => {
    const f = await setup(true, THIRD, {});
    await inside(f.id, async (instance, storage) => {
      const project = (await storage.get<import("../src/types").Project>("project"))!;
      await storage.put("project", { ...project, defaultBranch: "trunk" });
      instance.fixture.defaultBranch = "trunk";
      instance.fixture.calls.length = 0;
    });
    expect((await me(f)).work[0]).toMatchObject({
      review: { stale: true },
      next: "request_review",
    });
    await inside(f.id, async (instance, storage) => {
      expect((await storage.get<Review>("review:review-current"))!.stale).toBe(false);
      expect(
        instance.fixture.calls.filter((call) => call.method === "log").map((call) => call.ref),
      ).toEqual(["trunk", "trunk"]);
      expect(
        instance.fixture.calls.some((call) => ["createToken", "revokeToken"].includes(call.method)),
      ).toBe(false);
    });
  });
});
