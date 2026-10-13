import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription, AppUiContext, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { generateNonce, isLiveNonce, type TimedNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { isConnectAttempted, markConnectAttempted } from "@gadgets/gatekeeper-kit/connect-handshake";
import { stageCredentials, commitStagedCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { pullGitObjectsIntoCache, pushGitRefUpdate } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitCache, GitOid, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import { validateRpc } from "capnweb-validate";
import { CoreClient } from "./core-client.ts";
import { checkConnectionDraft, type ConnectionDraft } from "../configuration.ts";
import { createSidebarFrame, sidebarAccountDescription } from "./sidebar.ts";
import type { ProjectState } from "../../../forkhorse-dashboard/src/contracts.ts";
import SIDEBAR_HTML from "../../dist/sidebar.html";
import PICKER_HTML from "../../dist/picker.html";
import brand from "../../../../brand.json";
import { markIconUrl } from "../../../forkhorse-dashboard/src/mark.ts";

export interface Env extends Cloudflare.Env { BASE_URL: string }
interface Credentials extends ConnectionDraft { agent: string }
interface AccountProps { accountId: string }
export const RESOURCE: SupportedResource = {
  urlPattern: "https://:host/projects/:project/forks/:repoName",
  title: "Agent fork", description: "A Git fork owned by the connected agent.",
  icon: { url: markIconUrl(brand.mark) },
};

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.ts");
      durableNamespaces: "UserAccount" | "ForkGatekeeper";
    }
  }
}

