import { applyAppTheme, followSystemTheme } from "./theme.ts";
import { mountDashboard } from "./dashboard.ts";
import { createHttpTransport } from "./transport.ts";
import type { Brand } from "./contracts.ts";
import "./styles.css";
import themeFixture from "../test/theme-fixture.json";

declare const __DASHBOARD_BRAND__: Brand;
document.title = `${__DASHBOARD_BRAND__.name} · Fixture projects`;
mountDashboard(document.getElementById("dashboard")!, {
  brand: __DASHBOARD_BRAND__,
  fixture: true,
  async openPrompt(prompt) {
    document.getElementById("fixture-prompt")!.textContent =
      `Fixture prompt received (not sent): ${prompt}`;
  },
  initialProject: new URL(location.href).searchParams.get("scenario") ?? "demo",
  projects: [
    { id: "demo", label: "Demo workspace" },
    { id: "quiet", label: "Quiet project" },
    ...["large", "first", "partial", "deleted", "error", "loading"].map((id) => ({
      id,
      label: `${id} fixture`,
    })),
  ],
  transport: createHttpTransport({ origin: location.origin }),
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
document.body.append(controls);
