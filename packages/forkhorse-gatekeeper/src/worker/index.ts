import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperVendor as Vendor, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import brand from "../../../../brand.json";

/** Wiring-only entrypoint until FH-013 and the account flow are accepted. */
export class GatekeeperVendor extends WorkerEntrypoint implements Vendor {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: brand.name,
      url: `https://${brand.domains.primary}`,
      logo: { url: "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z"/></svg>',
      ) },
      color: "#e8f2ff",
      tagline: brand.tagline,
      description: "Connection setup is not yet available.",
      autoProvisionsAccount: false,
      providesAuth: false,
    };
  }

  // No callback is retained or completed, and no URL or account capability is returned.
  async connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Connection setup is not yet available.");
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Connection setup is not yet available.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
