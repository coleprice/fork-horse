import { mountSidebar } from "../src/mount.ts";
import { mountDashboard } from "../../forkhorse-dashboard/src/dashboard.ts";
import { stateView } from "../../forkhorse-dashboard/src/model.ts";
import { fixtureState } from "../../forkhorse-dashboard/test/fixtures.ts";
import "../../forkhorse-dashboard/src/styles.css";

// Labeled DOM/geometry fixture. The separate opaque-frame fixture uses the built app's RPC.
const params = new URL(location.href).searchParams;
const root = document.getElementById("sidebar")!;
const evidence = document.getElementById("evidence")!;
const calls: boolean[] = [];
let clipboard = "";
function report() {
  evidence.textContent = JSON.stringify({ fixture: "offline synthetic host and clipboard", calls, clipboard });
}
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  async writeText(text: string) {
    if (params.get("clipboard") === "denied") throw new Error("Fixture clipboard denial");
    clipboard = text;
    report();
  },
} });
const options = {
  brand: { name: "Fixture product", tagline: "Fixture collaboration" },
  project: "demo", coreOrigin: "https://core.fixture.idiot.tax", fixture: true,
  openPrompt: async () => {},
  setPresenting: params.get("presentation") === "off" ? undefined : async (active: boolean) => {
    calls.push(active);
    report();
    if (active && params.get("presentation") === "reject") throw new Error("Fixture host rejection");
    const rect = root.getBoundingClientRect().toJSON();
    root.style.cssText = active ? "position:fixed;inset:0;overflow:auto;z-index:10" : "";
    return { rect: active ? rect : null, willResize: true };
  },
  transport: {
    getState: async () => stateView(fixtureState()),
    getActivity: async () => ({ activity: [], nextAfter: 0 }),
    approve: async () => { throw new Error("Fixture forbids writes"); },
    promote: async () => { throw new Error("Fixture forbids writes"); },
  },
};
const view = params.get("role") === "owner"
  ? mountDashboard(root, { ...options, owner: true, initialProject: "demo" })
  : mountSidebar(root, options);
report();
window.addEventListener("pagehide", () => view.dispose(), { once: true });
