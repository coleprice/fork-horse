import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { storedAgentKeyProvider } from "../src/index.ts";
import type { StoredAgentCredentials } from "../src/index.ts";

const call = { origin: "https://mcp.idiot.tax", project: "demo" };
const credentials = {
  coreOrigin: call.origin, project: call.project, agentCredential: "fixture_agent_key_only",
};

test("construction is lazy and only the HTTP capability returns a bearer", async () => {
  let reads = 0;
  const provider = storedAgentKeyProvider(() => { reads++; return credentials; });
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(provider), "{}");
  assert.ok(!inspect(provider).includes(credentials.agentCredential));
  assert.deepEqual(Object.keys(provider), ["getBearer"]);
  assert.ok(Object.isFrozen(provider));
  assert.equal(await provider.getBearer(call), `Bearer ${credentials.agentCredential}`);
  assert.equal(reads, 1);
});

test("rotation and disconnection are observed on each call without caching", async () => {
  let stored: StoredAgentCredentials | undefined = credentials;
  const provider = storedAgentKeyProvider(() => stored);
  assert.equal(await provider.getBearer(call), `Bearer ${credentials.agentCredential}`);
  stored = { ...credentials, agentCredential: "fixture_rotated_key_only" };
  assert.equal(await provider.getBearer(call), "Bearer fixture_rotated_key_only");
  stored = undefined;
  await assert.rejects(provider.getBearer(call), /^Error: Agent authorization unavailable\.$/);
});

test("accepts asynchronous connected-account storage", async () => {
  const provider = storedAgentKeyProvider(async () => credentials);
  assert.equal(await provider.getBearer(call), `Bearer ${credentials.agentCredential}`);
});

test("captures the HTTP destination before asynchronous storage runs", async () => {
  const destination = { ...call, project: "other" };
  const provider = storedAgentKeyProvider(async () => {
    destination.project = call.project;
    return credentials;
  });
  await assert.rejects(provider.getBearer(destination), /Agent authorization unavailable/);
});

test("refuses use at a different origin or project", async () => {
  const provider = storedAgentKeyProvider(() => credentials);
  for (const destination of [
    { ...call, origin: "https://other.idiot.tax" },
    { ...call, project: "other" },
    { ...call, origin: `${call.origin}/path` },
    { ...call, project: "demo\n" },
  ]) await assert.rejects(provider.getBearer(destination), /^Error: Agent authorization unavailable\.$/);
});

test("rejects a removed connection and invalid or header-injecting keys", async () => {
  for (const agentCredential of ["", "short", "a".repeat(257), "a".repeat(16) + "\n", "a".repeat(16) + "\r\nx: y", "fixture key spaces"]) {
    const provider = storedAgentKeyProvider(() => ({ ...credentials, agentCredential }));
    await assert.rejects(provider.getBearer(call), /^Error: Agent authorization unavailable\.$/);
  }
  await assert.rejects(storedAgentKeyProvider(() => null).getBearer(call), /Agent authorization unavailable/);
});

test("provider failures never log or propagate storage errors or their causes", async (t) => {
  const errorLog = t.mock.method(console, "error", () => {});
  const warnLog = t.mock.method(console, "warn", () => {});
  const infoLog = t.mock.method(console, "info", () => {});
  const log = t.mock.method(console, "log", () => {});
  for (const read of [
    () => { throw new Error(credentials.agentCredential); },
    async () => { throw new Error(credentials.agentCredential); },
  ]) {
    await assert.rejects(storedAgentKeyProvider(read).getBearer(call), (error: Error) => {
      assert.equal(error.message, "Agent authorization unavailable.");
      assert.equal(error.cause, undefined);
      assert.ok(!inspect(error).includes(credentials.agentCredential));
      return true;
    });
  }
  for (const method of [errorLog, warnLog, infoLog, log]) assert.equal(method.mock.callCount(), 0);
});
