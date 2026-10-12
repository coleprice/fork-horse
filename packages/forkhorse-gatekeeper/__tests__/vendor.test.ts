import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { GatekeeperVendor } from "../src/worker/index.ts";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import brand from "../../../brand.json";

declare global {
  namespace Cloudflare { interface Env {
    VENDOR: Service<GatekeeperVendor>; VENDOR_HTTP: Fetcher; CONNECT_CALLBACK: Service<GatekeeperConnectCallback>;
  } }
}

it("wiring-only vendor exposes branding but no auth, account or resources", async () => {
  expect(await env.VENDOR.describe()).toMatchObject({
    displayName: brand.name, url: `https://${brand.domains.primary}`, tagline: brand.tagline,
    providesAuth: false, autoProvisionsAccount: false,
  });
  expect(await env.VENDOR.getSupportedResources()).toEqual([]);
  expect(await env.VENDOR.getTypeScriptTypes()).toBe("");
  let refused = false;
  // The refusal does not call or retain the supplied callback service.
  try { await env.VENDOR.connectAccount(env.CONNECT_CALLBACK); }
  catch (error) { refused = String(error).includes("not yet available"); }
  expect(refused).toBe(true);
});

it("HTTP entrypoint refuses connection paths without redirects, cookies or caching", async () => {
  for (const path of ["/", "/gatekeeper/forkhorse/connect", "/gatekeeper/forkhorse/callback"]) {
    const response = await env.VENDOR_HTTP.fetch(`https://fixture.idiot.tax${path}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe("Connection setup is not yet available.");
  }
});
