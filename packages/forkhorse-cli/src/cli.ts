import { open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Api, CliError, endpoint, record, redact, slug } from "./safety.ts";
import { packet, smallFile } from "./packet.ts";

type IO = { out: (text: string) => void; err: (text: string) => void };
type Options = Map<string, string | boolean>;
const booleanOptions = new Set(["show-once", "follow", "help"]);
const common = ["base-url", "config", "project", "help"];
const commandOptions: Record<string, string[]> = {
  "project create": ["source", "agents", "output", "show-once"],
  "agent enroll": ["output", "show-once"],
  "agent rotate": ["output", "show-once"],
  "packet create": [],
  state: [],
  activity: ["after", "limit", "follow", "interval-ms"],
  "connect claude": ["mcp-path"],
  "connect codex": ["mcp-path"],
  "demo seed": ["output", "show-once"],
};

function args(argv: string[]): { words: string[]; options: Options } {
  const words: string[] = [];
  const options: Options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (options.has(key)) throw new CliError("Duplicate option.");
    if (booleanOptions.has(key)) options.set(key, true);
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new CliError("Option requires a value.");
      options.set(key, value);
    }
  }
  return { words, options };
}

function option(options: Options, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new CliError("Numeric option is outside its allowed range.");
  return result;
}

function exact(words: string[], count: number): void {
  if (words.length !== count)
    throw new CliError("Unexpected or missing command arguments; use --help.");
}

function shellQuote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

type Credential = { agent: string; apiToken: string };
function credentials(
  response: Record<string, unknown>,
  expected: string[],
  owner: string,
): Credential[] {
  const entries = Array.isArray(response.agents) ? response.agents : [response];
  if (entries.length !== expected.length)
    throw new CliError("Core returned invalid agent credentials; inspect state before retrying.");
  const found: Credential[] = [];
  for (const entry of entries) {
    if (
      !record(entry) ||
      typeof entry.agent !== "string" ||
      !expected.includes(entry.agent) ||
      found.some((item) => item.agent === entry.agent) ||
      typeof entry.apiToken !== "string" ||
      !/^api_[a-f0-9]{64}$/.test(entry.apiToken) ||
      entry.apiToken.includes(owner)
    )
      throw new CliError("Core returned invalid agent credentials; inspect state before retrying.");
    found.push({ agent: entry.agent, apiToken: entry.apiToken });
  }
  return found;
}

class TokenSink {
  private file?: FileHandle;
  private path?: string;
  private saved = false;

  static async create(options: Options): Promise<TokenSink> {
    const sink = new TokenSink();
    const path = option(options, "output");
    if (Boolean(path) === Boolean(options.has("show-once")))
      throw new CliError(
        "Issuing credentials requires exactly one of --output <new-file> or --show-once.",
      );
    if (path) {
      // Reserve before making any write request. Exclusive creation refuses files and symlinks.
      sink.file = await open(path, "wx", 0o600);
      sink.path = path;
      try {
        await sink.file.chmod(0o600);
      } catch (error) {
        await sink.file.close();
        await unlink(path);
        throw error;
      }
    }
    return sink;
  }

  async save(project: string, entries: Credential[], io: IO): Promise<void> {
    const text = JSON.stringify({ project, agents: entries }, null, 2) + "\n";
    if (this.file) {
      await this.file.writeFile(text, "utf8");
      await this.file.sync();
      this.saved = true;
      io.out("Agent credentials saved to the requested private file (mode 0600).\n");
    } else {
      this.saved = true;
      io.out(text);
    }
  }

  async close(): Promise<void> {
    await this.file?.close();
    // Preserve a file after a partial write for owner recovery; never silently discard tokens.
    if (this.path && !this.saved) {
      const handle = await open(this.path, "r");
      const empty = (await handle.stat()).size === 0;
      await handle.close();
      if (empty) await unlink(this.path);
    }
  }
}

