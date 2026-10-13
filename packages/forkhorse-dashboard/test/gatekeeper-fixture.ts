// Loads actual production bundles with synthetic host/data.
// RPC comes from the gatekeeper's declared dependency, so this fixture adds no dashboard dependency.
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "../../forkhorse-gatekeeper/node_modules/capnweb/dist/index.js";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import { SnapshotFeed } from "../../forkhorse-gatekeeper/src/feed.ts";
import { FixtureUi } from "../../forkhorse-gatekeeper/test/fixture-ui.ts";
import { forkFixtureState } from "./fork-graph-fixtures.ts";
import { stateView } from "../src/model.ts";

const params = new URL(location.href).searchParams;
const owner = params.get("bundle") === "owner";
const state = stateView(
  forkFixtureState(new URL(location.href).searchParams.get("scenario") ?? "fork-hero"),
);
const feed = new SnapshotFeed(state);
const ui = new FixtureUi(feed);
let theme: GatekeeperAppTheme = { mode: "light", accentColor: null };
let receiver: RpcStub<GatekeeperAppThemeReceiver> | undefined;
class FixtureHost extends RpcTarget {
  get ui() {
    return ui;
  }
  subscribeTheme(next: RpcStub<GatekeeperAppThemeReceiver>) {
    receiver?.[Symbol.dispose]();
    receiver = next.dup();
    return theme;
  }
  openPrompt() {
    /* Offline fixture never sends a prompt. */
  }
}
const response = await fetch(
  owner
    ? `/__fixtures/owner-bundle?scenario=${encodeURIComponent(state.project.id)}`
    : "/__fixtures/gatekeeper-bundle",
);
if (!response.ok)
  throw new Error("Build the gatekeeper sidebar assets before opening this fixture.");
const iframe = document.createElement("iframe");
iframe.title = owner ? "Offline built owner app" : "Offline built gatekeeper";
iframe.setAttribute("sandbox", owner ? "allow-scripts allow-same-origin" : "allow-scripts");
iframe.style.cssText = "width:100%;height:calc(100vh - 36px);border:0;display:block";
if (owner) iframe.src = `/__fixtures/owner-bundle?scenario=${encodeURIComponent(state.project.id)}`;
else
  iframe.srcdoc = (await response.text()).replace(
    '<div id="sidebar">',
    '<div id="sidebar" data-fixture="true">',
  );
let session: ReturnType<typeof newMessagePortRpcSession> | undefined;
const handshake = (event: MessageEvent) => {
  if (
    event.source !== iframe.contentWindow ||
    event.origin !== "null" ||
    event.data?.type !== "handshake" ||
    !event.ports[0]
  )
    return;
  if (session) {
    event.ports[0].close();
    return;
  }
  session = newMessagePortRpcSession(event.ports[0], new FixtureHost());
};
window.addEventListener("message", handshake);
document.getElementById("frame")!.append(iframe);
for (const mode of ["light", "dark"] as const)
  document.getElementById(mode)!.addEventListener("click", () => {
    theme = { mode, accentColor: null };
    if (owner)
      iframe.contentWindow?.postMessage({ type: "offline-fixture-theme", theme }, location.origin);
    else void receiver?.setTheme(theme);
  });
window.addEventListener(
  "pagehide",
  () => {
    window.removeEventListener("message", handshake);
    feed.dispose();
    receiver?.[Symbol.dispose]();
    session?.[Symbol.dispose]();
  },
  { once: true },
);
