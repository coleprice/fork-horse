import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { SidebarUi } from "../src/ui-types.ts";
import { connectSidebar } from "../src/client.ts";
import { mountSidebar } from "../src/mount.ts";
import brand from "../../../brand.json";
import "../../forkhorse-dashboard/src/styles.css";

import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import { applyAppTheme, followSystemTheme } from "../../forkhorse-dashboard/src/theme.ts";

class ThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme) {
    if (closed) return;
    stopSystem();
    applyAppTheme(theme);
  }
}
const stopSystem = followSystemTheme();

interface Host extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  readonly ui: SidebarUi;
  openPrompt(prompt: string): Promise<void>;
}

const root = document.getElementById("sidebar")!;
document.title = brand.name;
const { port1, port2 } = new MessageChannel();
// Matches the pinned OS opaque-origin iframe handshake. Only the private port is transferred.
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const receiver = new ThemeReceiver();
const host = newMessagePortRpcSession<Host>(port1, receiver);
async function resubscribeTheme() {
  receiver.setTheme(await host.subscribeTheme(receiver));
}
let dispose = () => {};
let closed = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
async function start() {
  try {
    const client = await connectSidebar(
      await host.ui,
      () => {},
      resubscribeTheme,
      async () => await host.ui,
    );
    if (closed) {
      client.dispose();
      return;
    }
    const view = mountSidebar(root, {
      brand,
      project: client.project,
      transport: client.transport,
      fixture: root.dataset.fixture === "true",
      openPrompt: async (prompt) => {
        await host.openPrompt(prompt);
      },
    });
    dispose = () => {
      view.dispose();
      client.dispose();
    };
  } catch {
    if (closed) return;
    // Keep the static content position visible until the first authenticated snapshot arrives.
    const caption = root.querySelector("[role=status]");
    if (caption) caption.textContent = "Live updates paused. Reconnecting…";
    retryTimer = setTimeout(
      () => void start(),
      Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
    );
  }
}
void start();
window.addEventListener(
  "pagehide",
  () => {
    closed = true;
    stopSystem();
    clearTimeout(retryTimer);
    dispose();
    host[Symbol.dispose]();
    port1.close();
  },
  { once: true },
);
