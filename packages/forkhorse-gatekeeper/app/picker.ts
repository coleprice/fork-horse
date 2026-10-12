import { followSystemTheme } from "../../forkhorse-dashboard/src/theme.ts";
import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import "./picker.css";
import { mountForkPicker } from "../../forkhorse-dashboard/src/picker.tsx";
interface Fork {
  url: string;
  repoName: string;
  head: string;
}
interface Host extends RpcTarget {
  gatekeeper: { list(): Promise<Fork[]> };
  getInitialResource(): Promise<{ resourceUrl: string; resourceUrlPattern: string } | null>;
  setSelectionReady(ready: boolean): Promise<void>;
  resize(height: number, layoutHeight: number): Promise<void>;
}
let selected: string | undefined;
let forks: Fork[] = [];
class Picker extends RpcTarget {
  async collectResourceUrl(): Promise<string> {
    if (!selected || !forks.some((f) => f.url === selected))
      throw new Error("Select an agent fork.");
    return selected;
  }
  updateViewport(): void {}
  windowResized(): void {}
}
const channel = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [channel.port2]);
const host = newMessagePortRpcSession<Host>(channel.port1, new Picker());
const root = document.getElementById("sidebar")!;
const picker = mountForkPicker(root, (url) => {
  selected = url;
  picker.render(forks, selected, "Only forks owned by your connected agent are listed.");
  void host.setSelectionReady(forks.some((f) => f.url === selected));
});
picker.render([], undefined, "Loading your forks…", true);
void (async () => {
  await host.setSelectionReady(false);
  forks = await host.gatekeeper.list();
  const initial = await host.getInitialResource();
  if (initial && forks.some((f) => f.url === initial.resourceUrl)) {
    selected = initial.resourceUrl;
    await host.setSelectionReady(true);
  }
  picker.render(
    forks,
    selected,
    forks.length
      ? "Only forks owned by your connected agent are listed."
      : "This agent has no forks yet.",
  );
  await host.resize(300, 300);
})().catch(() => {
  picker.render([], undefined, "Fork discovery unavailable. Reconnect your agent.");
});
window.addEventListener(
  "pagehide",
  () => {
    picker.dispose();
    host[Symbol.dispose]();
    channel.port1.close();
  },
  { once: true },
);

const stopTheme = followSystemTheme();
window.addEventListener("pagehide", stopTheme, { once: true });
