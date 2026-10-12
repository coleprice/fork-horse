import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { checkConnectionDraft, type ConnectionDraft } from "../src/configuration.ts";

class FixtureDraftApi extends RpcTarget {
  async checkDraft(draft: ConnectionDraft) { return checkConnectionDraft(draft); }
}
const iframe = document.createElement("iframe");
iframe.title = "Local fixture configurator";
iframe.setAttribute("sandbox", "allow-scripts");
iframe.style.cssText = "width:100%;height:600px;border:0";
class FixtureHost extends RpcTarget {
  get gatekeeper() { return new FixtureDraftApi(); }
  async setSelectionReady(ready: boolean) {
    if (ready) throw new Error("Fixture must not enable connection creation.");
    document.getElementById("fixture-output")!.textContent = "Host confirms: connection creation disabled.";
  }
  async resize(height: number) { iframe.style.height = `${Math.min(800, Math.max(200, height))}px`; }
}
let session: ReturnType<typeof newMessagePortRpcSession> | undefined;
const handshake = (event: MessageEvent) => {
  if (event.source !== iframe.contentWindow || event.origin !== "null" ||
      event.data?.type !== "handshake" || !event.ports[0]) return;
  if (session) { event.ports[0].close(); return; }
  session = newMessagePortRpcSession(event.ports[0], new FixtureHost());
};
const response = await fetch("/dist/configurator.html");
if (!response.ok) throw new Error("Build the configurator before starting this fixture.");
iframe.srcdoc = await response.text();
window.addEventListener("message", handshake);
document.getElementById("configurator")!.replaceChildren(iframe);
window.addEventListener("pagehide", () => {
  window.removeEventListener("message", handshake);
  session?.[Symbol.dispose]();
}, { once: true });
