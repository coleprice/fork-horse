import type { Brand, DashboardTransport, ProjectOption } from "./contracts.ts";
import { assertState, reviewGate, type ViewModel } from "./model.ts";
import { renderDashboard } from "./render.ts";

export interface DashboardOptions {
  transport: DashboardTransport;
  brand: Brand;
  projects?: ProjectOption[];
  initialProject?: string;
  /** Only the fixture entry sets this. Hosts should leave it false. */
  fixture?: boolean;
}

/** The same view mounts in the web shell, sidebar app or gadget with a host transport. */
export function mountDashboard(
  root: HTMLElement,
  options: DashboardOptions,
): { refresh(): Promise<void>; dispose(): void } {
  const projects = [...(options.projects ?? [])];
  const initial = options.initialProject ?? projects[0]?.id ?? "";
  if (initial && !projects.some((project) => project.id === initial))
    projects.push({ id: initial, label: initial });
  const view: ViewModel = {
    brand: options.brand,
    projects,
    project: initial,
    fixture: options.fixture ?? false,
    activity: [],
    busy: false,
  };
  let generation = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let invalidated = false;

  function draw() {
    if (disposed) return;
    const focus = root.ownerDocument.activeElement as HTMLElement | null;
    const key = focus?.dataset.action;
    const review = focus?.dataset.review;
    root.innerHTML = renderDashboard(view);
    if (key)
      Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action]"))
        .find((button) => button.dataset.action === key && button.dataset.review === review)
        ?.focus();
  }

  async function load() {
    const current = ++generation;
    view.busy = true;
    view.error = undefined;
    draw();
    try {
      const state = await options.transport.getState(view.project);
      const recent = state.recentActivity ?? [];
      const activity = await options.transport.getActivity(
        view.project,
        recent.at(-1)?.sequence ?? 0,
      );
      assertState(state);
      if (state.project.id !== view.project)
        throw new Error("The API returned a different project. Check the host adapter.");
      if (!Array.isArray(activity.activity) || !Number.isSafeInteger(activity.nextAfter))
        throw new Error("Invalid activity response.");
      if (current !== generation || disposed) return;
      view.state = state;
      view.activity = [
        ...new Map(
          [...recent, ...activity.activity].map((entry) => [entry.sequence, entry]),
        ).values(),
      ]
        .toSorted((a, b) => a.sequence - b.sequence)
        .slice(-100);
      view.updatedAt = new Date().toLocaleTimeString();
    } catch (error) {
      if (current !== generation || disposed) return;
      view.error = error instanceof Error ? error.message : "Unable to load this project.";
      // A failed refresh must not leave actionable approvals from an older snapshot.
      view.state = undefined;
      view.activity = [];
    } finally {
      if (current === generation && !disposed) {
        view.busy = false;
        draw();
      }
    }
  }

  async function refresh() {
    if (disposed || !view.project || view.busy) return;
    view.notice = undefined;
    await load();
    if (invalidated) {
      invalidated = false;
      await refresh();
    }
  }

  async function selectProject(id: string) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 48) {
      view.error =
        "Project IDs use lowercase letters, digits and internal hyphens (maximum 48 characters).";
      draw();
      return;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    if (!view.projects.some((project) => project.id === id)) view.projects.push({ id, label: id });
    view.project = id;
    view.state = undefined;
    view.activity = [];
    view.notice = undefined;
    invalidated = false;
    await load();
    if (disposed) return;
    try {
      unsubscribe = options.transport.subscribe?.(id, () => {
        if (view.busy) invalidated = true;
        else void refresh();
      });
    } catch (error) {
      view.error =
        error instanceof Error ? error.message : "Unable to subscribe to activity. Use Refresh.";
      draw();
    }
  }

  async function action(kind: "approve" | "promote", reviewId: string) {
    if (view.busy || !view.state) return;
    const review = view.state.reviews.find((entry) => entry.id === reviewId);
    if (!review || !reviewGate(review, view.state)[kind]) return;
    view.busy = true;
    view.error = undefined;
    view.notice = undefined;
    draw();
    let message: string;
    try {
      if (kind === "approve") {
        await options.transport.approve(view.project, review.id);
        message = `Approved ${review.packet} at ${review.sha.slice(0, 10)}. The server binds the receipt digest.`;
      } else {
        const result = await options.transport.promote(view.project, review.id);
        message = `Promoted ${review.packet} at ${result.sha.slice(0, 10)}.`;
      }
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Owner action failed. Refresh before trying again.";
      // No retry: even a connection failure can follow a successful server-side write.
      await load();
      view.error = message;
      draw();
      return;
    }
    await load();
    view.notice = message;
    draw();
    if (invalidated) {
      invalidated = false;
      await refresh();
    }
  }

  function onClick(event: Event) {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button || !root.contains(button) || button.disabled) return;
    const kind = button.dataset.action;
    if (kind === "refresh") void refresh();
    if ((kind === "approve" || kind === "promote") && button.dataset.review)
      void action(kind, button.dataset.review);
  }
  function onChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    if (target.id === "project" && !view.busy) void selectProject(target.value);
  }
  function onSubmit(event: Event) {
    const form = event.target as HTMLFormElement;
    if (form.id !== "open-project") return;
    event.preventDefault();
    if (!view.busy) void selectProject(String(new FormData(form).get("project") ?? ""));
  }
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  draw();
  if (initial) void selectProject(initial);
  return {
    refresh,
    dispose() {
      disposed = true;
      generation++;
      unsubscribe?.();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("submit", onSubmit);
      root.replaceChildren();
    },
  };
}
