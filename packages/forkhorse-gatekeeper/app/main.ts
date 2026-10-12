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
    stopSystem();
    applyAppTheme(theme);
  }
}
let stopSystem = followSystemTheme();

interface Host extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  readonly ui: SidebarUi;
  openPrompt(prompt: string): Promise<void>;
}

const root = document.getElementById("sidebar")!;
const status = document.createElement("p");
status.setAttribute("role", "status");
status.hidden = true;
root.before(status);
document.title = brand.name;
const { port1, port2 } = new MessageChannel();
// Matches the pinned OS opaque-origin iframe handshake. Only the private port is transferred.
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const receiver = new ThemeReceiver();
const host = newMessagePortRpcSession<Host>(port1, receiver);
void host
  .subscribeTheme(receiver)
  .then((theme) => receiver.setTheme(theme))
  .catch(() => {});
let dispose = () => {};
let closed = false;
void (async () => {
  try {
    const client = await connectSidebar(await host.ui, (message) => {
      status.textContent = message;
      status.hidden = !message;
    });
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
    root.textContent = "Sidebar connection unavailable. Reopen this app to reconnect.";
  }
})();
window.addEventListener(
  "pagehide",
  () => {
    closed = true;
    stopSystem();
    dispose();
    host[Symbol.dispose]();
    port1.close();
  },
  { once: true },
);
