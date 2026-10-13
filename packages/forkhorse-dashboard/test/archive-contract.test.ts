import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
test("offline archive fixture slices satisfy the merged core public contract", () => {
  const source = readFileSync(new URL("../../forkhorse-core/src/workflow-types.ts", import.meta.url), "utf8");
  // StateSnapshot imports Worker internals for project/activity. Check the public
  // records before it in isolation, using the installed compiler and actual source.
  const boundary = source.indexOf("export interface StateSnapshot");
  assert.ok(boundary > 0, "Core public record declarations must precede StateSnapshot");
  const fixturePath = fileURLToPath(new URL("archive-fixtures.ts", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "fh-archive-contract-"));
  try {
    const contractPath = join(scratch, "contract.ts");
    writeFileSync(contractPath, `${source.slice(0, boundary)}
      import { archiveFixtureState, archiveRace } from ${JSON.stringify(fixturePath)};
      const fixture = archiveFixtureState();
      const packets: Packet[] = fixture.packets.map(packet => ({ ...packet, tokenBudget: packet.tokenBudget ?? undefined, archived: packet.archived ?? null }));
      const blockers: Pick<Blocker, "packet" | "pushingPacket" | "resolved">[] = fixture.blockers.map(blocker => ({ ...blocker,
        pushingPacket: blocker.pushingPacket ?? null, resolved: blocker.resolved ?? null }));
      const race: RaceState = archiveRace();
      const reviews: Pick<Review, "packet" | "promoted" | "stale" | "returned">[] =
        fixture.reviews.map(review => ({ ...review, returned: review.returned ?? null }));
    `);
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    const typeRoots = fileURLToPath(new URL("../../../node_modules/@types", import.meta.url));
    const result = spawnSync(process.execPath, [compiler, "--ignoreConfig", "--noEmit",
      "--strict", "--skipLibCheck", "--allowImportingTsExtensions", "--module", "ESNext",
      "--moduleResolution", "bundler", "--target", "ESNext", "--types", "node",
      "--typeRoots", typeRoots, contractPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
