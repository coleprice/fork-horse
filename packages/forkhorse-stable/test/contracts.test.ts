import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contributionVerbs } from "../src/index.ts";
import type {
  ClaimResponse, ContributionRequest, JoinResponse, ReadReceiptsResponse,
  ReadReviewResponse, ReleaseResponse, RequestReviewResponse,
} from "../src/index.ts";

test("v0 verbs are complete and v1 entries declare names/status only", () => {
  assert.deepEqual(contributionVerbs.filter(v => v.status === "v0").map(v => v.name),
    ["context", "join", "claim", "release", "requestReview", "readReview", "readReceipts"]);
  assert.deepEqual(contributionVerbs.filter(v => v.status === "v1").map(v => v.name),
    ["list_projects", "start_work", "resume_work", "end_work", "read_tree", "read_file", "read_diff", "run_checks"]);
  assert.equal(new Set(contributionVerbs.map(v => v.name)).size, contributionVerbs.length);
  for (const verb of contributionVerbs) assert.deepEqual(Object.keys(verb), ["name", "status"]);
});

test("public v0 fixtures retain exact commit, race, return and receipt fields", () => {
  const project = "demo", packet = "sample", repoName = "demo--builder-1", agent = "builder";
  const sha = "a".repeat(40), at = "2026-01-01T00:00:00.000Z";
  const request = { project, packet, repoName, sha } satisfies ContributionRequest<"requestReview">;
  const joined = { project, agent, repoName, remote: "https://git.idiot.tax/demo.git",
    scope: "write", events: "pending", expiresAt: at, ttlSeconds: 60 } satisfies JoinResponse;
  const claim = { claim: { packet, agent, repoName, paths: ["src"], createdAt: at,
    usage: { reported: null, metered: null }, firstPushAt: null, reviewRequestedAt: null,
    receiptPassedAt: null, approvedAt: null, promotedAt: null, place: null,
    closedAt: null, closedBy: null } } satisfies ClaimResponse;
  const review = { id: "review-1", packet, agent, repoName, sha, base: "b".repeat(40),
    receiptDigest: null, receipt: null, approval: null, stale: false, promoted: false,
    returned: { reason: "Adjust the fixture", at }, createdAt: at,
    usageAtReview: { reported: null, metered: null } } satisfies RequestReviewResponse["review"];
  const detail = { review,
    packet: { id: packet, title: "Fixture", goal: "Check shape", paths: ["src"], acceptance: [] },
    changes: { base: review.base, head: sha, fileCount: 1, truncated: false,
      files: [{ path: "src/main.ts", status: "modified" }] },
    commits: [{ sha, subject: "Fixture", authorName: "Builder", packetTrailer: packet, agentTrailer: agent }],
    commitsTruncated: false, promotion: null, blockers: [],
  } satisfies ReadReviewResponse;
  const receipts = { receipt: review.receipt } satisfies ReadReceiptsResponse;
  const release = { released: true } satisfies ReleaseResponse;
  assert.equal(detail.review.sha, request.sha);
  assert.equal(detail.review.returned.reason, "Adjust the fixture");
  assert.equal(claim.claim.closedAt, null);
  assert.equal(receipts.receipt, null);
  assert.equal(release.released, true);
  assert.ok(!("token" in joined));
});

test("public records and requests remain type-compatible with accepted core declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "stable-contract-"));
  try {
    // Use current source declarations, not a committed fixture. Extracting only
    // the records avoids pulling Worker implementations into this pure TS test.
    const workflow = readFileSync(new URL("../../forkhorse-core/src/workflow-types.ts", import.meta.url), "utf8");
    const records = readFileSync(new URL("../../forkhorse-core/src/types.ts", import.meta.url), "utf8");
    const operations = readFileSync(new URL("../../forkhorse-mcp/src/core.ts", import.meta.url), "utf8");
    const recordStart = records.indexOf("export interface Project {");
    const operationStart = operations.indexOf("export type CoreOperation =");
    const operationEnd = operations.indexOf("/** Narrow adapter seam:", operationStart);
    assert.ok(recordStart >= 0 && operationStart >= 0 && operationEnd > operationStart);
    writeFileSync(join(dir, "workflow-types.d.ts"), workflow);
    writeFileSync(join(dir, "types.d.ts"), records.slice(recordStart));
    // WorkFile is referenced by the existing commit branch of CoreOperation.
    const fileStart = operations.indexOf("export interface WorkFile {");
    const fileEnd = operations.indexOf("/** Owner identity", fileStart);
    assert.ok(fileStart >= 0 && fileEnd > fileStart);
    writeFileSync(join(dir, "operations.d.ts"), operations.slice(fileStart, fileEnd) + operations.slice(operationStart, operationEnd));
    const assertions = fileURLToPath(new URL("./core-shapes.ts", import.meta.url));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: false, target: "ES2022",
        module: "ESNext", moduleResolution: "bundler", types: [],
        allowImportingTsExtensions: true,
        paths: { "core-workflow": [join(dir, "workflow-types.d.ts")],
          "core-records": [join(dir, "types.d.ts")], "core-operations": [join(dir, "operations.d.ts")] },
      },
      files: [assertions],
    }));
    const compiler = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [compiler, "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    // The compiler sees only public types and fixtures; keep diagnostics on failure.
    if (error && typeof error === "object" && "stdout" in error) assert.fail(String(error.stdout));
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
