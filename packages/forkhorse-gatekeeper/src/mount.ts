import { mountDashboard } from "../../forkhorse-dashboard/src/dashboard.ts";
import type { Brand, DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";
import type { FramePresentation } from "../../forkhorse-dashboard/src/view.tsx";
import { publicCoreOrigin } from "../app/owner-origin.ts";

type SetPresenting = (active: boolean) => Promise<{ rect: unknown; willResize: boolean }>;

/** Like the pinned Context Library, retire stale acknowledgements before restoring the host. */
export function framePresentation(setPresenting: SetPresenting): FramePresentation & { dispose(): void } {
  let expanded = false;
  let disposed = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  async function restore() {
    try { await setPresenting(false); } catch { /* A retired host may already be disconnected. */ }
  }
  async function request(active: boolean) {
    if (disposed) return;
    const current = ++epoch;
    expanded = active;
    publish();
    try {
      await setPresenting(active);
      // An opening acknowledgement can arrive after reconnect or unmount. Never resurrect it.
      if (current !== epoch && active && !expanded) await restore();
    } catch {
      if (current !== epoch) return;
      expanded = false;
      publish();
      console.warn("Frame presentation unavailable.");
      if (active) await restore();
    }
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => expanded,
    toggle: () => { void request(!expanded); },
    reset: () => { void request(false); },
    dispose() {
      if (disposed) return;
      void request(false);
      disposed = true;
      epoch++;
      listeners.clear();
    },
  };
}

/** Missing or malformed host metadata must never produce a guessed owner address. */
export function ownerLink(coreOrigin: string | undefined, project: string): string | undefined {
  const origin = publicCoreOrigin(coreOrigin);
  if (!origin || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project) || project.length > 48) return;
  return `${origin}/app?project=${encodeURIComponent(project)}`;
}

/** Presentation never grants owner authority; the agent transport independently refuses writes. */
export function mountSidebar(
  root: HTMLElement,
  options: {
    brand: Brand;
    project: string;
    transport: DashboardTransport;
    openPrompt(prompt: string): Promise<void>;
    setPresenting?: SetPresenting;
    coreOrigin?: string;
    fixture?: boolean;
    agent?: string;
  },
) {
  const presentation = options.setPresenting ? framePresentation(options.setPresenting) : undefined;
  const view = mountDashboard(root, {
    ...options,
    framePresentation: presentation,
    ownerLink: ownerLink(options.coreOrigin, options.project),
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
  let disposed = false;
  return {
    ...view,
    resetPresentation() { presentation?.reset(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      presentation?.dispose();
      view.dispose();
    },
  };
}
