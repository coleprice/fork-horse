import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Same negative native-RPC control outside the Vitest Worker wrappers. Do not filter logs.
test("standalone workerd returns a native target rejection, stays usable, and disposes", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "control", modules: true, compatibilityDate: "2026-08-04", script: `
    import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
    let disposals = 0;
    class Target extends RpcTarget {
      async reject() { throw new Error("Expected standalone diagnostic refusal"); }
      async ping() { return "ready"; }
      [Symbol.dispose]() { disposals++; }
    }
    export class Control extends WorkerEntrypoint {
      async target() { return new Target(); }
      async disposals() { return disposals; }
    }
    export default { async fetch(request, env, ctx) {
      const service = ctx.exports.Control({});
      const target = await service.target();
      let refused = false;
      try { await target.reject(); } catch (e) { refused = e.message.includes("Expected standalone diagnostic refusal"); }
      const ping = await target.ping();
      target[Symbol.dispose]();
      return Response.json({ refused, ping, disposals: await service.disposals() });
    } }` }] }));
  try {
    const response = await mf.dispatchFetch("http://fixture.idiot.tax/");
    assert.deepEqual(await response.json(), { refused: true, ping: "ready", disposals: 1 });
  } finally { await mf.dispose(); }
});
