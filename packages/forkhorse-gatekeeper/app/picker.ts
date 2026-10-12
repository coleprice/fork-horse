import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import "./configurator.css";
interface Fork { url: string; repoName: string; head: string }
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
    if (!selected || !forks.some(f => f.url === selected)) throw new Error("Select an agent fork.");
    return selected;
  }
  updateViewport(): void {}
  windowResized(): void {}
}
const channel = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [channel.port2]);
const host = newMessagePortRpcSession<Host>(channel.port1, new Picker());
const root = document.getElementById("sidebar")!;
root.innerHTML = '<h1>Select an agent fork</h1><select aria-label="Agent fork"><option value="">Choose a fork</option></select><p role="status">Loading your forks…</p>';
const select = root.querySelector("select")!;
const status = root.querySelector('[role="status"]')!;
select.addEventListener("change", () => {
  selected = select.value;
  void host.setSelectionReady(forks.some(f => f.url === selected));
});
void (async () => {
  await host.setSelectionReady(false);
  forks = await host.gatekeeper.list();
  for (const fork of forks) {
    const option = document.createElement("option");
    option.value = fork.url; option.textContent = `${fork.repoName} · ${fork.head.slice(0, 12)}`;
    select.append(option);
  }
  const initial = await host.getInitialResource();
  if (initial && forks.some(f => f.url === initial.resourceUrl)) {
    selected = initial.resourceUrl;
    select.value = selected;
    await host.setSelectionReady(true);
  }
  status.textContent = forks.length ? "Only forks owned by your connected agent are listed." : "This agent has no forks yet.";
  await host.resize(300, 300);
})().catch(() => { status.textContent = "Fork discovery unavailable. Reconnect your agent."; });
window.addEventListener("pagehide", () => { host[Symbol.dispose](); channel.port1.close(); }, { once: true });
