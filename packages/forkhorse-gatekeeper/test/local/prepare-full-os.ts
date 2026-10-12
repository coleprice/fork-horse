// Prepare an isolated exact-pin archive. No tracked upstream file or owner configuration is edited.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const pin = "8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf";
const upstream = resolve("../../cloudflare-os");
const actual = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actual !== pin) throw new Error("The acceptance harness requires its reviewed upstream pin.");
const directory = mkdtempSync(join(tmpdir(), "gatekeeper-full-os-"));
const archive = execFileSync("git", ["-C", upstream, "archive", pin], { maxBuffer: 64 << 20 });
execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
const extension = join(directory, "packages/gatekeeper-forkhorse");
mkdirSync(extension);
copyFileSync("dist/offline-worker.js", join(extension, "worker.js"));
writeFileSync(join(extension, "cloudflare.config.ts"), `import { defineGadgetsWorker } from "../../scripts/worker-config.ts";
export default defineGadgetsWorker({ name: "gatekeeper-forkhorse", entrypoint: "worker.js",
  compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage", "global_fetch_strictly_public"] });
export const migrations = [{ tag: "v1", new_sqlite_classes: ["UserAccount", "ForkGatekeeper"] }];
`);
mkdirSync(join(directory, "empty-home"));
console.log(JSON.stringify({ directory, pin, note: "Disposable synthetic fixture only; upstream run-local installs registry dependencies." }));
