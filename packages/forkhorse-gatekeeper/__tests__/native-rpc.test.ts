import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";

// Retained minimal control for the pinned runtime's rejected-target diagnostic.
// Exceptions stay visible; successful assertions do not assert clean runtime logs.
it("catches a plain entrypoint rejection", async () => {
  let message = "";
  try { await env.FIXTURE.diagnosticReject(); } catch (error) { message = String(error); }
  expect(message).toContain("Plain native RPC diagnostic refusal.");
});

it("plain returned target stays usable and is disposed after a rejected call", async () => {
  const before = await env.FIXTURE.diagnosticDisposals();
  {
    using target = await env.FIXTURE.diagnosticTarget();
    let message = "";
    try { await target.reject(); } catch (error) { message = String(error); }
    expect(message).toContain("Plain target diagnostic refusal.");
    expect(await target.ping()).toBe("ready");
  }
  await vi.waitFor(async () => expect(await env.FIXTURE.diagnosticDisposals()).toBe(before + 1));
});
