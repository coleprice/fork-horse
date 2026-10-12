import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { createRateLimitedCapability } from "../../../cloudflare-os/packages/workshop-frontend/src/rateLimitedCapability.ts";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { SnapshotFeed } from "../src/feed.ts";
import { FixtureUi } from "./fixture-ui.ts";

const state = stateView(fixtureState());
const feed = new SnapshotFeed(state);
const fixture = new FixtureUi(feed);
const limited = createRateLimitedCapability(fixture, {
  maxConcurrency: 8, maxCallsPerMinute: 600, maxPendingCalls: 128,
  onRateLimit: "throttle", label: "Fixture sidebar",
});
const output = document.getElementById("fixture-output")!;
class FixtureHost extends RpcTarget {
  get ui() { return limited.capability; }
  openPrompt(prompt: string) { output.textContent = `Fixture openPrompt received: ${prompt}`; }
}

// Exercise the actual built document in the same opaque-origin sandbox as pinned OS.
const response = await fetch("/dist/sidebar.html");
if (!response.ok) throw new Error("Build the sidebar before starting its fixture host.");
const html = await response.text();
const iframe = document.createElement("iframe");
iframe.title = "Local fixture sidebar";
iframe.setAttribute("sandbox", "allow-scripts");
iframe.style.cssText = "width:100%;height:100vh;border:0";
// Label only the fixture document; the production build has no fixture data or marker.
iframe.srcdoc = html.replace('<div id="sidebar">', '<div id="sidebar" data-fixture="true">');
let session: ReturnType<typeof newMessagePortRpcSession> | undefined;
const handshake = (event: MessageEvent) => {
  if (event.source !== iframe.contentWindow || event.origin !== "null" ||
      event.data?.type !== "handshake" || !event.ports[0]) return;
  if (session) { event.ports[0].close(); return; }
  session = newMessagePortRpcSession(event.ports[0], new FixtureHost());
};
window.addEventListener("message", handshake);
document.getElementById("sidebar")!.replaceChildren(iframe);
let batches = 0;
const timer = setInterval(() => {
  batches++;
  state.packets[0]!.title = `Fixture update batch ${batches}`;
  feed.publish(state);
}, 250);
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  window.removeEventListener("message", handshake);
  feed.dispose(); limited.dispose(); session?.[Symbol.dispose]();
}, { once: true });
