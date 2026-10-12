import { mountDashboard } from "./dashboard.ts";
import { createHttpTransport } from "./transport.ts";
import type { Brand, ProjectOption } from "./contracts.ts";
import "./styles.css";

declare const __DASHBOARD_BRAND__: Brand;

// FH-012 may embed an inert JSON config block containing project IDs/labels only.
const configElement = document.getElementById("dashboard-config");
const config = configElement
  ? (JSON.parse(configElement.textContent ?? "{}") as { projects?: ProjectOption[] })
  : {};
const root = document.getElementById("dashboard")!;
document.title = `${__DASHBOARD_BRAND__.name} · Projects`;
mountDashboard(root, {
  brand: __DASHBOARD_BRAND__,
  projects: config.projects,
  initialProject: new URLSearchParams(location.search).get("project") ?? undefined,
  transport: createHttpTransport({ origin: location.origin }),
});
