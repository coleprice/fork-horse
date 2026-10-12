import assert from "node:assert/strict";
import { test } from "node:test";
import { hostConnection } from "../src/host-connection.ts";
import type { SidebarUi } from "../src/ui-types.ts";

test("host getter reacquires on a healthy port and replaces only a failed host session", async () => {
  let connects = 0,
    disposed = 0,
    failed = false;
  const ui = {} as SidebarUi;
  const connection = hostConnection(() => {
    connects++;
    const generation = connects;
    return {
      host: {
        get ui() {
          if (generation === 1 && failed)
            return Promise.reject(new Error("Peer closed MessagePort connection."));
          return Promise.resolve(ui);
        },
      },
      dispose() {
        disposed++;
      },
    };
  });
  assert.equal(await connection.acquireUi(), ui);
  assert.equal(await connection.acquireUi(), ui);
  assert.equal(connects, 1);
  failed = true;
  assert.equal(await connection.acquireUi(), ui);
  assert.equal(connects, 2);
  assert.equal(disposed, 1);
  assert.equal(await connection.acquireUi(), ui);
  assert.equal(connects, 2);
  connection.dispose();
  assert.equal(disposed, 2);
});

for (const dispose of [false, true])
  test(`a late getter rejection cannot renew a ${dispose ? "disposed" : "retired"} connection`, async () => {
    let connects = 0,
      active = true,
      reject!: (error: Error) => void;
    const pending = new Promise<SidebarUi>((_resolve, fail) => {
      reject = fail;
    });
    const connection = hostConnection(() => {
      connects++;
      return { host: { ui: pending }, dispose() {} };
    });
    const acquiring = connection.acquireUi(() => active);
    if (dispose) connection.dispose();
    else active = false;
    reject(new Error("Late closed port"));
    await assert.rejects(acquiring, /Late closed port/);
    assert.equal(connects, 1);
  });
