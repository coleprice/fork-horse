import { raceScenarios } from "../test/race-fixtures.ts";
import { needsScenarios } from "../test/needs-you-fixtures.ts";
import { reviewScenarios } from "../test/review-fixtures.ts";
import { applyAppTheme, followSystemTheme } from "./theme.ts";
import { mountDashboard } from "./dashboard.ts";
import { createHttpTransport } from "./transport.ts";
import type { Brand } from "./contracts.ts";
import "./styles.css";
import themeFixture from "../test/theme-fixture.json";

declare const __DASHBOARD_BRAND__: Brand;
document.title = `${__DASHBOARD_BRAND__.name} · Fixture projects`;
let paused = new URL(location.href).searchParams.get("scenario") === "paused";
const statusListeners = new Set<(paused: boolean) => void>();
const fixtureTransport = createHttpTransport({ origin: location.origin });
// Labeled fixture for capability hosts that support queue/receipts but not detail reads.
if (new URL(location.href).searchParams.get("host") === "queue-only") {
  delete fixtureTransport.getReview;
  delete fixtureTransport.getDiff;
}
fixtureTransport.live = {
  subscribe(listener) {
    statusListeners.add(listener);
    listener(paused);
    return () => statusListeners.delete(listener);
  },
  async reconnect() {
    paused = false;
    for (const listener of statusListeners) listener(false);
  },
};
mountDashboard(document.getElementById("dashboard")!, {
  brand: __DASHBOARD_BRAND__,
  fixture: true,
  owner: new URL(location.href).searchParams.get("role") !== "agent",
  agent: "fixture-agent",
  async openPrompt(prompt) {
    document.getElementById("fixture-prompt")!.textContent =
      `Fixture prompt received (not sent): ${prompt}`;
  },
  initialProject: new URL(location.href).searchParams.get("scenario") ?? "demo",
  projects: [
    { id: "demo", label: "Demo workspace" },
    { id: "quiet", label: "Quiet project" },
    ...[
      ...raceScenarios,
      ...reviewScenarios,
      ...needsScenarios,
      "large",
      "first",
      "partial",
      "truncated",
      "superseded",
      "paused",
      "deleted",
      "error",
      "loading",
      "receipts",
      "advisory",
      "recheck",
      "rerun-failed",
      "gating-recheck",
      "history-required",
      "history-advisory",
    ].map((id) => ({
      id,
      label: `${id} fixture`,
    })),
  ],
  transport: fixtureTransport,
});

const stopTheme = followSystemTheme();
window.addEventListener("pagehide", stopTheme, { once: true });

// Explicitly labeled fixture controls exercise the same host theme application function.
const controls = document.createElement("div");
controls.setAttribute("aria-label", "Fixture theme harness");
controls.className = "fixture-theme-controls";
controls.style.cssText = "position:fixed;bottom:0;left:0;z-index:30;display:flex;gap:12px";
const prompt = document.createElement("p");
prompt.id = "fixture-prompt";
controls.append(prompt);
for (const mode of ["light", "dark"] as const) {
  const button = document.createElement("button");
  button.textContent = `Fixture ${mode}`;
  button.addEventListener("click", () => {
    stopTheme();
    applyAppTheme({ mode, accentColor: null });
  });
  controls.append(button);
}
const accent = document.createElement("button");
accent.textContent = "Fixture blue accent";
accent.addEventListener("click", () => {
  stopTheme();
  applyAppTheme({ mode: "light", accentColor: themeFixture.accent });
});
controls.append(accent);
// Capture controls can be hidden through the fixture UI so they never cover evidence.
const hide = document.createElement("button");
hide.textContent = "Hide fixture controls";
hide.addEventListener("click", () => controls.remove());
controls.append(hide);
document.body.append(controls);
