import { mountDashboard } from "../../forkhorse-dashboard/src/dashboard.ts";
import type { Brand, DashboardTransport } from "../../forkhorse-dashboard/src/contracts.ts";
import { OWNER_UNAVAILABLE } from "./client.ts";

/** Reuses the accepted dashboard unchanged. Transport also rejects all owner actions. */
export function mountSidebar(root: HTMLElement, options: {
  brand: Brand;
  project: string;
  transport: DashboardTransport;
  openPrompt(prompt: string): Promise<void>;
  fixture?: boolean;
}) {
  const document = root.ownerDocument;
  const note = document.createElement("p");
  note.textContent = `${OWNER_UNAVAILABLE} Git pushes require approval on the connected fork.`;
  note.setAttribute("role", "note");
  const ask = document.createElement("button");
  ask.textContent = "Ask an agent";
  ask.type = "button";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const dashboard = document.createElement("div");
  root.replaceChildren(note, ask, status, dashboard);

  const ownerButton = 'button[data-action="approve"], button[data-action="promote"]';
  // Capture stops programmatic/early clicks before the observer can disable a fresh render.
  const blockOwnerAction = (event: Event) => {
    if ((event.target as Element).closest(ownerButton)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  dashboard.addEventListener("click", blockOwnerAction, true);
  // srcdoc inherits the parent's base URL: native hash navigation would load the OS
  // route inside this sandbox. Keep dashboard section links within the document.
  const navigateSection = (event: Event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    const section = document.getElementById(link.getAttribute("href")!.slice(1));
    if (section && dashboard.contains(section)) section.scrollIntoView({ block: "start" });
  };
  dashboard.addEventListener("click", navigateSection);
  const observer = new document.defaultView!.MutationObserver(() => {
    observer.disconnect();
    for (const button of dashboard.querySelectorAll<HTMLButtonElement>(ownerButton)) {
      button.disabled = true;
      button.title = OWNER_UNAVAILABLE;
    }
    const label = (selector: string, text: string) => {
      const element = dashboard.querySelector(selector);
      if (element) element.textContent = text;
    };
    label(".brand small", "Agent sidebar");
    label(".session", options.fixture ? "◌ Local fixture session" : "◌ Enrolled agent session");
    label(".topbar > .badge", options.fixture ? "FIXTURE · OFFLINE" : "AGENT SESSION");
    label(".fixture-banner", "Local fixture snapshots only. Owner actions are unavailable.");
    const footer = dashboard.querySelector("footer")?.firstChild;
    if (footer) footer.textContent = options.fixture
      ? "Fixture evidence only · no live deployment"
      : "Read-only agent connection · owner actions unavailable";
    // This capability is bound to one project; a different project needs a separate connection.
    const picker = dashboard.querySelector<HTMLSelectElement>("#project");
    if (picker) picker.disabled = true;
    const form = dashboard.querySelector<HTMLElement>("#open-project");
    if (form) form.hidden = true;
    observer.observe(dashboard, { childList: true, subtree: true });
  });
  observer.observe(dashboard, { childList: true, subtree: true });
  const view = mountDashboard(dashboard, {
    brand: options.brand,
    projects: [{ id: options.project, label: options.project }],
    initialProject: options.project,
    transport: options.transport,
    fixture: options.fixture,
  });
  let disposed = false;
  const onAsk = async () => {
    if (ask.disabled) return;
    ask.disabled = true;
    try {
      await options.openPrompt(`Help me review project ${options.project} in ${options.brand.name}.`);
    } catch {
      if (!disposed) status.textContent = "Unable to open the agent prompt. Try again.";
    } finally {
      if (!disposed) ask.disabled = false;
    }
  };
  ask.addEventListener("click", onAsk);
  return {
    dispose() {
      disposed = true;
      observer.disconnect();
      view.dispose();
      dashboard.removeEventListener("click", blockOwnerAction, true);
      dashboard.removeEventListener("click", navigateSection);
      ask.removeEventListener("click", onAsk);
      root.replaceChildren();
    },
  };
}
