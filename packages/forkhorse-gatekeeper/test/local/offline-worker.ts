// ONLY for an isolated run-local copy. Never deploy this entrypoint: Core identity and state
// are synthetic, and every other outbound request is refused. Production builds exclude it.
import { fixtureState } from "../../../forkhorse-dashboard/test/fixtures.ts";
import worker from "../../src/worker/index.ts";
export { GatekeeperVendor, UserAccount, AgentAccount, AgentVerifier, ForkGatekeeper } from "../../src/worker/index.ts";
const started = Date.now();
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  // Enabled only by the isolated full-OS test build. The fixture listener is loopback-only.
  if (import.meta.env.MODE === "full-os") {
    if (!["https://core.fixture.idiot.tax", "https://git.fixture.idiot.tax"].includes(url.origin)) {
      throw new Error("This local fixture refuses external traffic.");
    }
    return networkFetch(new Request(`http://127.0.0.1:4181${url.pathname}`, request));
  }
  if (url.origin !== "https://core.fixture.idiot.tax" || request.headers.get("authorization") !== "Bearer fixture-agent-credential-only") {
    throw new Error("This local fixture refuses external traffic.");
  }
  if (url.pathname === "/projects/fixture/me") return Response.json({ role: "agent", agent: "local-fixture", forks: [{ repoName: "fork-alpha", remote: "https://git.fixture.idiot.tax/fork-alpha.git", head: "a".repeat(40), createdAt: "2026-01-01T00:00:00Z" }] });
  if (url.pathname === "/projects/fixture/state") {
    const state = fixtureState(); state.project.id = "fixture";
    state.packets[0].title = `LOCAL FIXTURE batch ${Math.floor((Date.now() - started) / 250)}`;
    state.packets[0].goal = "Synthetic Core snapshots in the pinned local OS. No live data or inference.";
    return Response.json(state);
  }
  throw new Error("Unsupported local fixture request.");
};
export default worker;
