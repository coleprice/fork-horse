import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { it, expect, vi, afterEach } from "vitest";
import { createWorktreeSession } from "./worktree-turn.ts";

afterEach(() => vi.unstubAllGlobals());
it("S7: pinned OS createWorktree, edit, approval and real Git CAS push", async () => {
  // Only the external Core/Artifacts network is replaced. Native RPC, the gatekeeper,
  // OS approval queue, scoped cache, Git pack codec and local git-http-backend are real.
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) => env.LOCAL_GIT.fetch(new Request(input, init)));
  const { url } = await env.FIXTURE.begin();
  const connected = await env.VENDOR_HTTP.fetch(url, { method: "POST", headers: {
    origin: "https://os.fixture.idiot.tax", "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ coreOrigin: "https://core.fixture.idiot.tax", project: "fixture", agentCredential: "fixture-agent-credential-only" }).toString() });
  expect(connected.status).toBe(200); await connected.text();
  const stub = env.TEST_OVERSEER.getByName("s7-offline");
  const evidence = await runInDurableObject(stub, async (instance: any) => {
    using user = await env.FIXTURE.account();
    const source = await user.getGatekeeperClassFor("https://core.fixture.idiot.tax/projects/fixture/forks/fork-alpha");
    const impl = instance.impl;
    impl.storage.chatMeta.put({ id: 1, title: "Local acceptance", started: new Date(0), lastActive: new Date(1) });
    using client = await impl.addGatekeeper(source.class, { type: "gatekeeper", vendorId: "fixture", resourceUrl: "https://core.fixture.idiot.tax/projects/fixture/forks/fork-alpha" }, "fixture");
    const id = await client.getId();
    using session = await impl.startGatekeeperSession({ type: "gatekeeper", id }, { from: "agent", chatId: 1 });
    const head = await session.getHead();
    const worktree = await createWorktreeSession(impl, 1, head.commitId);
    expect(await worktree.session.readFile("README.md")).toBe("Before local acceptance\n");
    await worktree.session.writeFile("README.md", "After approved local acceptance\n");
    const commit = await worktree.session.commit("Local acceptance edit");
    await worktree.turn.barrier();
    expect(commit).toMatch(/^[a-f0-9]{40}$/); expect(commit).not.toBe(head.commitId);
    await session.push("main", commit);
    const queued = [...impl.storage.actions.pendingByGatekeeper.get(id)];
    expect(queued).toHaveLength(1);
    expect(queued[0].description).toMatchObject({ pushedCommits: [commit], awaitDecision: true });
    const before = await (await env.LOCAL_GIT.fetch("https://fixture.idiot.tax/evidence")).json<any>();
    expect(before).toMatchObject({ head: head.commitId, writes: 0 }); expect(before.reads).toBeGreaterThan(0);
    await impl.applyPendingAction(queued[0], { type: "user", id: "reviewer@idiot.tax", name: "Fixture Reviewer" }, false);
    const after = await (await env.LOCAL_GIT.fetch("https://fixture.idiot.tax/evidence")).json<any>();
    expect(after).toMatchObject({ head: commit, writes: 1, text: "After approved local acceptance\n" });
    expect(impl.storage.actions.get(queued[0].id).state).toBe("approved");
    const raced = await createWorktreeSession(impl, 1, commit);
    await raced.session.writeFile("README.md", "This must lose the CAS race\n");
    const losingCommit = await raced.session.commit("Losing race"); await raced.turn.barrier();
    await session.push("main", losingCommit);
    const pending = [...impl.storage.actions.pendingByGatekeeper.get(id)][0];
    await (await env.LOCAL_GIT.fetch("https://fixture.idiot.tax/race")).text();
    await expect(impl.applyPendingAction(pending, { type: "user", id: "reviewer@idiot.tax", name: "Fixture Reviewer" }, false)).rejects.toThrow("Git push failed");
    const racedResult = await (await env.LOCAL_GIT.fetch("https://fixture.idiot.tax/evidence")).json<any>();
    expect(racedResult.head).not.toBe(losingCommit);
    expect(racedResult.text).toBe("After approved local acceptance\n");
    expect(impl.storage.actions.get(pending.id).state).toBe("pending");
    return { casRaceRejected: true, scenario: "S7 pinned kernel with local Git fixture", oldSha: head.commitId, newSha: commit, worktreeId: worktree.id, actionId: queued[0].id, ...after };
  });
  await (await env.LOCAL_GIT.fetch("https://fixture.idiot.tax/record", { method: "POST", body: JSON.stringify(evidence) })).text();
});
