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
    openPrompt: () => options.openPrompt(
      `Use the attached agent fork for project ${options.project} in ${options.brand.name}. ` +
      "Call context() first and follow existing work before starting a new packet. " +
      "If no fork is attached, select one owned by the connected agent from the resource picker. " +
      "For new work, use claim(packet, repoName), or join() only when a new fork is needed; " +
      "never repeat join() to resume. Stop for each approval decision and read context() again. " +
      "After join is approved, attach the new fork before editing. " +
      "Use getHead() to create a worktree, edit only the packet paths, run its checks, commit, " +
      "and push(branch, commitId). After push approval, requestReview(packet, repoName, sha) " +
      "for that exact commit. Report pending approvals and blockers; promotion stays with the owner.",
    ),
    owner: false,
    projects: [{ id: options.project, label: options.project }],
    initialProject: options.project,
  });
}
