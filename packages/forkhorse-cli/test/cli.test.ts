import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { runCli } from "../src/cli.ts";

// All HTTP peers and credentials below are synthetic, in-process loopback fixtures.
const owner = "synthetic-owner-credential-never-display";
const token = (byte = "a") => "api_" + byte.repeat(64);
type Call = { method: string; url: string; body: unknown; auth: string | undefined };
type Handler = (call: Call, response: ServerResponse) => void;

async function fixture(
  handler: Handler,
  body: (base: string, calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const call = {
      method: request.method!,
      url: request.url!,
      body: text ? JSON.parse(text) : undefined,
      auth: request.headers.authorization,
    };
    calls.push(call);
    handler(call, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await body(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function invoke(
  base: string,
  args: string[],
  options: { credential?: string; signal?: AbortSignal; onOut?: (text: string) => void } = {},
) {
  let stdout = "";
  let stderr = "";
  const credential = options.credential ?? owner;
  const code = await runCli(
    [...args, "--base-url", base],
    { FORKHORSE_OWNER_API_TOKEN: credential },
    {
      out: (text) => {
        stdout += text;
        options.onOut?.(text);
      },
      err: (text) => {
        stderr += text;
      },
    },
    options.signal ?? new AbortController().signal,
  );
  if (credential) assert(!stdout.includes(credential) && !stderr.includes(credential));
  return { code, stdout, stderr };
}

async function temporary(body: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "cli-fixture-"));
  try {
    await body(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

test("project create maps source and agents; file credentials are exclusive and mode 0600", async () => {
  await temporary(async (dir) =>
    fixture(
      (call, response) => {
        assert.equal(call.auth, `Bearer ${owner}`);
        json(
          response,
          {
            project: { id: "demo", token: "provider-secret", tokenHash: "hash-secret" },
            agents: [
              { agent: "claude", apiToken: token() },
              { agent: "codex", apiToken: token("b") },
            ],
          },
          201,
        );
      },
      async (base, calls) => {
        const path = join(dir, "credentials.json");
        const args = [
          "project",
          "create",
          "demo",
          "--agents",
          "claude,codex",
          "--source",
          "https://git.idiot.tax/template.git",
          "--output",
          path,
        ];
        const result = await invoke(base, args);
        assert.equal(result.code, 0);
        assert(
          !result.stdout.includes(token()) &&
            !result.stdout.includes("provider-secret") &&
            !result.stdout.includes("hash-secret"),
        );
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
          project: "demo",
          agents: [
            { agent: "claude", apiToken: token() },
            { agent: "codex", apiToken: token("b") },
          ],
        });
        assert.deepEqual(
          calls.map(({ method, url, body }) => ({ method, url, body })),
          [
            {
              method: "POST",
              url: "/projects",
              body: {
                id: "demo",
                agents: ["claude", "codex"],
                sourceUrl: "https://git.idiot.tax/template.git",
              },
            },
          ],
        );
        assert.equal((await invoke(base, args)).code, 1);
        assert.equal(calls.length, 1);
      },
    ),
  );
});

test("no credential issuance without exactly one explicit sink, including symlink refusal", async () => {
  await temporary(async (dir) =>
    fixture(
      (_call, response) => json(response, {}),
      async (base, calls) => {
        for (const command of [
          ["project", "create", "demo", "--agents", "claude"],
          ["agent", "enroll", "claude", "--project", "demo"],
          ["agent", "rotate", "claude", "--project", "demo"],
          ["demo", "seed"],
        ]) {
          const result = await invoke(base, command);
          assert.equal(result.code, 1);
          assert.match(result.stderr, /requires exactly one/);
        }
        assert.equal(
          (await invoke(base, ["demo", "seed", "--show-once", "--output", join(dir, "new")])).code,
          1,
        );
        const target = join(dir, "target");
        const link = join(dir, "link");
        await writeFile(target, "preserve");
        await symlink(target, link);
        assert.equal((await invoke(base, ["demo", "seed", "--output", link])).code, 1);
        assert.equal(await readFile(target, "utf8"), "preserve");
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("show-once exposes only validated agent tokens once; enroll and rotate use exact routes", async () => {
  await fixture(
    (_call, response) =>
      json(
        response,
        { agent: "claude", apiToken: token(), ownerToken: owner, token: "git-secret" },
        201,
      ),
    async (base, calls) => {
      for (const verb of ["enroll", "rotate"]) {
        const result = await invoke(base, [
          "agent",
          verb,
          "claude",
          "--project",
          "demo",
          "--show-once",
        ]);
        assert.equal(result.code, 0);
        assert.equal(result.stdout.split(token()).length - 1, 1);
        assert(!result.stdout.includes("git-secret") && !result.stderr.includes(token()));
      }
      assert.deepEqual(
        calls.map(({ url, body }) => ({ url, body })),
        [
          { url: "/projects/demo/agents", body: { agent: "claude" } },
          { url: "/projects/demo/agents/claude/rotate", body: {} },
        ],
      );
    },
  );
});

test("project and demo show-once print each issued agent token exactly once", async () => {
  await fixture(
    (call, response) => {
      if (call.url === "/projects") {
        const agents = (call.body as { agents: string[] }).agents;
        json(
          response,
          {
            project: { id: "demo", apiToken: token("f"), ownerToken: owner },
            agents: agents.map((agent, i) => ({ agent, apiToken: token(String(i)) })),
          },
          201,
        );
      } else json(response, { packet: call.body }, 201);
    },
    async (base) => {
      for (const command of [
        ["project", "create", "demo", "--agents", "claude,codex,cfos"],
        ["demo", "seed"],
      ]) {
        const result = await invoke(base, [...command, "--show-once"]);
        assert.equal(result.code, 0);
        for (const index of ["0", "1", "2"])
          assert.equal(result.stdout.split(token(index)).length - 1, 1);
        assert(!result.stdout.includes(token("f")));
        assert(!result.stderr.includes("api_"));
      }
    },
  );
});

test("each issuing command rejects owner echo, malformed, duplicate or foreign credentials", async () => {
  await temporary(async (dir) => {
    for (const responseBody of [
      { agent: "claude", apiToken: owner },
      { agent: "claude", apiToken: "unexpected-secret" },
      { agent: "foreign", apiToken: token() },
      {
        agents: [
          { agent: "claude", apiToken: token() },
          { agent: "claude", apiToken: token() },
        ],
      },
    ]) {
      await fixture(
        (_call, response) => json(response, responseBody),
        async (base) => {
          const path = join(dir, "new.json");
          const result = await invoke(base, [
            "agent",
            "rotate",
            "claude",
            "--project",
            "demo",
            "--output",
            path,
          ]);
          assert.equal(result.code, 1);
          assert(!result.stdout.includes(token()));
          await assert.rejects(stat(path), { code: "ENOENT" });
        },
      );
    }
    await fixture(
      (_call, response) => json(response, { agent: "claude", apiToken: token() }),
      async (base) => {
        const result = await invoke(
          base,
          ["agent", "enroll", "claude", "--project", "demo", "--show-once"],
          { credential: token() },
        );
        assert.equal(result.code, 1);
      },
    );
  });
});

test("state/activity recursively redact owner, API tokens, credential fields and bearer/JWT text", async () => {
  const data = {
    title: `text ${owner} ${token()} Bearer arbitrary-secret`,
    [owner]: "safe",
    nested: [
      {
        apiToken: token(),
        tokenHash: "hash-secret",
        secret: "other-secret",
        authorization: "custom-secret",
        cookie: "cookie-secret",
      },
      { text: "eyJfixture.abc.def" },
    ],
    activity: [{ sequence: 1, message: token(), token: "git-secret" }],
    nextAfter: 1,
  };
  await fixture(
    (_call, response) => json(response, data),
    async (base, calls) => {
      for (const command of [
        ["state", "--show-once"],
        ["activity", "--show-once"],
      ]) {
        assert.equal((await invoke(base, [...command, "--project", "demo"])).code, 1);
      }
      assert.equal(calls.length, 0);
      for (const command of ["state", "activity"]) {
        const result = await invoke(base, [command, "--project", "demo"]);
        assert.equal(result.code, 0);
        for (const secret of [
          token(),
          "arbitrary-secret",
          "hash-secret",
          "other-secret",
          "custom-secret",
          "cookie-secret",
          "git-secret",
          "eyJfixture.abc.def",
        ])
          assert(!result.stdout.includes(secret));
        assert.match(result.stdout, /REDACTED/);
      }
    },
  );
});

test("activity follows cursor, drains full pages and stops cleanly on cancellation", async () => {
  const controller = new AbortController();
  await fixture(
    (call, response) => {
      const after = Number(
        new URL(call.url, "https://fixture.idiot.tax").searchParams.get("after"),
      );
      json(response, {
        activity: after < 2 ? [{ sequence: after + 1 }] : [],
        nextAfter: after < 2 ? after + 1 : after,
      });
    },
    async (base, calls) => {
      let pages = 0;
      const result = await invoke(
        base,
        ["activity", "--project", "demo", "--limit", "1", "--follow", "--interval-ms", "250"],
        {
          signal: controller.signal,
          onOut: () => {
            if (++pages === 3) controller.abort();
          },
        },
      );
      assert.equal(result.code, 0);
      assert.deepEqual(
        calls.map((call) => call.url),
        [
          "/projects/demo/activity?after=0&limit=1",
          "/projects/demo/activity?after=1&limit=1",
          "/projects/demo/activity?after=2&limit=1",
        ],
      );
    },
  );
});

test("packet YAML/JSON and config are mapped without executing YAML extensions", async () => {
  await temporary(async (dir) =>
    fixture(
      (call, response) => json(response, { packet: call.body }, 201),
      async (base, calls) => {
        const value = {
          id: "fixture-packet",
          title: "Synthetic packet",
          goal: "Exercise the fixture",
          paths: ["src/shared/**"],
          acceptance: ["Run fixture checks"],
        };
        const yaml =
          "# Synthetic test data\nid: fixture-packet\ntitle: 'Synthetic packet'\ngoal: Exercise the fixture\npaths:\n  - src/shared/**\nacceptance:\n  - \"Run fixture checks\"\n";
        const config = join(dir, "config.json");
        await writeFile(
          config,
          JSON.stringify({ baseUrl: "https://unused.idiot.tax", project: "demo" }),
        );
        for (const [name, text] of [
          ["packet.json", JSON.stringify(value)],
          ["packet.yaml", yaml],
        ]) {
          const file = join(dir, name!);
          await writeFile(file, text!);
          assert.equal(
            (await invoke(base, ["packet", "create", file, "--config", config])).code,
            0,
          );
        }
        assert.deepEqual(
          calls.map((call) => call.body),
          [value, value],
        );
        const file = join(dir, "invalid.yaml");
        for (const text of [
          yaml + "title: Duplicate\n",
          "id: !!js/function code",
          JSON.stringify({ ...value, apiToken: owner }),
          yaml.replace("src/shared/**", "&anchor"),
        ]) {
          await writeFile(file, text);
          assert.equal(
            (await invoke(base, ["packet", "create", file, "--project", "demo"])).code,
            1,
          );
        }
        await writeFile(config, JSON.stringify({ baseUrl: base, apiToken: owner }));
        assert.equal((await invoke(base, ["state", "--config", config])).code, 1);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("packet race fields pass through unchanged for every optional combination in JSON and YAML", async () => {
  const value = {
    id: "fixture-race",
    title: "Synthetic race packet",
    goal: "Exercise race input",
    paths: ["src/shared/**"],
    acceptance: ["Run fixture checks"],
  };
  const yaml =
    'id: fixture-race\ntitle: Synthetic race packet\ngoal: Exercise race input\npaths:\n  - src/shared/**\nacceptance:\n  - "Run fixture checks"\n';
  const options: Record<string, unknown>[] = [
    {},
    { mode: "standard" },
    { mode: "race" },
    { mode: "race", tokenBudget: 1 },
    { mode: "race", judge: "judge-one" },
    { mode: "race", tokenBudget: 1000, judge: "judge-one" },
    { mode: "race", tokenBudget: Number.MAX_SAFE_INTEGER, judge: "a".repeat(32) },
    { mode: "race", judge: "123" },
  ];
  await temporary(async (dir) =>
    fixture(
      (call, response) => json(response, { packet: call.body }, 201),
      async (base, calls) => {
        for (const extra of options) {
          const expected = { ...value, ...extra };
          for (const format of ["json", "yaml"]) {
            const text =
              format === "json"
                ? JSON.stringify(expected)
                : yaml +
                  Object.entries(extra)
                    .map(([key, item]) => `${key}: ${item}\n`)
                    .join("");
            const file = join(dir, `packet.${format}`);
            await writeFile(file, text);
            const result = await invoke(base, ["packet", "create", file, "--project", "demo"]);
            assert.equal(result.code, 0, `${format}: ${JSON.stringify(extra)} ${result.stderr}`);
            assert.deepEqual(calls.at(-1), {
              method: "POST",
              url: "/projects/demo/packets",
              body: expected,
              auth: `Bearer ${owner}`,
            });
          }
        }
        assert.equal(calls.length, options.length * 2);
      },
    ),
  );
});

test("invalid packet race combinations fail with field-specific CLI errors before any HTTP request", async () => {
  const value = {
    id: "fixture-race",
    title: "Synthetic race packet",
    goal: "Exercise rejected race input",
    paths: ["src/shared/**"],
    acceptance: ["Run fixture checks"],
  };
  const cases: [Record<string, unknown>, RegExp][] = [
    ...["", "Race", "other", 1, true, null, [], {}].map(
      (mode): [Record<string, unknown>, RegExp] => [{ mode }, /mode must be standard or race/],
    ),
    ...[{}, { mode: "standard" }].flatMap((mode): [Record<string, unknown>, RegExp][] => [
      [{ ...mode, tokenBudget: 1000 }, /tokenBudget requires mode: race/],
      [{ ...mode, judge: "judge-one" }, /judge requires mode: race/],
      [{ ...mode, tokenBudget: 1000, judge: "judge-one" }, /tokenBudget requires mode: race/],
    ]),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000", true, null, [], {}].map(
      (tokenBudget): [Record<string, unknown>, RegExp] => [
        { mode: "race", tokenBudget, judge: "judge-one" },
        /tokenBudget must be a positive safe integer/,
      ],
    ),
    ...[
      "",
      "Judge",
      "two words",
      "judge_one",
      "-judge",
      "judge-",
      "judge--one",
      "a".repeat(33),
      1,
      true,
      null,
      [],
      {},
    ].map((judge): [Record<string, unknown>, RegExp] => [
      { mode: "race", tokenBudget: 1000, judge },
      /judge must be a lowercase agent ID of at most 32 characters/,
    ]),
    [{ mode: "race", entrants: ["builder"] }, /Packet must contain only/],
  ];
  await temporary(async (dir) =>
    fixture(
      (_call, response) => json(response, {}),
      async (base, calls) => {
        const file = join(dir, "invalid.json");
        for (const [extra, error] of cases) {
          await writeFile(file, JSON.stringify({ ...value, ...extra }));
          const result = await invoke(base, ["packet", "create", file, "--project", "demo"]);
          assert.equal(result.code, 1, JSON.stringify(extra));
          assert.match(result.stderr, error);
        }
        // JSON numeric overflow reaches validation as Infinity, rather than null.
        await writeFile(
          file,
          JSON.stringify({ ...value, mode: "race" }).replace(/}$/, ',"tokenBudget":1e309}'),
        );
        const result = await invoke(base, ["packet", "create", file, "--project", "demo"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /tokenBudget must be a positive safe integer/);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("YAML race budgets preserve numeric and quoted scalar types and reject unsafe extensions", async () => {
  const yaml =
    'id: fixture-race\ntitle: Synthetic race packet\ngoal: Exercise YAML input\npaths:\n  - src/shared/**\nacceptance:\n  - "Run fixture checks"\n';
  await temporary(async (dir) =>
    fixture(
      (call, response) => json(response, { packet: call.body }, 201),
      async (base, calls) => {
        const file = join(dir, "packet.yaml");
        for (const budget of ["1000", "1e3", "1000.0"]) {
          await writeFile(file, yaml + `mode: race\ntokenBudget: ${budget}\njudge: 'judge-one'\n`);
          const result = await invoke(base, ["packet", "create", file, "--project", "demo"]);
          assert.equal(result.code, 0, result.stderr);
          assert.equal((calls.at(-1)!.body as { tokenBudget: number }).tokenBudget, 1000);
          assert.equal((calls.at(-1)!.body as { judge: string }).judge, "judge-one");
        }
        const invalid: [string, RegExp][] = [
          ["tokenBudget: 1000\n", /tokenBudget requires mode: race/],
          ["mode: standard\njudge: judge-one\n", /judge requires mode: race/],
          ["mode: Race\n", /mode must be standard or race/],
          ["mode: race\njudge: Judge\n", /judge must be a lowercase agent ID/],
          ["mode: race\njudge: 'two words'\n", /judge must be a lowercase agent ID/],
          ["mode: race\ntokenBudget: 1\ntokenBudget: 2\n", /Invalid or duplicate YAML field/],
          ["mode: race\ntokenBudget: &anchor\n", /Unsupported YAML value/],
          ["mode: race\njudge: !!js/function code\n", /Unsupported YAML value/],
          ...[
            "0",
            "-1",
            "1.5",
            "9007199254740992",
            "1e309",
            '"1000"',
            "'1000'",
            "true",
            "null",
            "NaN",
            "Infinity",
          ].map((budget): [string, RegExp] => [
            `mode: race\ntokenBudget: ${budget}\n`,
            /tokenBudget must be a positive safe integer/,
          ]),
        ];
        for (const [extra, error] of invalid) {
          await writeFile(file, yaml + extra);
          const result = await invoke(base, ["packet", "create", file, "--project", "demo"]);
          assert.equal(result.code, 1, extra);
          assert.match(result.stderr, error);
        }
        assert.equal(calls.length, 3);
      },
    ),
  );
});

test("connect prints exact env-placeholder snippets with custom MCP path and no API call", async () => {
  await fixture(
    (_call, response) => json(response, {}),
    async (base, calls) => {
      const claude = await invoke(base, ["connect", "claude", "claude", "--mcp-path", "/agent"], {
        credential: "",
      });
      assert.equal(claude.code, 0);
      assert.deepEqual(JSON.parse(claude.stdout), {
        mcpServers: {
          forkhorse_claude: {
            type: "http",
            url: `${base}/agent`,
            headers: { Authorization: "Bearer ${AGENT_CORE_API_TOKEN}" },
          },
        },
      });
      const codex = await invoke(base, ["connect", "codex", "builder-one"], { credential: "" });
      assert.equal(
        codex.stdout,
        `codex mcp add forkhorse_builder_one --url '${base}/mcp' --bearer-token-env-var AGENT_CORE_API_TOKEN\n`,
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("demo creates three agents and three synthetic packets with intentionally overlapping paths", async () => {
  await temporary(async (dir) =>
    fixture(
      (call, response) => {
        if (call.url === "/projects")
          json(
            response,
            {
              project: { id: "demo" },
              agents: ["claude", "codex", "cfos"].map((agent, i) => ({
                agent,
                apiToken: token(String(i)),
              })),
            },
            201,
          );
        else json(response, { packet: call.body }, 201);
      },
      async (base, calls) => {
        const path = join(dir, "tokens.json");
        const result = await invoke(base, ["demo", "seed", "--output", path]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /Synthetic demo/);
        assert.deepEqual(calls[0]!.body, { id: "demo", agents: ["claude", "codex", "cfos"] });
        assert.equal(calls.length, 4);
        const packets = calls
          .slice(1)
          .map((call) => call.body as { paths: string[]; title: string });
        assert.equal(packets[0]!.paths[0], packets[1]!.paths[0]);
        assert(packets.every((item) => item.title.startsWith("Synthetic demo:")));
        assert.equal(JSON.parse(await readFile(path, "utf8")).agents.length, 3);
        assert(!result.stdout.includes("api_"));
      },
    ),
  );
});

test("demo preserves already-issued file credentials if later packet creation fails", async () => {
  await temporary(async (dir) =>
    fixture(
      (call, response) => {
        if (call.url === "/projects")
          json(
            response,
            {
              project: { id: "demo" },
              agents: ["claude", "codex", "cfos"].map((agent) => ({ agent, apiToken: token() })),
            },
            201,
          );
        else json(response, { error: owner + token() }, 409);
      },
      async (base, calls) => {
        const path = join(dir, "tokens.json");
        const result = await invoke(base, ["demo", "seed", "--output", path]);
        assert.equal(result.code, 1);
        assert.equal(calls.length, 2);
        assert.equal(JSON.parse(await readFile(path, "utf8")).agents.length, 3);
        assert(!result.stdout.includes(token()) && !result.stderr.includes(token()));
      },
    ),
  );
});

test("HTTP failures, redirects, malformed JSON and oversized bodies never echo provider data", async () => {
  for (const kind of ["error", "redirect", "invalid", "large", "cursor"]) {
    await fixture(
      (_call, response) => {
        if (kind === "redirect") {
          response.writeHead(302, { location: `https://fixture.idiot.tax/${owner}` });
          response.end();
        } else if (kind === "error") json(response, { error: `${owner} ${token()}` }, 403);
        else if (kind === "invalid") response.end(`${owner} ${token()}`);
        else if (kind === "large")
          response.end(JSON.stringify({ content: token() + "x".repeat(1048576) }));
        else json(response, { activity: [{ sequence: 1 }], nextAfter: 0 });
      },
      async (base, calls) => {
        const result = await invoke(base, [
          kind === "cursor" ? "activity" : "state",
          "--project",
          "demo",
        ]);
        assert.equal(result.code, 1);
        assert(!result.stdout.includes(token()) && !result.stderr.includes(token()));
        assert.equal(calls.length, 1);
      },
    );
  }
});

test("bad URL, auth, arguments, large inputs and request bounds fail before HTTP writes", async () => {
  await temporary(async (dir) =>
    fixture(
      (_call, response) => json(response, {}),
      async (base, calls) => {
        for (const args of [
          ["project", "create", "Bad ID", "--agents", "claude", "--show-once"],
          ["project", "create", "demo", "--agents", "claude,claude", "--show-once"],
          ["state", "--project", "demo", "--unknown", owner],
          ["state", "extra", "--project", "demo"],
          ["activity", "--project", "demo", "--limit", "101"],
          ["connect", "claude", "claude", "--mcp-path", "/projects"],
        ]) {
          assert.equal((await invoke(base, args)).code, 1);
        }
        for (const url of [
          "http://public.idiot.tax",
          "https://user:pass@fixture.idiot.tax",
          "https://fixture.idiot.tax/?token=x",
          "https://fixture.idiot.tax/base",
        ])
          assert.equal((await invoke(url, ["state", "--project", "demo"])).code, 1);
        assert.equal(
          (await invoke(base, ["state", "--project", "demo"], { credential: "" })).code,
          1,
        );
        const path = join(dir, "packet.json");
        await writeFile(path, "x".repeat(16385));
        assert.equal((await invoke(base, ["packet", "create", path, "--project", "demo"])).code, 1);
        // Encoded body can grow beyond the file size when strings contain control bytes.
        const value = {
          id: "fixture",
          title: "Fixture",
          goal: "fixture",
          paths: ["src/**"],
          acceptance: ["\u0001".repeat(2000), "\u0001".repeat(2000)],
        };
        // JSON is already bounded on disk; YAML quoted scalars below expand when JSON encoded.
        await writeFile(
          path,
          "id: fixture\ntitle: Fixture\ngoal: Fixture\npaths:\n  - src/**\nacceptance:\n  - '" +
            "\u0001".repeat(2000) +
            "'\n  - '" +
            "\u0001".repeat(2000) +
            "'\n",
        );
        assert(Buffer.byteLength(JSON.stringify(value)) > 16384);
        assert.equal((await invoke(base, ["packet", "create", path, "--project", "demo"])).code, 1);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("actual Node entrypoint returns failing status without printing owner or agent credentials", async () => {
  await fixture(
    (_call, response) => json(response, { error: owner + token() }, 401),
    async (base) => {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              new URL("../src/main.ts", import.meta.url).pathname,
              "state",
              "--base-url",
              base,
              "--project",
              "demo",
            ],
            {
              env: { PATH: process.env.PATH, FORKHORSE_OWNER_API_TOKEN: owner },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /HTTP 401/);
      assert(!result.stderr.includes(owner) && !result.stderr.includes(token()));
    },
  );
});
