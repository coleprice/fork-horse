import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardView } from "./view.tsx";
import type { ViewModel } from "./model.ts";

/** Static test projection uses the same real components as the browser. React escapes all text. */
export function renderDashboard(view: ViewModel): string {
  return renderToStaticMarkup(
    createElement(DashboardView, {
      view,
      actions: {
        section: "overview",
        owner: true,
        async selectProject() {},
        setSection() {},
        async action() {},
      },
    }),
  );
}
