import { installDom } from "./dom.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mountDashboard } from "../src/dashboard.ts";
import { createHttpTransport } from "../src/transport.ts";
import {
  canArchive,
  recentReceipts,
  reviewQueue,
  reviewState,
  stateView,
  workPackets,
} from "../src/model.ts";
import { ownerNeeds } from "../src/needs-you-model.ts";
import { archiveFixtureState, archiveRace } from "./archive-fixtures.ts";
import { reviewFixtureDetail } from "./review-fixtures.ts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const brand = { name: "Fixture product", tagline: "Fixture" };
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Archive DOM did not settle");
}
function setup(id = "archive-ready", owner = true, failure = 0, hash = "#work") {
  const dom = new JSDOM('<div id="dashboard"></div>', { url: `https://fixture.idiot.tax/${hash}` });
  installDom(dom.window);
  const root = dom.window.document.getElementById("dashboard") as HTMLElement;
  const state = archiveFixtureState(id);
  const calls: string[] = [];
  const transport = createHttpTransport({
    origin: dom.window.location.origin,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/state")) return Response.json(state);
      if (path.endsWith("/activity"))
        return Response.json({ activity: state.activity, nextAfter: 0 });
      if (path.endsWith("/reviews/review-1")) return Response.json(reviewFixtureDetail(state));
      if (/\/(unarchive|archive)$/.test(path)) {
        if (failure === 409) state.races = [archiveRace()];
        if (failure === 404) state.packets = state.packets.filter((p) => p.id !== "FH-040");
        if (failure)
          return Response.json({ error: "Raw server error forbidden" }, { status: failure });
        const packet = state.packets[0];
        packet.archived = path.endsWith("/unarchive")
          ? null
          : { at: "2026-10-13T15:00:00Z", by: "owner" };
        return Response.json({ packet });
      }
      return Response.json({ error: "Missing fixture" }, { status: 404 });
    },
  });
  const app = mountDashboard(root, { brand, transport, initialProject: id, fixture: true, owner });
  const button = (action: string) =>
    root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  async function open() {
    await until(() => !!root.querySelector("#packets .packet-link"));
    root.querySelector<HTMLButtonElement>("#packets .packet-link")!.click();
    if (state.packets[0].mode === "race" && !state.packets[0].archived) {
      await until(() => [...root.querySelectorAll("button")]
        .some((entry) => entry.textContent === "Packet details"));
      [...root.querySelectorAll<HTMLButtonElement>("button")]
        .find((entry) => entry.textContent === "Packet details")!.click();
    }
    await until(() => !!root.querySelector(".archive-heading"));
  }
  return {
    dom,
    root,
    state,
    calls,
    app,
    button,
    open,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}

test("archive predicate mirrors raw core review, claim, race and both blocker identities", () => {
  for (const id of [
    "archive-claim",
    "archive-race",
    "archive-review",
    "archive-main-moved",
    "archive-blocker",
  ]) {
    const state = stateView(archiveFixtureState(id));
    assert.equal(canArchive(state, "FH-040"), false, id);
    if (id === "archive-main-moved")
      assert.equal(reviewState(state.reviews[0], state).kind, "main-moved");
  }
  const wire = archiveFixtureState();
  const r = wire.reviews[0];
  const projected = stateView(wire);
  delete projected.reviews[0].promoted;
  assert.equal(projected.reviews[0].status, "promoted");
  assert.equal(canArchive(projected, "FH-040"), false, "display promoted cannot close a raw-open review");
  r.promoted = false;
  r.approval = { sha: "9".repeat(40), receiptDigest: null };
  assert.equal(stateView(wire).reviews[0].status, "stale");
  assert.equal(canArchive(stateView(wire), "FH-040"), false, "display stale is still raw-open");
  r.stale = true;
  assert.equal(canArchive(stateView(wire), "FH-040"), true);
  r.stale = false;
  r.returned = { reason: "Try again", at: "2026-10-13T14:00:00Z" };
  assert.equal(canArchive(stateView(wire), "FH-040"), true);
  wire.races = [archiveRace("2026-10-13T14:00:00Z")];
  assert.equal(canArchive(stateView(wire), "FH-040"), true);
  assert.equal(canArchive(stateView(wire), "FH-READY"), true, "never started");
  const blockerWire = archiveFixtureState("archive-blocker");
  assert.equal(canArchive(stateView(blockerWire), "FH-READY"), false);
  delete blockerWire.blockers[0].resolved;
  assert.equal(canArchive(stateView(blockerWire), "FH-040"), false, "legacy blocker stays open");
  blockerWire.blockers[0].resolved = { at: "2026-10-13T14:00:00Z", by: "owner" };
  assert.equal(canArchive(stateView(blockerWire), "FH-040"), true);
});

