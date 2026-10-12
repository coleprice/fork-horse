import { mountDashboard } from "../../forkhorse-dashboard/src/dashboard.ts";
import type { Brand, DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";

/** Presentation never grants owner authority; the agent transport independently refuses writes. */
export function mountSidebar(
  root: HTMLElement,
  options: {
    brand: Brand;
    project: string;
    transport: DashboardTransport;
    openPrompt(prompt: string): Promise<void>;
    fixture?: boolean;
    agent?: string;
  },
) {
  return mountDashboard(root, {
    ...options,
    owner: false,
    projects: [{ id: options.project, label: options.project }],
    initialProject: options.project,
  });
}
