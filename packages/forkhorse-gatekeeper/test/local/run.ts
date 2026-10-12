// Offline acceptance runner: real Git subprocesses and pinned OS code in workerd.
// Core enrollment is explicitly a fixture; no owner configuration or credentials are loaded.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const dir = mkdtempSync(join(tmpdir(), "gatekeeper-local-"));
const repo = join(dir, "fork-alpha.git"), seed = join(dir, "seed");
const gitEnv = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(args: string[], cwd = dir, input?: Buffer): Buffer {
  return execFileSync("git", args, { cwd, env: gitEnv, input, maxBuffer: 16 << 20, stdio: ["pipe", "pipe", "pipe"] });
}
let reads = 0, writes = 0, race = false;
const head = () => git(["--git-dir", repo, "rev-parse", "refs/heads/main"]).toString().trim();
const remote = "https://git.fixture.idiot.tax/fork-alpha.git";
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (req.url === "/record") { console.log(`LOCAL ACCEPTANCE: ${body.toString()}`); res.end("recorded"); return; }
    if (req.url === "/race") { race = true; res.end("armed"); return; }
    if (req.url === "/evidence") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ head: head(), reads, writes, text: git(["--git-dir", repo, "show", "main:README.md"]).toString() })); return;
    }
    if (req.url === "/projects/fixture/me") {
      if (req.headers.authorization !== "Bearer fixture-agent-credential-only") throw new Error("Fixture agent auth missing");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ role: "agent", agent: "alpha", forks: [{ repoName: "fork-alpha", remote, head: head(), createdAt: "2026-01-01T00:00:00Z" }] })); return;
    }
    if (req.url === "/projects/fixture/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ project: { id: "fixture", repoName: "canonical", defaultBranch: "main" }, agents: [], forks: [], packets: [], claims: [], blockers: [], reviews: [], ledger: [], reconcilerAlerts: [] })); return;
    }
    if (req.url === "/projects/fixture/forks/fork-alpha/token") {
      const { scope, ttlSeconds } = JSON.parse(body.toString());
      if (!["read", "write"].includes(scope) || ttlSeconds !== 60) throw new Error("Bad fixture grant request");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ repoName: "fork-alpha", remote, scope, token: "fixture-git-token", expiresAt: new Date(Date.now() + 60000).toISOString() })); return;
    }
    if (req.url === "/fork-alpha.git/git-upload-pack" || req.url === "/fork-alpha.git/git-receive-pack") {
      if (req.headers.authorization !== `Basic ${Buffer.from("x:fixture-git-token").toString("base64")}` || !req.headers["user-agent"]?.startsWith("git/")) throw new Error("Git auth or User-Agent missing");
      const pull = req.url.endsWith("upload-pack");
      if (pull) reads++; else writes++;
      if (!pull && race) {
        race = false;
        const old = head(), tree = git(["--git-dir", repo, "rev-parse", "main^{tree}"]).toString().trim();
        const concurrent = git(["--git-dir", repo, "-c", "user.name=Fixture", "-c", "user.email=agent@idiot.tax", "commit-tree", tree, "-p", old, "-m", "Concurrent fixture push"]).toString().trim();
        git(["--git-dir", repo, "update-ref", "refs/heads/main", concurrent, old]);
      }
      const result = execFileSync("git", ["http-backend"], { cwd: dir, input: body, maxBuffer: 16 << 20,
        env: { ...gitEnv, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: req.url,
          REQUEST_METHOD: "POST", CONTENT_TYPE: String(req.headers["content-type"]), CONTENT_LENGTH: String(body.length),
          REMOTE_USER: "fixture", ...(pull ? { HTTP_GIT_PROTOCOL: "version=2" } : {}) },
        stdio: ["pipe", "pipe", "pipe"] });
      const boundary = result.indexOf("\r\n\r\n");
      if (boundary < 0) throw new Error("Malformed CGI output");
      for (const line of result.subarray(0, boundary).toString().split("\r\n")) {
        const colon = line.indexOf(":"); const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") res.statusCode = Number(value.split(" ")[0]); else res.setHeader(key, value);
      }
      res.end(result.subarray(boundary + 4)); return;
    }
    res.statusCode = 404; res.end("Unknown local fixture route");
  } catch (error) { console.error(error); res.statusCode = 500; res.end("Local fixture failed"); }
});
try {
  const generated = join(dir, "generated"); mkdirSync(generated);
  const backend = resolve("../../cloudflare-os/packages/workshop-backend");
  execFileSync(process.execPath, [join(backend, "scripts/build-bundled-blueprints.ts"), "--out", join(generated, "bundled-blueprints.js")], { stdio: "inherit", env: gitEnv });
  const { build, transform } = createRequire(join(backend, "package.json"))("esbuild");
  const blueprintPath = join(generated, "bundled-blueprints.js");
  writeFileSync(blueprintPath, (await transform(readFileSync(blueprintPath, "utf8"), { loader: "ts", format: "esm" })).code);
  for (const [name, format, extension] of [["browser-export-runtime", "iife", "txt"], ["html-sanitizer-runtime", "iife", "txt"], ["browser-export-page", "esm", "js"]]) {
    const result = await build({ entryPoints: [join(backend, "browser", `${name}.ts`)], bundle: true, format, platform: "browser", target: "es2025", write: false });
    writeFileSync(join(generated, `${name}.${extension}`), result.outputFiles[0].contents);
  }
  git(["init", "--bare", "--initial-branch=main", repo]);
  git(["--git-dir", repo, "config", "uploadpack.allowFilter", "true"]);
  git(["--git-dir", repo, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  mkdirSync(seed); git(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "Before local acceptance\n");
  git(["add", "README.md"], seed);
  git(["-c", "user.name=Fixture Agent", "-c", "user.email=agent@idiot.tax", "commit", "-m", "Fixture base"], seed);
  git(["push", repo, "main"], seed);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const executable = resolve("../../node_modules/.bin/vitest");
  const child = spawn(executable, ["run", "--config", "vitest.local.config.ts"], {
    cwd: process.cwd(), stdio: "inherit", env: { ...process.env, FH_LOCAL_FIXTURE_PORT: String(port), FH_LOCAL_GENERATED_DIR: generated },
  });
  process.exitCode = await new Promise<number>(done => child.on("exit", code => done(code ?? 1)));
} finally {
  await new Promise<void>(done => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
}
