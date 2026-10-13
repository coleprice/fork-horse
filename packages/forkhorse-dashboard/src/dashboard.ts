import type { Brand, DashboardTransport, ProjectOption } from "./contracts.ts";
import { ApiError } from "./transport.ts";
import { assertState, reviewGate, reviewState, type ViewModel } from "./model.ts";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DashboardView, type Section } from "./view.tsx";

export interface DashboardOptions {
  transport: DashboardTransport;
  brand: Brand;
  projects?: ProjectOption[];
  initialProject?: string;
  /** Only the fixture entry sets this. Hosts should leave it false. */
  fixture?: boolean;
  agent?: string;
  owner?: boolean;
  openPrompt?(prompt: string): Promise<void>;
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

  const react = createRoot(root);
  const window = root.ownerDocument.defaultView!;
  const sectionFromHash = (): Section => {
    const hash = window.location.hash.slice(1).split("/")[0];
    if (hash === "race") return "work";
    return ["overview", "work", "review", "agents"].includes(hash) ? (hash as Section) : "overview";
  };
  const reviewFromHash = () => {
    const match = /^#review\/(.+)$/.exec(window.location.hash);
    // Older capability hosts retain the queue; bookmarks must not open a dead-end detail.
    if (match && !options.transport.getReview) {
      try {
        window.history.replaceState(null, "", "#review");
      } catch {
        window.location.hash = "review";
      }
      return undefined;
    }
    try {
      return match ? decodeURIComponent(match[1]) : undefined;
    } catch {
      return undefined;
    }
  };
  const raceFromHash = () => {
    const match = /^#race\/(.+)$/.exec(window.location.hash);
    try {
      return match ? decodeURIComponent(match[1]) : undefined;
    } catch {
      return undefined;
    }
  };
  let selectedRaceId = raceFromHash();
  let section = sectionFromHash();
  let selectedReviewId = reviewFromHash();
  function openReview(id?: string) {
    if (id && !options.transport.getReview) return;
    section = "review";
    selectedReviewId = id;
    selectedRaceId = undefined;
    const hash = id ? `review/${encodeURIComponent(id)}` : "review";
    try {
      window.history.pushState(null, "", `#${hash}`);
    } catch {
      window.location.hash = hash;
    }
    draw();
  }
  function openRace(id?: string) {
    const previous = selectedRaceId;
    section = "work";
    selectedRaceId = id;
    selectedReviewId = undefined;
    const hash = id ? `race/${encodeURIComponent(id)}` : "work";
    try {
      window.history.pushState(null, "", `#${hash}`);
    } catch {
      window.location.hash = hash;
    }
    draw();
    if (!id && previous)
      requestAnimationFrame(() => {
        [...root.querySelectorAll<HTMLElement>("[data-packet-id]")]
          .find((row) => row.dataset.packetId === previous)
          ?.querySelector<HTMLElement>(".packet-link")
          ?.focus();
      });
  }
  function setSection(value: Section) {
    section = value;
    selectedRaceId = undefined;
    selectedReviewId = undefined;
    // srcdoc inherits the OS URL; never let native anchors navigate its frame.
    try {
      window.history.replaceState(null, "", `#${value}`);
    } catch {
      // Opaque srcdoc rejects History API URLs, but same-document fragments are allowed.
      window.location.hash = value;
    }
    draw();
  }
  function onHash() {
    section = sectionFromHash();
    selectedReviewId = reviewFromHash();
    selectedRaceId = raceFromHash();
    draw();
  }
  window.addEventListener("hashchange", onHash);
  window.addEventListener("popstate", onHash);
  function draw() {
    if (disposed) return;
    flushSync(() =>
      react.render(
        createElement(DashboardView, {
          view: { ...view },
          actions: {
            section,
            raceId: selectedRaceId,
            openRace,
            reviewId: selectedReviewId,
            openReview,
            getReview: options.transport.getReview
              ? (id: string) => options.transport.getReview!(view.project, id)
              : undefined,
            getDiff: options.transport.getDiff
              ? (id: string, path: string) => options.transport.getDiff!(view.project, id, path)
              : undefined,
            returnReview:
              options.owner !== false && options.transport.returnReview ? returnReview : undefined,
            setSection,
            selectProject,
            retry: refresh,
            reconnect: options.transport.live?.reconnect,
            owner: options.owner ?? true,
            agent: options.agent,
            ask: options.openPrompt
              ? () =>
                  options.openPrompt!(
                    `Help me review project ${view.project} in ${view.brand.name}.`,
                  )
              : undefined,
            action,
            getReceipt:
              options.owner !== false && options.transport.getReceipt
                ? (review: string) => options.transport.getReceipt!(view.project, review)
                : undefined,
            setSettings:
              options.owner !== false && options.transport.setSettings ? setSettings : undefined,
          },
        }),
      ),
    );
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
      view.updatedAt = new Date().toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
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
    if (options.owner === false && id !== initial) return;
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
        error instanceof Error
          ? error.message
          : "Unable to subscribe to activity. Try reopening the app.";
      draw();
    }
  }

  async function action(kind: "approve" | "promote", reviewId: string) {
    if (options.owner === false || view.busy || !view.state) return false;
    const review = view.state.reviews.find((entry) => entry.id === reviewId);
    if (!review || !reviewGate(review, view.state)[kind]) return false;
    view.busy = true;
    view.error = undefined;
    view.notice = undefined;
    draw();
    let message: string;
    try {
      if (kind === "approve") {
        await options.transport.approve(view.project, review.id);
        message = `Approved ${review.sha.slice(0, 7)}`;
      } else {
        await options.transport.promote(view.project, review.id);
        message = `Promoted to ${view.state.project.defaultBranch}`;
      }
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Owner action failed. Refresh before trying again.";
      // The exact receipt conflict belongs solely to the open Promote dialog.
      const handledReceiptFailure =
        kind === "promote" &&
        view.state?.project.settings?.requireReceipt === true &&
        error instanceof ApiError &&
        error.status === 409 &&
        message === "Checks failed before promote.";
      // No retry: even a connection failure can follow a successful server-side write.
      await load();
      if (handledReceiptFailure) throw error;
      view.error = message;
      draw();
      return false;
    }
    await load();
    view.notice = message;
    view.noticeSha = kind === "approve" ? review.sha.slice(0, 7) : undefined;
    draw();
    if (invalidated) {
      invalidated = false;
      await refresh();
    }
    return true;
  }

  async function returnReview(id: string, reason: string) {
    if (options.owner === false || view.busy || !view.state || !options.transport.returnReview)
      return false;
    const review = view.state.reviews.find((r) => r.id === id);
    const fork = view.state.forks.find((f) => f.repoName === review?.repoName);
    if (
      !review ||
      reviewState(review, view.state).kind !== "current" ||
      review.status === "stale" ||
      review.status === "promoted" ||
      fork?.head !== review.sha ||
      reason.length < 1 ||
      reason.length > 2000
    )
      return false;
    view.busy = true;
    view.notice = undefined;
    draw();
    try {
      await options.transport.returnReview(view.project, id, reason);
    } catch (error) {
      // Refresh reads only: an uncertain write is never retried. Dialog owns its error.
      await load();
      throw error;
    }
    await load();
    view.notice = `Returned to ${review.agent}`;
    view.noticeSha = undefined;
    draw();
    return true;
  }

  async function setSettings(requireReceipt: boolean) {
    if (options.owner === false || view.busy || !options.transport.setSettings || !view.state)
      return;
    view.busy = true;
    view.error = undefined;
    view.notice = undefined;
    draw();
    try {
      await options.transport.setSettings(view.project, { requireReceipt });
      await load();
      view.notice = "Receipt settings updated";
      view.noticeSha = undefined;
    } catch (error) {
      await load();
      view.error =
        error instanceof Error
          ? error.message
          : "Unable to update settings. Refresh and try again.";
    }
    draw();
  }

  const stopLive = options.transport.live?.subscribe((paused) => {
    view.livePaused = paused;
    draw();
  });
  draw();
  if (initial) void selectProject(initial);
  return {
    refresh,
    dispose() {
      disposed = true;
      generation++;
      unsubscribe?.();
      stopLive?.();
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      flushSync(() => react.unmount());
    },
  };
}