test("archive filters Work, Review and Needs you but preserves receipts, ledger and activity", () => {
  const wire = archiveFixtureState("archive-list");
  const review = wire.reviews[0];
  review.promoted = false;
  review.returned = { reason: "History", at: "2026-10-13T14:00:00Z" };
  const state = stateView(wire);
  assert.equal(reviewQueue(state).length, 0);
  assert.equal(ownerNeeds(state, brand).length, 0);
  assert.deepEqual(
    workPackets(state).map((p) => p.id),
    ["FH-READY"],
  );
  assert.equal(recentReceipts(state).length, 1);
  assert.deepEqual(
    state.ledger.map((entry) => entry.sha),
    wire.ledger.map((entry) => entry.after),
  );
  assert.deepEqual(state.recentActivity, wire.activity);
  state.packets.push({
    ...state.packets[0],
    id: "older",
    archived: { at: "2026-10-12T14:00:00Z", by: "owner" },
  });
  assert.deepEqual(
    workPackets(state, true).map((p) => p.id),
    ["FH-READY", "FH-040", "older"],
  );
  delete wire.packets[0].archived;
  assert.equal(stateView(wire).packets[0].archived, null);
});

test("owner archives in the panel, retains focus, toggles neutral rows and undoes once", async () => {
  const c = setup();
  try {
    await c.open();
    const history = structuredClone({
      reviews: c.state.reviews,
      ledger: c.state.ledger,
      activity: c.state.activity,
    });
    c.button("archive")!.focus();
    c.button("archive")!.click();
    c.button("archive")?.click();
    await until(() => !!c.button("unarchive"));
    assert.equal(c.dom.window.document.activeElement, c.button("unarchive"));
    await until(() => c.dom.window.document.body.textContent.includes("Archived FH-040"));
    assert.match(c.root.querySelector("#activity-panel")!.textContent!, /Archived .* by you/);
    assert.equal(c.root.querySelectorAll("#packets tbody tr").length, 1);
    assert.deepEqual(
      { reviews: c.state.reviews, ledger: c.state.ledger, activity: c.state.activity },
      history,
    );
    assert.equal(c.root.querySelector(".metrics h3")!.textContent, "1");
    assert.equal(c.calls.filter((p) => p.startsWith("POST")).length, 1);
    c.button("toggle-archived")!.click();
    await until(() => c.root.querySelectorAll("#packets tbody tr").length === 2);
    assert.equal(c.button("toggle-archived")!.getAttribute("aria-pressed"), "true");
    const archivedRow = [...c.root.querySelectorAll("#packets tbody tr")].at(-1)!;
    assert.match(archivedRow.textContent!, /FH-040.*Archived/);
    assert.equal(archivedRow.querySelector(".status-dot"), null);
    assert.match(c.root.textContent!, /1 archived packets shown/);
    c.button("toggle-archived")!.click();
    await until(() => c.root.querySelectorAll("#packets tbody tr").length === 1);
    c.button("unarchive")!.click();
    await until(() => !!c.button("archive"));
    assert.equal(c.dom.window.document.activeElement, c.button("archive"));
    assert.equal(c.root.querySelectorAll("#packets tbody tr").length, 2);
    assert.equal(c.button("toggle-archived"), null);
    await until(() => c.dom.window.document.body.textContent.includes("Unarchived FH-040"));
  } finally {
    c.close();
  }
});

