// Labeled offline shell: the sandbox host, default limiter and navigation are unmodified OS code.
// External identity/state are fixtures; no inference, cloud login or remote service is used.
import React from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, useRouterState } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import SandboxedGatekeeperApp from "../../../../cloudflare-os/packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx";
import { ThemeProvider } from "../../../../cloudflare-os/packages/workshop-frontend/src/ThemeContext.tsx";
import { AuthProvider } from "../../../../cloudflare-os/packages/workshop-frontend/src/AuthContext.tsx";
import { fixtureState } from "../../../forkhorse-dashboard/test/fixtures.ts";
import { stateView } from "../../../forkhorse-dashboard/src/model.ts";
import { SnapshotFeed } from "../../src/feed.ts";
import { FixtureUi } from "../fixture-ui.ts";
const state = stateView(fixtureState());
const feed = new SnapshotFeed(state);
const ui = new FixtureUi(feed);
const response = await fetch("/dist/sidebar.html");
const frame = { iframeHtml: (await response.text()).replace('<div id="sidebar">', '<div id="sidebar" data-fixture="true">'), ui: new RpcStub(ui) };
const api = {
  async whoami() { return { type: "user", id: "fixture@idiot.tax", name: "Local Fixture" }; },
  async amIAdmin() { return false; }, async listGadgets() { return []; },
};
let batches = 0;
const started = performance.now();
const timer = setInterval(() => {
  batches++;
  state.packets[0]!.title = `Fixture update batch ${batches}`;
  feed.publish(state);
  document.getElementById("evidence")!.textContent = JSON.stringify({ batches, inboundCalls: ui.calls, seconds: Math.round((performance.now() - started) / 1000), host: "Pinned SandboxedGatekeeperApp", limits: "8 concurrent / 600 per minute / 128 pending" });
}, 250);
function Shell() {
  const search = useRouterState({ select: (s) => s.location.search }) as { prompt?: string };
  return <ThemeProvider><AuthProvider authenticatedApi={api as never} onLogout={() => {}}>
    <header style={{padding: "12px", font: "14px system-ui"}}><b>LOCAL ACCEPTANCE FIXTURE — external identity and state are synthetic</b><div id="evidence" /><div role="status">{search.prompt ? `OS openPrompt navigation: ${search.prompt}` : "Ask an agent should navigate through the OS host to a prompt."}</div></header>
    <div style={{height: "85vh"}}><SandboxedGatekeeperApp frame={frame as never} gatekeeperVendorId="forkhorse" /></div>
  </AuthProvider></ThemeProvider>;
}
const rootRoute = createRootRoute({ component: Shell });
const index = createRoute({ getParentRoute: () => rootRoute, path: "/", validateSearch: (search) => ({ prompt: typeof search.prompt === "string" ? search.prompt : undefined }) });
const router = createRouter({ routeTree: rootRoute.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
window.addEventListener("pagehide", () => { clearInterval(timer); feed.dispose(); frame.ui[Symbol.dispose](); }, { once: true });
