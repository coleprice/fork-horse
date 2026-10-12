import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { checkConnectionDraft, type ConnectionDraft, type DraftStatus } from "../configuration.ts";

/** Draft-only surface. Account creation and credential validation are held for FH-013. */
@validateRpc()
export class ConnectionDraftUiImpl extends RpcTarget {
  async checkDraft(draft: ConnectionDraft): Promise<DraftStatus> {
    return checkConnectionDraft(draft);
  }
}

export function createConnectionDraftFrame(iframeHtml: string): GatekeeperUiFrame {
  return { iframeHtml, ui: new RpcStub(new ConnectionDraftUiImpl()) };
}
