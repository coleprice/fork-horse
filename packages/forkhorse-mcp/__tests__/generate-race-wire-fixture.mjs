import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Execute only the pure core wire/resume mappers against labeled in-memory storage.
// No core Worker, provider, network, credential or live storage is involved.
const coreSource = new URL("../../forkhorse-core/src/", import.meta.url);
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const raceModule = moduleUrl(
  stripTypeScriptTypes(readFileSync(new URL("race-entrants.ts", coreSource), "utf8")),
);
const { raceStates, publicPacket } = await import(raceModule);
const resumeSource = stripTypeScriptTypes(
  readFileSync(new URL("resume-work.ts", coreSource), "utf8"),
);
const { resumeWork } = await import(
  moduleUrl(resumeSource.replace('"./race-entrants"', JSON.stringify(raceModule)))
);
const at = "2026-01-01T00:00:00.000Z";
const head = "a".repeat(40);
const canonicalHead = "b".repeat(40);
const agents = ["builder", "second", "third"];
const packet = {
  id: "FH-race",
  mode: "race",
  title: "Core wire fixture",
  goal: "Offline wire validation",
  paths: ["src/"],
  acceptance: ["Fixture only"],
};
const legacy = { ...packet, id: "FH-standard", mode: undefined };
const records = agents.map((agent) => ({
  packet: packet.id,
  agent,
  repoName: `demo--${agent}-1`,
  paths: packet.paths,
  createdAt: at,
  firstPushAt: at,
  reviewRequestedAt: at,
  receiptPassedAt: at,
  approvedAt: at,
  promotedAt: null,
  place: null,
  closedAt: null,
  closedBy: null,
}));
const review = {
  id: "review-wire-fixture",
  packet: packet.id,
  agent: "builder",
  repoName: "demo--builder-1",
  sha: head,
  base: canonicalHead,
  createdAt: at,
  stale: false,
  promoted: false,
  returned: null,
  approval: { sha: head, receiptDigest: null },
  receipt: { status: "passed" },
};
async function snapshot(finished) {
  const entries = new Map([
    [`packet:${packet.id}`, packet],
    [`packet:${legacy.id}`, legacy],
    [`review:${review.id}`, review],
  ]);
  for (const [index, record] of records.entries()) {
    const entrant = finished
      ? {
          ...record,
          place: [2, 1, 3][index],
          closedAt: at,
          closedBy: index === 2 ? "release" : "race-finished",
          promotedAt: index === 1 ? at : null,
          ...(index === 0 ? { promoteRejected: { at, expected: canonicalHead, found: head } } : {}),
        }
      : record;
    entries.set(`entrant:${packet.id}:${record.agent}`, entrant);
  }
  if (finished)
    entries.set(`race:${packet.id}`, {
      winner: "second",
      finishedAt: at,
      ledgerEntryId: "ledger-wire-fixture-id",
      places: [
        { agent: "second", place: 1 },
        { agent: "builder", place: 2 },
        { agent: "third", place: 3 },
      ],
    });
  const storage = {
    async list({ prefix }) {
      return new Map([...entries].filter(([key]) => key.startsWith(prefix)));
    },
  };
  const packets = [legacy, packet].map(publicPacket);
  return {
    fixture: "Offline source-derived core race/resume mapper output; no live acceptance",
    state: { packets, claims: [], races: await raceStates(storage, packets) },
    me: {
      work: await resumeWork(
        storage,
        "builder",
        new Map([["demo--builder-1", head]]),
        canonicalHead,
        true,
      ),
    },
  };
}
const content =
  JSON.stringify({ open: await snapshot(false), finished: await snapshot(true) }, null, 2) + "\n";
const destination = new URL("workerd/race-wire.fixture.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== content)
    throw new Error("Race wire fixture differs from current core mapper output.");
  console.log("Offline race wire fixture matches current core mappers.");
} else {
  writeFileSync(destination, content);
  console.log(`Generated ${fileURLToPath(destination)} from offline core mappers.`);
}
