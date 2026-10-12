import { followSystemTheme } from "./theme.ts";
import { mountDashboard } from "./dashboard.ts";
import { createHttpTransport } from "./transport.ts";
import type { Brand } from "./contracts.ts";
import "./styles.css";

declare const __DASHBOARD_BRAND__: Brand;
document.title = `${__DASHBOARD_BRAND__.name} · Fixture projects`;
mountDashboard(document.getElementById("dashboard")!, {
  brand: __DASHBOARD_BRAND__,
  fixture: true,
  projects: [
    { id: "demo", label: "Demo workspace" },
    { id: "quiet", label: "Quiet project" },
  ],
  transport: createHttpTransport({ origin: location.origin }),
});

const stopTheme = followSystemTheme();
window.addEventListener("pagehide", stopTheme, { once: true });
