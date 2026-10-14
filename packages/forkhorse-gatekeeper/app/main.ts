import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { SidebarUi } from "../src/ui-types.ts";
import { connectSidebar } from "../src/client.ts";
import { hostConnection } from "../src/host-connection.ts";
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
  setPresenting(active: boolean): Promise<{ rect: unknown; willResize: boolean }>;
}

const root = document.getElementById("sidebar")!;
document.title = brand.name;
const receiver = new ThemeReceiver();
const connection = hostConnection(() => {
  const { port1, port2 } = new MessageChannel();
  const host = newMessagePortRpcSession<Host>(port1, receiver);
  // Only renew after the previous host getter failed; never re-handshake a healthy host.
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  // Restore even if the first project snapshot cannot be acquired after a frame reconnect.
  void host.setPresenting(false).catch(() => {});
  return {
    host,
    dispose() {
      void host.setPresenting(false).catch(() => {});
      host[Symbol.dispose]();
      port1.close();
    },
  };
});
async function resubscribeTheme(isCurrent: () => boolean) {
  // Every fresh UI capability starts in its normal pane, even when the host port survives.
  resetPresentation();
  if (!isCurrent()) return;
  const theme = await connection.host.subscribeTheme(receiver);
  if (isCurrent()) receiver.setTheme(theme);
}
let dispose = () => {};
let resetPresentation = () => {};
let closed = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
async function start() {
  try {
    const client = await connectSidebar(
      await connection.acquireUi(),
      () => {},
      resubscribeTheme,
      (isCurrent) => connection.acquireUi(isCurrent),
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
      coreOrigin: root.dataset.coreOrigin,
      setPresenting: async (active) => connection.host.setPresenting(active),
      openPrompt: async (prompt) => {
        await connection.host.openPrompt(prompt);
      },
    });
    resetPresentation = () => view.resetPresentation();
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
    connection.dispose();
  },
  { once: true },
);
