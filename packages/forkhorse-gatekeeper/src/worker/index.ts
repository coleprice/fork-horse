import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperVendor as Vendor, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { connectHandoffPageHtml, connectMutationError } from "@gadgets/gatekeeper-kit/connect-pages";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { RESOURCE, type Env } from "./account.ts";
import brand from "../../../../brand.json";
import TYPES from "../fork-types.txt";
export { UserAccount, AgentAccount, AgentVerifier } from "./account.ts";
export { ForkGatekeeper } from "./fork.ts";

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe(): Promise<VendorDescription> {
    return { displayName: brand.name, url: `https://${brand.domains.primary}`, tagline: brand.tagline,
      description: "Connect an enrolled agent to read its forks and submit forward-only Git updates.",
      autoProvisionsAccount: false, providesAuth: false };
  }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    if (options?.scopes === "auth" || (options?.resourceUrlPatterns !== undefined && (options.resourceUrlPatterns.length === 0 || options.resourceUrlPatterns.some(p => p !== RESOURCE.urlPattern)))) {
      throw new Error("Unsupported connection scope.");
    }
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).initiate(callback, nonce);
    return { url: `${this.env.BASE_URL}/${id}/${nonce}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
}

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  } });
}
function connectForm(action: string): string {
  return `<!doctype html><html><meta charset="utf-8"><title>${escape(brand.name)}</title>
    <style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:1rem}label{display:block;margin:1rem 0}input{display:block;width:100%;padding:.6rem;box-sizing:border-box}button{padding:.7rem}</style>
    <h1>Connect ${escape(brand.name)}</h1><p>Use an enrolled agent credential for your project. Owner credentials are refused.</p>
    <form method="post" action="${escape(action)}"><label>Core origin<input name="coreOrigin" type="url" required placeholder="https://core.idiot.tax"></label>
    <label>Project ID<input name="project" maxlength="48" required autocomplete="off"></label>
    <label>Enrolled agent credential<input name="agentCredential" type="password" maxlength="256" required autocomplete="off"></label>
    <button>Connect agent</button></form></html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const base = new URL(env.BASE_URL);
    const prefix = base.pathname.replace(/\/$/, "");
    if (url.origin !== base.origin || url.search || !url.pathname.startsWith(`${prefix}/`)) return html("Not found.", 404);
    const match = /^([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(url.pathname.slice(prefix.length + 1));
    if (!match) return html(`<h1>${escape(brand.name)}</h1><p>Open your connected agent account in the OS sidebar.</p>`, 404);
    const source = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(match[1]));
    if (request.method === "GET") {
      if (!await source.validNonce(match[2])) return html("Connection link expired. Start again.", 400);
      const response = html(connectForm(url.href));
      // A no-referrer HTML form sends Origin: null. Keep same-origin POST verification usable
      // without disclosing the nonce-bearing URL to another origin.
      response.headers.set("referrer-policy", "same-origin");
      return response;
    }
    if (request.method !== "POST") return html("Method not allowed.", 405);
    if (connectMutationError(request, { origin: base.origin, contentType: "application/x-www-form-urlencoded" })) {
      return html("Invalid connection submission.", 403);
    }
    try {
      const fields = new URLSearchParams(await readTextCapped(request, 8192));
      const handoff = await source.completeConnection(match[2], {
        coreOrigin: fields.get("coreOrigin") ?? "", project: fields.get("project") ?? "",
        agentCredential: fields.get("agentCredential") ?? "",
      });
      // The kit handoff navigates to the initiating Workshop; credentials never enter this page.
      return new Response(connectHandoffPageHtml(handoff), { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      } });
    } catch { return html("Agent connection failed. Verify your credential and start again.", 400); }
  },
};