test("agents get the archived toggle and caption without archive or unarchive controls", async () => {
  for (const id of ["archive-ready", "archive-list"]) {
    const c = setup(id, false);
    try {
      if (id === "archive-list") {
        await until(() => !!c.button("toggle-archived"));
        c.button("toggle-archived")!.click();
        await until(() => c.root.querySelectorAll("#packets .packet-link").length === 2);
        [...c.root.querySelectorAll<HTMLButtonElement>("#packets .packet-link")].at(-1)!.click();
        await until(() => !!c.root.querySelector(".archive-heading"));
        assert.match(c.root.querySelector("#activity-panel")!.textContent!, /by the owner/);
      } else await c.open();
      assert.equal(c.button("archive"), null);
      assert.equal(c.button("unarchive"), null);
      assert.equal(c.calls.filter((p) => p.startsWith("POST")).length, 0);
    } finally {
      c.close();
    }
  }
});

test("all in-flight states hide panel Archive", async () => {
  for (const id of [
    "archive-claim",
    "archive-race",
    "archive-review",
    "archive-main-moved",
    "archive-blocker",
  ]) {
    const c = setup(id);
    try {
      await c.open();
      assert.equal(c.button("archive"), null, id);
    } finally {
      c.close();
    }
  }
});

test("archive errors refresh once, sanitize copy, hide after conflict and close on missing", async () => {
  for (const failure of [409, 404, 503]) {
    const c = setup("archive-ready", true, failure);
    try {
      await c.open();
      c.button("archive")!.click();
      await until(() => !!c.root.querySelector('[role="alert"]'));
      const message = c.root.querySelector('[role="alert"]')!.textContent!;
      assert.doesNotMatch(message, /Raw server/);
      assert.match(
        message,
        failure === 409
          ? /FH-040 has work in flight/
          : failure === 404
            ? /This packet doesn't exist anymore/
            : /Couldn't archive FH-040. Try again/,
      );
      assert.equal(c.calls.filter((p) => p.startsWith("POST")).length, 1);
      assert.equal(c.calls.filter((p) => p.endsWith("/state")).length, 2);
      if (failure === 409) assert.equal(c.button("archive"), null);
      if (failure === 404) assert.equal(c.root.querySelector(".archive-heading"), null);
    } finally {
      c.close();
    }
  }
});

test("archived promoted review bookmark stays open with its neutral badge and evidence", async () => {
  const c = setup("archive-list", true, 0, "#review/review-1");
  try {
    await until(() => !!c.root.querySelector(".review-header"));
    assert.match(c.root.querySelector(".review-header")!.textContent!, /FH-040.*Archived/);
    assert.match(c.root.querySelector(".review-detail")!.textContent!, /Promoted to main/);
  } finally {
    c.close();
  }
});

test("archive transport encodes packet routes and uses the existing same-origin session once", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = createHttpTransport({
    origin: "https://fixture.idiot.tax",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ packet: archiveFixtureState().packets[0] });
    },
  });
  await transport.archivePacket!("project/one", "packet/one");
  await transport.unarchivePacket!("project/one", "packet/one");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/projects/project%2Fone/packets/packet%2Fone/archive",
      "/projects/project%2Fone/packets/packet%2Fone/unarchive",
    ],
  );
  for (const { init } of calls) {
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, "{}");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
  }
});

