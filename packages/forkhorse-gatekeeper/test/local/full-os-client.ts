// Drives the unchanged local OS through its public API using synthetic account/model data.
// Requires run.ts --serve and the separate full-os fixture Worker; never points at a live OS.
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const require = createRequire(new URL("../../../../cloudflare-os/packages/workshop-frontend/package.json", import.meta.url));
const { newWebSocketRpcSession, RpcTarget } = await import(require.resolve("capnweb"));
const { argon2id } = require("hash-wasm");
const username = `s7fixture${Date.now()}`;
const prefix = new Uint8Array([0xd9,0x4e,0x54,0x1d,0x29,0xc1,0x03,0x74,0x73,0x7e,0xb3,0xe3,0x34,0x6d,0x8f,0x21]);
const name = new TextEncoder().encode(username), salt = new Uint8Array(prefix.length + name.length);
salt.set(prefix); salt.set(name, prefix.length);
const hash = await argon2id({ password: "local-fixture-only", salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary" });
const api = newWebSocketRpcSession("ws://localhost:4180/api");
try {
  const token = await api.createAccount(username, "Synthetic S7 Fixture", hash);
  assert.ok(token);
  using account = await api.authenticate(token);
  await account.setOwnCommitEmail("agent@idiot.tax");
  await account.completeOnboarding();
  const flow = await account.connectAccount("forkhorse");
  const response = await fetch(flow.url, { method: "POST", headers: { origin: "http://localhost:4180", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ coreOrigin: "https://core.fixture.idiot.tax", project: "fixture", agentCredential: "fixture-agent-credential-only" }) });
  const html = await response.text();
  assert.equal(response.status, 200, "synthetic account connection");
  const ticket = /var ticket = ("[^"\n]+");/.exec(html); assert.ok(ticket);
  await account.completeConnectHandoff(JSON.parse(ticket[1]), flow.nonce);
  let accountId: number | undefined, ready!: () => void;
  const connected = new Promise<void>(done => { ready = done; });
  class Accounts extends RpcTarget {
    add(id: number, _description: unknown, _vendor: unknown, _resources: unknown, valid: boolean, vendorId: string) {
      if (vendorId === "forkhorse" && valid) accountId = id;
    }
    remove() {}
    ready() { ready(); }
  }
  using _subscription = await account.subscribeConnectedAccounts(new Accounts()); await connected;
  assert.ok(accountId !== undefined);
  await account.addModel({ type: "agent", id: "synthetic-s7", name: "Synthetic protocol fixture (no inference)" },
    { provider: "anthropic", model: "synthetic-s7", apiToken: "", apiUrl: "http://127.0.0.1:4181", contextWindow: 200000, outputLimit: 4096 });
  using workspace = await account.newGadget();
  await workspace.setTitle("S7 synthetic local acceptance");
  using fork = await workspace.newGatekeeper(accountId, "https://core.fixture.idiot.tax/projects/fixture/forks/fork-alpha");
  const description = await fork.describe();
  const before = await (await fetch("http://127.0.0.1:4181/evidence")).json();
  const chatId = await workspace.newChat("[0] Synthetic S7 fixture: create a worktree and queue an approved forward push.", "synthetic-s7",
    [{ position: 0, length: 3, gatekeeperId: await fork.getId(), description, vendorId: "forkhorse", bindingName: "FORK" }]);
  const metadata = await workspace.getMetadata();
  console.log(JSON.stringify({ phase: "started", username, workspaceId: metadata.id, chatId }));
  let pending: any;
  for (let attempt = 0; attempt < 180; attempt++) {
    const actions = await workspace.listActions({ filter: "pending" });
    pending = actions.entries.find((action: any) => action.description?.pushedCommits?.length);
    if (pending) break;
    if (attempt % 10 === 0) {
      const history = await workspace.getChatHistory(chatId);
      const error = history.messages.find((entry: any) => entry.type === "error");
      if (error) throw new Error(`Local agent fixture failed: ${error.message}`);
      console.log(JSON.stringify({ phase: "waiting", chats: await workspace.listChats() }));
    }
    await delay(500);
  }
  assert.ok(pending, "agent tools reached a pending Git approval");
  const waiting = await (await fetch("http://127.0.0.1:4181/evidence")).json();
  assert.equal(waiting.head, before.head); assert.equal(waiting.writes, 0);
  await workspace.approveAction(pending.id);
  const after = await (await fetch("http://127.0.0.1:4181/evidence")).json();
  assert.equal(after.head, pending.description.pushedCommits[0]);
  assert.equal(after.text, "After full run-local approval\n"); assert.equal(after.writes, 1);
  console.log(`FULL OS ACCEPTANCE: ${JSON.stringify({ username, workspaceId: metadata.id, chatId, actionId: pending.id, oldSha: before.head, ...after, model: "deterministic local protocol fixture", upstream: "8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf" })}`);
} finally { api[Symbol.dispose](); }
