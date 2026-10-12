import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Only a live core deploy enters this helper. Check mode must never read owner secrets. */
export async function withCoreSecrets(
  root: string,
  file: string,
  deploy: (args: string[]) => void | Promise<void>,
): Promise<void> {
  let directory: string | undefined;
  let temporary: string | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let content: string | undefined;
  let failure: Error | undefined;
  try {
    root = await realpath(root);
    if (isAbsolute(file)) throw new Error();
    const source = resolve(root, file);
    const resolved = await realpath(source);
    const within = relative(root, resolved);
    if (resolved !== source || within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within))
      throw new Error();
    // Refuse tracked/unignored sources. The owner file remains owner-managed and is never deleted.
    if (spawnSync("git", ["check-ignore", "--quiet", "--", within], { cwd: root, stdio: "ignore" }).status !== 0)
      throw new Error();
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let values: Record<string, unknown>;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error();
      values = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).some((key) => !["OWNER_API_TOKEN_HASH", "CF_EVENTS_API_TOKEN"].includes(key)) ||
      typeof values.OWNER_API_TOKEN_HASH !== "string" || !/^[a-f\d]{64}$/.test(values.OWNER_API_TOKEN_HASH) ||
      typeof values.CF_EVENTS_API_TOKEN !== "string" || !values.CF_EVENTS_API_TOKEN.trim() ||
      values.CF_EVENTS_API_TOKEN !== values.CF_EVENTS_API_TOKEN.trim()) throw new Error();
    content = JSON.stringify(values);
    const parent = join(root, "packages/forkhorse-core/.wrangler");
    await mkdir(parent, { recursive: true });
    // The generated copy is private, exclusive, and in the existing gitignored Worker directory.
    if (await realpath(parent) !== parent) throw new Error();
    directory = await mkdtemp(join(parent, "deploy-secrets-"));
    temporary = join(directory, "secrets.json");
    const output = await open(temporary, "wx", 0o600);
    try {
      identity = await output.stat();
      await output.writeFile(content);
    } finally {
      await output.close();
    }
    await deploy(["--secrets-file", temporary]);
  } catch {
    // Includes JSON parser, filesystem and child errors: none may echo a value or file body.
    failure = new Error("Core deploy failed. Check the ignored secrets file and required secret names; details suppressed to protect credentials.");
  } finally {
    if (temporary && identity) {
      const current = await lstat(temporary).catch(() => undefined);
      if (current?.dev === identity.dev && current.ino === identity.ino && current.isFile() &&
        await readFile(temporary, "utf8") === content) {
        await unlink(temporary);
        if (directory) await rmdir(directory);
      } else if (current) {
        failure = new Error("Core secrets temporary file changed; cleanup refused.");
      }
    }
  }
  if (failure) throw failure;
}