test("uncertain unarchive failure stays in the panel with sanitized copy and no retry", async () => {
  const c = setup("archive-list", true, 503);
  try {
    await until(() => !!c.button("toggle-archived"));
    c.button("toggle-archived")!.click();
    await c.open();
    // The active row opened by setup is the next packet; select archived history instead.
    [...c.root.querySelectorAll<HTMLButtonElement>("#packets .packet-link")].at(-1)!.click();
    await until(() => !!c.button("unarchive"));
    c.button("unarchive")!.click();
    await until(() => !!c.root.querySelector('[role="alert"]'));
    assert.match(
      c.root.querySelector('[role="alert"]')!.textContent!,
      /Couldn't unarchive FH-040. Try again./,
    );
    assert.doesNotMatch(c.root.textContent!, /Raw server error/);
    assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 1);
    assert.ok(c.button("unarchive"));
  } finally {
    c.close();
  }
});


test("finished race keeps its track and opens packet details for archive and undo", async () => {
  const c = setup("archive-finished-race", true, 0, "#race/FH-040");
  try {
    await until(() => [...c.root.querySelectorAll("button")]
      .some((button) => button.textContent === "Packet details"));
    const details = [...c.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Packet details")!;
    assert.ok(details);
    details.click();
    await until(() => !!c.button("archive"));
    assert.equal(c.dom.window.location.hash, "#work");
    c.button("archive")!.click();
    await until(() => !!c.button("unarchive"));
    c.button("toggle-archived")!.click();
    await until(() => c.root.querySelectorAll("#packets tbody tr").length === 2);
    [...c.root.querySelectorAll<HTMLButtonElement>("#packets .packet-link")].at(-1)!.click();
    assert.ok(c.button("unarchive"), "archived race row opens details directly");
    assert.equal(c.root.querySelector(".race-page"), null);
    c.button("unarchive")!.click();
    await until(() => !!c.button("archive"));
  } finally { c.close(); }
});


test("open race Work row routes both roles through the track to read-only live packet details", async () => {
  for (const owner of [true, false]) {
    const c = setup("archive-race", owner);
    try {
      await until(() => !!c.root.querySelector('#packets [data-packet-id="FH-040"]'));
      const row = c.root.querySelector('#packets [data-packet-id="FH-040"]')!;
      assert.match(row.textContent!, /Race/);
      assert.match(row.textContent!, /Racing/);
      assert.match(row.textContent!, /1 entrant/);
      row.querySelector<HTMLButtonElement>(".packet-link")!.click();
      await until(() => !!c.root.querySelector(".race-navigation"));
      assert.equal(c.dom.window.location.hash, "#race/FH-040");
      const buttons = c.root.querySelectorAll<HTMLButtonElement>(".race-navigation button");
      assert.equal(buttons.length, 2);
      assert.match(buttons[0].textContent!, /Work/);
      assert.equal(buttons[1].textContent, "Packet details");
      buttons[1].click();
      await until(() => !!c.root.querySelector(".archive-heading"));
      assert.equal(c.button("archive"), null);
      assert.equal(c.button("unarchive"), null);
      assert.equal(c.calls.filter((call) => call.startsWith("POST")).length, 0);
    } finally { c.close(); }
  }
});

test("finished archive race fixture records a promoted winner and closed other entrants", () => {
  const wire = archiveFixtureState("archive-finished-race");
  const race = wire.races![0];
  const winner = race.entrants.find((entrant) => entrant.agent === race.winner)!;
  assert.equal(wire.packets[0].mode, "race");
  assert.equal(winner.promotedAt, race.finishedAt);
  assert.equal(winner.place, 1);
  assert.equal(winner.closedAt, race.finishedAt);
  assert.equal(winner.closedBy, null);
  assert.equal(race.ledgerEntryId, wire.ledger[0].id);
  assert.equal(wire.reviews[0].agent, winner.agent);
  assert.ok(wire.agents.some((agent) => agent.name === winner.agent));
  assert.ok(race.entrants.filter((entrant) => entrant !== winner)
    .every((entrant) => entrant.closedBy === "race-finished" && entrant.closedAt === race.finishedAt));
  assert.equal(canArchive(stateView(wire), "FH-040"), true);
});
