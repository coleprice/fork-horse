import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { checkConnectionDraft, type ConnectionDraft, type DraftStatus } from "../configuration.ts";

/** Fixture-only format checking. Production connection uses the account popup. */
@validateRpc()
export class ConnectionDraftUiImpl extends RpcTarget {
  async checkDraft(draft: ConnectionDraft): Promise<DraftStatus> {
    return checkConnectionDraft(draft);
  }
}

export function createConnectionDraftFrame(iframeHtml: string): GatekeeperUiFrame {
  return { iframeHtml, ui: new RpcStub(new ConnectionDraftUiImpl()) };
}