function help(name: string, command: string): string {
  return `${name} owner CLI\n
Usage: ${command} <command> [--base-url <https-origin> | --config <json-file>] [--project <id>]
  project create <id> [--source <https-url>] --agents a,b,c (--output <new-file> | --show-once)
  agent enroll|rotate <agent> (--output <new-file> | --show-once)
  packet create <json-or-yaml-file>
  state
  activity [--after <sequence>] [--limit <1-100>] [--follow] [--interval-ms <250-60000>]
  connect claude|codex <agent> [--mcp-path /mcp]
  demo seed (--output <new-file> | --show-once)
Config JSON: {"baseUrl":"<owner-origin>","project":"<id>","mcpPath":"/mcp"}
API commands require FORKHORSE_OWNER_API_TOKEN in the environment. Never put it in config.
Only --show-once permits stdout agent credentials. Demo content is synthetic; it performs real API writes.
`;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: IO,
  signal: AbortSignal,
): Promise<number> {
  const owner = env.FORKHORSE_OWNER_API_TOKEN ?? "";
  const originalIO = io;
  const hideOwner = (text: string) => (owner ? text.split(owner).join("[REDACTED]") : text);
  io = {
    out: (text) => originalIO.out(hideOwner(text)),
    err: (text) => originalIO.err(hideOwner(text)),
  };
  let sink: TokenSink | undefined;
  const output = (value: unknown) => io.out(JSON.stringify(redact(value, owner), null, 2) + "\n");
  try {
    const brand: unknown = JSON.parse(
      await readFile(new URL("../../../brand.json", import.meta.url), "utf8"),
    );
    if (!record(brand) || typeof brand.name !== "string" || typeof brand.slug !== "string")
      throw new CliError("Brand configuration is invalid.");
    const { words, options } = args(argv);
    if (!words.length || options.has("help")) {
      io.out(String(redact(help(brand.name, brand.slug), owner)));
      return 0;
    }
    const command = ["state", "activity"].includes(words[0]!)
      ? words[0]!
      : words.slice(0, 2).join(" ");
    const allowed = commandOptions[command];
    if (!allowed || [...options.keys()].some((key) => ![...common, ...allowed].includes(key)))
      throw new CliError("Unknown command or unsupported option; use --help.");
    exact(
      words,
      command === "state" || command === "activity" ? 1 : command === "demo seed" ? 2 : 3,
    );
    let config: Record<string, unknown> = {};
    const configPath = option(options, "config");
    if (configPath) {
      const parsed: unknown = JSON.parse(await smallFile(configPath));
      if (
        !record(parsed) ||
        Object.keys(parsed).some((key) => !["baseUrl", "project", "mcpPath"].includes(key))
      )
        throw new CliError(
          "Config permits only baseUrl, project and mcpPath; credentials belong in the environment.",
        );
      config = parsed;
    }
    const base = endpoint(option(options, "base-url") ?? config.baseUrl, true);
    if (command.startsWith("connect ")) {
      const agent = slug(words[2], 32);
      const path = option(options, "mcp-path") ?? config.mcpPath ?? "/mcp";
      if (
        typeof path !== "string" ||
        !/^\/[a-zA-Z0-9_-]+$/.test(path) ||
        ["/projects", "/app", "/authorize", "/oauth"].includes(path)
      )
        throw new CliError("MCP path must be one nonreserved path segment.");
      const url = new URL(path, base).href;
      const name = `${slug(brand.slug)}_${agent.replaceAll("-", "_")}`;
      if (command === "connect codex") {
        // JSON quoting is not shell quoting. URLs are embedded as single-quoted shell words.
        io.out(
          String(
            redact(
              `codex mcp add ${name} --url ${shellQuote(url)} --bearer-token-env-var AGENT_CORE_API_TOKEN\n`,
              owner,
            ),
          ),
        );
      } else {
        // This is a literal env placeholder, never a response credential. Sanitize endpoint
        // text separately so ordinary bearer redaction cannot erase the required placeholder.
        io.out(
          JSON.stringify(
            {
              mcpServers: {
                [name]: {
                  type: "http",
                  url: redact(url, owner),
                  headers: { Authorization: "Bearer ${AGENT_CORE_API_TOKEN}" },
                },
              },
            },
            null,
            2,
          ) + "\n",
        );
      }
      return 0;
    }
    if (!/^[^\s]{1,512}$/.test(owner))
      throw new CliError("Set a valid FORKHORSE_OWNER_API_TOKEN in the environment.");
    const configuredProject =
      option(options, "project") ??
      (typeof config.project === "string" ? config.project : undefined);
    const project = slug(
      command === "project create"
        ? words[2]
        : command === "demo seed"
          ? (configuredProject ?? "demo")
          : configuredProject,
    );
    const prefix = `/projects/${project}`;
    const api = new Api(base, owner, signal);
    if (command === "state") output(await api.request(`${prefix}/state`));
    else if (command === "activity") {
      let after = integer(option(options, "after"), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(option(options, "limit"), 100, 1, 100);
      const interval = integer(option(options, "interval-ms"), 1000, 250, 60000);
      do {
        const response = await api.request(`${prefix}/activity?after=${after}&limit=${limit}`);
        if (
          !Array.isArray(response.activity) ||
          response.activity.length > limit ||
          !Number.isSafeInteger(response.nextAfter) ||
          (response.nextAfter as number) < after ||
          (response.activity.length > 0 && (response.nextAfter as number) <= after)
        )
          throw new CliError("Core returned an invalid activity cursor.");
        output(response);
        after = response.nextAfter as number;
        if (!options.has("follow")) break;
        if (response.activity.length < limit) await delay(interval, undefined, { signal });
      } while (!signal.aborted);
    } else if (command === "packet create") {
      output(await api.request(`${prefix}/packets`, packet(await smallFile(words[2]!))));
    } else if (command === "agent enroll" || command === "agent rotate") {
      const agent = slug(words[2], 32);
      sink = await TokenSink.create(options);
      const response = await api.request(
        command === "agent enroll" ? `${prefix}/agents` : `${prefix}/agents/${agent}/rotate`,
        command === "agent enroll" ? { agent } : {},
      );
      await sink.save(project, credentials(response, [agent], owner), io);
      output({ project, agent, operation: command });
    } else {
      const agents =
        command === "demo seed"
          ? ["claude", "codex", "cfos"]
          : option(options, "agents")?.split(",");
      if (!agents || !agents.length || agents.length > 50 || new Set(agents).size !== agents.length)
        throw new CliError("Supply 1 to 50 unique agent IDs with --agents a,b,c.");
      agents.forEach((agent) => slug(agent, 32));
      const data: Record<string, unknown> = { id: project, agents };
      const source = option(options, "source");
      if (source) {
        const url = endpoint(source);
        if (url.protocol !== "https:")
          throw new CliError("Source must be public HTTPS; core validates its host.");
        data.sourceUrl = url.href;
      }
      sink = await TokenSink.create(options);
      const response = await api.request("/projects", data);
      await sink.save(project, credentials(response, agents, owner), io);
      output(response.project);
      if (command === "demo seed") {
        io.out(
          "Synthetic demo: overlapping packet paths intentionally conflict when different agents claim them. No claims or pushes were made.\n",
        );
        for (const [id, paths] of [
          ["demo-ui", ["src/shared/**", "src/ui/**"]],
          ["demo-api", ["src/shared/**", "src/api/**"]],
          ["demo-docs", ["docs/**"]],
        ] as const) {
          output(
            await api.request(`${prefix}/packets`, {
              id,
              title: `Synthetic demo: ${id}`,
              goal: "Synthetic packet for offline/demo workflow exploration.",
              paths,
              acceptance: ["Demo fixture only; independently run the assigned checks."],
            }),
          );
        }
      }
    }
    return 0;
  } catch (error) {
    if (signal.aborted && argv[0] === "activity") return 0;
    // Only our fixed messages are eligible for display; neither native errors nor API bodies.
    io.err(
      String(
        redact(
          error instanceof CliError
            ? error.message
            : "CLI operation failed; inspect state before retrying writes.",
          owner,
        ),
      ) + "\n",
    );
    return 1;
  } finally {
    try {
      await sink?.close();
    } catch {
      io.err("Credential file cleanup failed; inspect the requested file.\n");
    }
  }
}