/** Private credential store. Only account/fork capabilities carry its unguessable object id. */
export class UserAccount extends DurableObject<Env> {
  #generation = 0;
  #client(): CoreClient {
    const generation = this.#generation;
    const creds = this.ctx.storage.kv.get<Credentials>("credentials");
    if (!creds) throw new Error("Agent connection unavailable.");
    return new CoreClient(creds, creds.agent, () => {
      if (generation !== this.#generation || !this.ctx.storage.kv.get("credentials")) {
        throw new Error("Agent connection unavailable.");
      }
    });
  }
  async initiate(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (this.ctx.storage.kv.get("callback")) throw new Error("Connection already initiated.");
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + 600_000 } satisfies TimedNonce);
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
  async validNonce(nonce: string): Promise<boolean> {
    return isLiveNonce(this.ctx.storage.kv.get<TimedNonce>("nonce"), nonce, Date.now());
  }
  async completeConnection(nonce: string, draft: ConnectionDraft): Promise<ConnectHandoff> {
    // Consume before network I/O: concurrent submissions and retries cannot complete twice.
    if (!isLiveNonce(this.ctx.storage.kv.get<TimedNonce>("nonce"), nonce, Date.now())) {
      throw new Error("Connection link expired. Start again.");
    }
    this.ctx.storage.kv.delete("nonce");
    const generation = this.#generation;
    const checked = checkConnectionDraft(draft);
    const normalized = { ...draft, coreOrigin: checked.coreOrigin };
    const identity = await new CoreClient(normalized).identity();
    if (generation !== this.#generation) throw new Error("Connection revoked.");
    const credentials: Credentials = { ...normalized, agent: identity.agent };
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Connection callback unavailable.");
    const existing = this.ctx.storage.kv.get<Credentials>("credentials");
    if (existing) {
      if (existing.agent !== credentials.agent || existing.project !== credentials.project ||
          existing.coreOrigin !== credentials.coreOrigin) throw new Error("Reconnect must retain the same agent and project.");
      const stageId = stageCredentials(this.ctx.storage.kv, credentials, Date.now());
      return callback.reconnectComplete(stageId);
    }
    if (isConnectAttempted(this.ctx.storage.kv)) throw new Error("Connection already attempted.");
    markConnectAttempted(this.ctx.storage.kv);
    this.ctx.storage.kv.put("credentials", credentials);
    try {
      const handoff = await callback.complete(this.ctx.exports.AgentAccount({ props: { accountId: this.ctx.id.toString() } }));
      if (generation !== this.#generation) throw new Error("Connection revoked.");
      await this.ctx.storage.deleteAlarm();
      return handoff;
    } catch {
      this.#generation++;
      this.ctx.storage.kv.delete("credentials");
      throw new Error("Connection completion failed. Start again.");
    }
  }
  async reconnect(): Promise<string> {
    if (!this.ctx.storage.kv.get("credentials")) throw new Error("Agent connection unavailable.");
    const nonce = generateNonce();
    this.ctx.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + 600_000 } satisfies TimedNonce);
    return nonce;
  }
  async commitReconnect(stageId: string): Promise<void> {
    if (!this.ctx.storage.kv.get("credentials")) throw new Error("Agent connection unavailable.");
    const staged = commitStagedCredentials<Credentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("Reconnect stage unavailable.");
    this.#generation++;
    this.ctx.storage.kv.put("credentials", staged);
  }
  async revoke(): Promise<void> {
    this.#generation++;
    this.ctx.storage.kv.delete("credentials");
    await this.ctx.storage.deleteAll();
  }
  async alarm(): Promise<void> { await this.revoke(); }
  async identity() { return this.#client().identity(); }
  async state(): Promise<ProjectState> { return this.#client().state(); }
  async fork(repoName: string) { return this.#client().fork(repoName); }
  async metadata(): Promise<{ coreOrigin: string; project: string; agent: string }> {
    const identity = await this.identity();
    const creds = this.ctx.storage.kv.get<Credentials>("credentials");
    if (!creds) throw new Error("Agent connection unavailable.");
    return { coreOrigin: creds.coreOrigin, project: creds.project, agent: identity.agent };
  }
  async pull(repoName: string, oids: GitOid[], hints: GitPullHints, cache: RpcStub<GitCache>): Promise<void> {
    const client = this.#client();
    try {
      await pullGitObjectsIntoCache(body => client.git(repoName, "upload-pack", body), oids, hints, cache);
    } catch { throw new Error("Git pull failed."); }
  }
  async push(repoName: string, branch: string, oldSha: string, newSha: string, pack: ReadableStream<Uint8Array>): Promise<void> {
    const client = this.#client();
    try {
      await pushGitRefUpdate(body => client.git(repoName, "receive-pack", body), { branch, oldSha, newSha }, pack);
    } catch { throw new Error("Git push failed or was rejected. Refresh the fork head."); }
  }
}

function account(exports: Cloudflare.Exports, id: string) {
  return exports.UserAccount.get(exports.UserAccount.idFromString(id));
}

@validateRpc()
class ForkPicker extends RpcTarget {
  constructor(private readonly source: DurableObjectStub<UserAccount>) { super(); }
  async list(): Promise<{ url: string; repoName: string; head: string }[]> {
    const meta = await this.source.metadata();
    return (await this.source.identity()).forks.map(f => ({
      url: `${meta.coreOrigin}/projects/${meta.project}/forks/${encodeURIComponent(f.repoName)}`,
      repoName: f.repoName, head: f.head,
    }));
  }
}

export class AgentAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  #account() { return account(this.ctx.exports, this.ctx.props.accountId); }
  async describe(): Promise<AccountDescription> {
    const meta = await this.#account().metadata();
    return { ...sidebarAccountDescription(meta.agent), uniqueName: `${meta.agent} · ${meta.project}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { await this.#account().identity(); return [RESOURCE]; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const source = this.#account();
    const meta = await source.metadata();
    const prefix = `${meta.coreOrigin}/projects/${meta.project}/forks/`;
    if (!url.startsWith(prefix)) throw new Error("Fork is outside the connected project.");
    const repoName = url.slice(prefix.length);
    if (encodeURIComponent(repoName) !== repoName) throw new Error("Invalid fork URL.");
    await source.fork(repoName);
    return { class: this.ctx.exports.ForkGatekeeper({ props: { accountId: this.ctx.props.accountId, repoName } }), resource: RESOURCE };
  }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    if (pattern !== RESOURCE.urlPattern) throw new Error("Unsupported resource type.");
    await this.#account().identity();
    return { iframeHtml: PICKER_HTML, ui: new RpcStub(new ForkPicker(this.#account())) };
  }
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const source = this.#account();
    return createSidebarFrame({
      authorize: async () => { await source.identity(); },
      read: () => source.state(),
      watch(changed, revoked) {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let previous = "";
        const poll = async () => {
          try {
            const state = await source.state();
            if (stopped) return;
            const key = JSON.stringify(state);
            if (key !== previous) { previous = key; changed(state); }
            if (!stopped) timer = setTimeout(() => { void poll(); }, 250);
          } catch { if (!stopped) revoked(); }
        };
        void poll();
        return () => { stopped = true; clearTimeout(timer); };
      },
    }, SIDEBAR_HTML);
  }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  async reconnect(): Promise<{ url: string }> {
    const nonce = await this.#account().reconnect();
    return { url: `${this.env.BASE_URL}/${this.ctx.props.accountId}/${nonce}` };
  }
  async commitReconnect(stageId: string): Promise<void> { await this.#account().commitReconnect(stageId); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  async ensureResources(patterns: string[]): Promise<{}> {
    if (patterns.some(p => p !== RESOURCE.urlPattern)) throw new Error("Unsupported resource type.");
    await this.#account().identity(); return {};
  }
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.AgentVerifier({ props: this.ctx.props });
  }
}

export class AgentVerifier extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUserVerifier {
  async owns(coreOrigin: string, project: string, repoName: string): Promise<boolean> {
    const source = account(this.ctx.exports, this.ctx.props.accountId);
    try {
      const meta = await source.metadata();
      if (meta.coreOrigin !== coreOrigin || meta.project !== project) return false;
      await source.fork(repoName); return true;
    } catch { return false; }
  }
}
