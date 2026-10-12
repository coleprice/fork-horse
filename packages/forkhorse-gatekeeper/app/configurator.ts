import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { CONNECTION_HELD, type ConnectionDraft, type DraftStatus } from "../src/configuration.ts";
import { mountConfiguration } from "../src/configuration-form.ts";
import brand from "../../../brand.json";
import "./configurator.css";

interface DraftApi extends RpcTarget { checkDraft(draft: ConnectionDraft): Promise<DraftStatus> }
interface Host extends RpcTarget {
  readonly gatekeeper: DraftApi;
  setSelectionReady(ready: boolean): Promise<void>;
  resize(height: number, layoutHeight: number): Promise<void>;
}
class ConfiguratorIframe extends RpcTarget {
  async collectResourceUrl(): Promise<string> { throw new Error(CONNECTION_HELD); }
  updateViewport(_iframeTop: number, _viewportHeight: number): void {}
  windowResized(): void {}
}
document.title = brand.name;
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const host = newMessagePortRpcSession<Host>(port1, new ConfiguratorIframe());
const form = mountConfiguration(document.getElementById("sidebar")!, async (draft) => {
  return await host.gatekeeper.checkDraft(draft);
});
void host.setSelectionReady(false).catch(() => {});
void host.resize(540, 540).catch(() => {});
window.addEventListener("pagehide", () => {
  form.dispose(); host[Symbol.dispose](); port1.close();
}, { once: true });
