import assert from "node:assert/strict";
import { test } from "node:test";
import { forkAddress } from "../src/index.ts";

const input = { origin: "https://mcp.idiot.tax", project: "demo", repoName: "demo--builder-1" };

test("uses the configured origin and preserves the fork delimiter", () => {
  assert.equal(forkAddress(input), "https://mcp.idiot.tax/projects/demo/forks/demo--builder-1");
  assert.equal(forkAddress({ ...input, origin: "https://preview.idiot.tax" }),
    "https://preview.idiot.tax/projects/demo/forks/demo--builder-1");
});

test("accepts project and repository length boundaries", () => {
  const project = "p".repeat(48);
  const repoName = `${project}--${"a".repeat(78)}`;
  assert.ok(forkAddress({ ...input, project, repoName }).endsWith(repoName));
  assert.throws(() => forkAddress({ ...input, project: "p".repeat(49) }));
  assert.throws(() => forkAddress({ ...input, project, repoName: `${repoName}a` }));
});

test("refuses noncanonical origins, credentials, paths and alternate schemes", () => {
  for (const origin of [
    "", "http://mcp.idiot.tax", "https://mcp.idiot.tax/", "https://mcp.idiot.tax/path",
    "https://mcp.idiot.tax?query", "https://mcp.idiot.tax#fragment",
    "https://user:password@mcp.idiot.tax", "https://MCP.idiot.tax",
    " https://mcp.idiot.tax", "https://mcp.idiot.tax\n", "https://mcp.idiot.tax:443",
    "javascript:alert(1)", "//mcp.idiot.tax", "https://" + "a".repeat(2048),
  ]) assert.throws(() => forkAddress({ ...input, origin }), /canonical HTTPS origin/);
});

test("refuses invalid project slugs including a final newline", () => {
  for (const project of ["", "Demo", "-demo", "demo-", "de--mo", "de_mo", "demo\n", "demo/path", "../demo", "demo%2fpath"]) {
    assert.throws(() => forkAddress({ ...input, project }), /project slug/);
  }
});

test("refuses a missing, repeated or mismatched delimiter and unsafe fork names", () => {
  for (const repoName of [
    "demo", "demo-builder-1", "other--builder-1", "demo--", "demo---builder-1",
    "demo--builder--1", "demo--Builder-1", "demo--builder-1-", "demo--builder_1",
    "demo--builder-1\n", "demo--builder/1", "demo--builder%2f1", "demo--../builder",
  ]) assert.throws(() => forkAddress({ ...input, repoName }), /fork repository name/);
});

test("untyped invalid arguments fail closed without interpolating input", () => {
  for (const field of ["origin", "project", "repoName"]) {
    for (const value of [null, undefined, 7, {}, []]) {
      assert.throws(() => forkAddress({ ...input, [field]: value }));
    }
  }
});
