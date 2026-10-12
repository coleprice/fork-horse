import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withCoreSecrets } from "./core-secrets.ts";

const secret = "offline-event-secret-never-output";
async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "events-secrets-fixture-"));
  const file = "packages/forkhorse-core/.wrangler/owner.json";
  const content = JSON.stringify({ OWNER_API_TOKEN_HASH: "a".repeat(64), CF_EVENTS_API_TOKEN: secret });
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    await writeFile(join(root, ".gitignore"), "packages/*/.wrangler/\n", { flag: "wx" });
    await mkdir(join(root, "packages/forkhorse-core/.wrangler"), { recursive: true });
    await writeFile(join(root, file), content, { flag: "wx", mode: 0o600 });
    await run(root, file);
    assert.deepEqual(await readdir(join(root, "packages/forkhorse-core/.wrangler")), ["owner.json"]);
  } finally {
    // Only this exclusively created synthetic fixture directory is removed.
    await rm(root, { recursive: true, force: true });
  }
}
test("first deploy passes a private secrets-file copy and removes it while preserving owner file", async () => {
  await fixture(async (root, file) => {
    const before = await readFile(join(root, file), "utf8");
    await withCoreSecrets(root, file, async (args) => {
      assert.equal(args[0], "--secrets-file");
      assert.notEqual(args[1], join(root, file));
      const path = args[1]!;
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, "utf8"), before);
    });
    assert.equal(await readFile(join(root, file), "utf8"), before);
  });
});
test("failed secret deployment suppresses child errors and removes temporary copy", async () => {
  await fixture(async (root, file) => {
    await assert.rejects(withCoreSecrets(root, file, () => { throw new Error(secret); }), (error: Error) => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.stack?.includes(secret));
      return true;
    });
  });
});
test("rejects malformed, missing, or unignored secrets without printing parser values", async () => {
  await fixture(async (root, file) => {
    for (const content of [secret, JSON.stringify({ CF_EVENTS_API_TOKEN: secret }), JSON.stringify({ OWNER_API_TOKEN_HASH: "a".repeat(64), CF_EVENTS_API_TOKEN: secret, extra: secret })]) {
      await writeFile(join(root, file), content);
      await assert.rejects(withCoreSecrets(root, file, () => assert.fail("must not deploy")), (error: Error) => !error.message.includes(secret));
    }
    await writeFile(join(root, ".gitignore"), "");
    await assert.rejects(withCoreSecrets(root, file, () => assert.fail("must not deploy")));
  });
});
