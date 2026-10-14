import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import { createRateLimitedCapability } from "../../../cloudflare-os/packages/workshop-frontend/src/rateLimitedCapability.ts";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { SnapshotFeed } from "../src/feed.ts";
import { FixtureUi } from "./fixture-ui.ts";

const state = stateView(fixtureState());
const feed = new SnapshotFeed(state);
const recovery = new URL(location.href).searchParams.has("recovery");
let oldPolls = 0;
const fixture = recovery
  ? new (class extends FixtureUi {
      async subscribe(): Promise<never> {
        throw new Error("Fixture stalled push channel");
      }
      async waitForChanges(): Promise<never> {
        oldPolls++;
        return new Promise(() => {});
      }
    })(feed)
  : new FixtureUi(feed);
const limited = createRateLimitedCapability(fixture, {
  maxConcurrency: 8,
  maxCallsPerMinute: 600,
  maxPendingCalls: 128,
  onRateLimit: "throttle",
  label: "Fixture sidebar",
});
const output = document.getElementById("fixture-output")!;
const freshState = stateView(fixtureState());
freshState.packets[0]!.title = "Fresh recovered fixture data";
const freshFeed = new SnapshotFeed(freshState);
const fresh = new FixtureUi(freshFeed);
const freshLimited = createRateLimitedCapability(fresh, {
  maxConcurrency: 8,
  maxCallsPerMinute: 600,
  maxPendingCalls: 128,
  onRateLimit: "throttle",
  label: "Fixture recovered sidebar",
});
let acquired = 0,
  themes = 0;
let presenting = false;
const presentationCalls: boolean[] = [];
let theme: GatekeeperAppTheme = {
  mode: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  accentColor: null,
};
let themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | undefined;
function evidence() {
  output.textContent = JSON.stringify({
    acquired,
    oldPolls,
    freshCalls: fresh.calls,
    themes,
    presenting,
    presentationCalls,
    hostMode: theme.mode,
    fixture: "offline replacement host capability",
  });
}
class FixtureHost extends RpcTarget {
  get ui() {
    acquired++;
    evidence();
    return recovery && acquired > 1 ? freshLimited.capability : limited.capability;
  }
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>) {
    themeReceiver?.[Symbol.dispose]();
    themeReceiver = receiver.dup();
    themes++;
    evidence();
    return theme;
  }
  openPrompt(prompt: string) {
    output.textContent = `Fixture openPrompt received: ${prompt}`;
  }
  setPresenting(active: boolean) {
    const rect = iframe.getBoundingClientRect().toJSON();
    presentationCalls.push(active);
    presenting = active;
    iframe.style.cssText = active
      ? "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:10"
      : "width:100%;height:100vh;border:0";
    evidence();
    return { rect: active ? rect : null, willResize: true };
  }
}
if (recovery)
  for (const mode of ["light", "dark"] as const) {
    const button = document.createElement("button");
    button.textContent = `Fixture host ${mode} during stall`;
    button.addEventListener("click", () => {
      // Simulate a dropped theme callback; recovery must apply subscribeTheme's current reply.
      theme = { mode, accentColor: null };
      document.documentElement.dataset.mode = mode;
      document.documentElement.style.colorScheme = mode;
      evidence();
    });
    document.body.insertBefore(button, document.getElementById("sidebar"));
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
document.getElementById("sidebar")!.replaceChildren(iframe);
let batches = 0;
const timer = setInterval(() => {
  if (recovery) {
    evidence();
    return;
  }
  batches++;
  state.packets[0]!.title = `Fixture update batch ${batches}`;
  feed.publish(state);
}, 250);
window.addEventListener(
  "pagehide",
  () => {
    clearInterval(timer);
    window.removeEventListener("message", handshake);
    feed.dispose();
    freshFeed.dispose();
    limited.dispose();
    freshLimited.dispose();
    themeReceiver?.[Symbol.dispose]();
    session?.[Symbol.dispose]();
  },
  { once: true },
);
