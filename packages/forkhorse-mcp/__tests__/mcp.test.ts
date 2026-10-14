import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandler } from "../src/mcp";
import { MAX_BYTES } from "../src/core";
import { FixtureCore } from "./fixtures";

const publicOrigin = "https://mcp.idiot.tax";
const url = `${publicOrigin}/mcp`;
function rpc(method: string, params: unknown = {}, token = "api_fixture_builder") {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function connect(core = new FixtureCore()) {
  const handler = createMcpHandler({ core: core.client, publicOrigin });
  const client = new Client({ name: "fixture-inspector", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: "Bearer api_fixture_builder" } },
    fetch: (input, init) => handler(new Request(input, init)),
  });
  await client.connect(transport);
  return { core, client, handler };
}

describe("fixture Streamable HTTP integration", () => {
  it("initializes with the official SDK and lists nine tools with honest annotations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "activity",
      "claim",
      "get_context",
      "join",
      "refresh_token",
      "report_usage",
      "request_review",
      "status",
      "submit_work",
    ]);
    for (const tool of tools) {
      const read = ["get_context", "status", "activity"].includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(read);
      expect(tool.annotations?.idempotentHint).toBe(read);
    }
    const refresh = tools.find((tool) => tool.name === "refresh_token")!;
    expect(refresh.description).toContain("Never print or log the token");
    expect(refresh.description).toContain("http.extraHeader");
    expect(refresh.inputSchema.required).toEqual(["repoName"]);
    expect(refresh.annotations?.destructiveHint).toBe(true);
    await client.close();
  });
  it("maps every tool to the contracted route and passes the core bearer unchanged", async () => {
    const { core, client } = await connect();
    for (const name of ["get_context", "status"])
      await client.callTool({ name, arguments: { project: "demo" } });
    await client.callTool({ name: "activity", arguments: { project: "demo", after: 3, limit: 8 } });
    const joined = await client.callTool({
      name: "join",
      arguments: { project: "demo", agent: "builder" },
    });
    expect(joined.isError).toBeUndefined();
    await client.callTool({
      name: "claim",
      arguments: { project: "demo", packet: "FH-004", repoName: "demo--builder-2" },
    });
    // A later join must not redirect the earlier packet binding.
    await client.callTool({ name: "join", arguments: { project: "demo", agent: "builder" } });
    await client.callTool({
      name: "submit_work",
      arguments: {
        project: "demo",
        packet: "FH-004",
        files: [{ path: "src/a.ts", content: "fixture" }],
        message: "fixture commit",
      },
    });
    await client.callTool({
      name: "request_review",
      arguments: {
        project: "demo",
        packet: "FH-004",
        repoName: "demo--builder-2",
        sha: "a".repeat(40),
      },
    });
    expect(
      core.requests.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
    ).toEqual([
      "GET /projects/demo/state",
      "GET /projects/demo/me",
      "GET /projects/demo/state",
      "GET /projects/demo/me",
      "GET /projects/demo/activity?after=3&limit=8",
      "POST /projects/demo/join",
      "POST /projects/demo/packets/FH-004/claim",
      "POST /projects/demo/join",
      "GET /projects/demo/state",
      "POST /projects/demo/forks/demo--builder-2/commit",
      "POST /projects/demo/reviews",
    ]);
    for (const request of core.requests)
      expect(request.headers.get("authorization")).toBe("Bearer api_fixture_builder");
    expect(await core.requests[6]!.json()).toEqual({ repoName: "demo--builder-2" });
    expect(await core.requests[9]!.json()).toEqual({
      packet: "FH-004",
      files: [{ path: "src/a.ts", content: "fixture" }],
      message: "fixture commit",
    });
    await client.close();
  });
  it("rejects missing, invalid and owner credentials before listing or executing", async () => {
    const { handler, core, client } = await connect();
    for (const token of ["", "invalid", "owner_fixture_token"]) {
      const response = await handler(rpc("tools/list", {}, token));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource/mcp",
      );
    }
    expect(core.requests).toHaveLength(0);
    await client.close();
  });
  it("refuses cross-project, cross-agent, traversal, extra properties and owner tools", async () => {
    const { client, core } = await connect();
    const bad = [
      { name: "status", arguments: { project: "foreign" } },
      { name: "join", arguments: { project: "demo", agent: "other" } },
      { name: "claim", arguments: { project: "demo", packet: "../../promote" } },
      { name: "status", arguments: { project: "demo", token: "owner" } },
      { name: "promote", arguments: { project: "demo" } },
      ...["../secret", "/secret", ".git/config", "src\\x", "src//x"].map((path) => ({
        name: "submit_work",
        arguments: {
          project: "demo",
          packet: "FH-004",
          message: "fixture",
          files: [{ path, content: "x" }],
        },
      })),
    ];
    for (const input of bad) expect((await client.callTool(input)).isError).toBe(true);
    expect(core.requests).toHaveLength(0);
    await client.close();
  });
  it("fails missing, foreign and ambiguous bindings without committing", async () => {
    const { core, client } = await connect();
    for (const claims of [
      [],
      [{ packet: "FH-004", agent: "other", repoName: "demo--other-1" }],
      [core.claims[0]!, core.claims[0]!],
    ]) {
      core.claims = claims;
      const result = await client.callTool({
        name: "submit_work",
        arguments: {
          project: "demo",
          packet: "FH-004",
          files: [{ path: "a", content: "x" }],
          message: "fixture",
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(core.requests.every((request) => new URL(request.url).pathname.endsWith("/state"))).toBe(
      true,
    );
    await client.close();
  });
  it("preserves core conflicts and redacts provider exception contents", async () => {
    const { core, client } = await connect();
    core.failure = 409;
    const result = await client.callTool({
      name: "claim",
      arguments: { project: "demo", packet: "FH-004" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Core conflict");
    expect(JSON.stringify(result)).not.toContain("provider_fixture_exception");
    expect(core.requests).toHaveLength(1);
    await client.close();
  });
  it("enforces file count, duplicate paths, streamed request and fully encoded response limits", async () => {
    const { core, handler, client } = await connect();
    for (const files of [
      Array.from({ length: 201 }, (_, i) => ({ path: `a${i}`, content: "x" })),
      [
        { path: "a", content: "x" },
        { path: "a", content: "y" },
      ],
    ]) {
      expect(
        (
          await client.callTool({
            name: "submit_work",
            arguments: { project: "demo", packet: "FH-004", files, message: "fixture" },
          })
        ).isError,
      ).toBe(true);
    }
    const oversized = await handler(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer api_fixture_builder",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "x".repeat(MAX_BYTES),
      }),
    );
    expect(oversized.status).toBe(413);
    core.payload = { claims: [], work: [], data: '"'.repeat(MAX_BYTES / 3) };
    const response = await handler(
      rpc("tools/call", { name: "status", arguments: { project: "demo" } }),
    );
    expect(response.status).toBe(413); // JSON nested inside the MCP text content grows again.
    expect((await response.text()).length).toBeLessThan(1024);
    await client.close();
  });
  it("enforces origin and path before dispatch, declines persistent streams", async () => {
    const core = new FixtureCore();
    const handler = createMcpHandler({ core: core.client, publicOrigin, path: "/agent/mcp" });
    expect((await handler(rpc("tools/list"))).status).toBe(404);
    const request = new Request(`${publicOrigin}/agent/mcp`, {
      headers: { origin: "https://other.idiot.tax", authorization: "Bearer api_fixture_builder" },
    });
    expect((await handler(request)).status).toBe(403);
    expect(
      (
        await handler(
          new Request(`${publicOrigin}/agent/mcp`, {
            headers: { authorization: "Bearer api_fixture_builder" },
          }),
        )
      ).status,
    ).toBe(405);
    expect(core.requests).toHaveLength(0);
  });
  it("bounds slow authentication and stops late operations after the deadline", async () => {
    const core = new FixtureCore();
    let release!: () => void;
    core.client.authenticate = async (_token, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal.throwIfAborted();
      return { project: "demo", agent: "builder" };
    };
    const response = await createMcpHandler({ core: core.client, publicOrigin, timeoutMs: 10 })(
      rpc("tools/list"),
    );
    expect(response.status).toBe(504);
    release();
    await Promise.resolve();
    expect(core.requests).toHaveLength(0);
  });
  it("cancels an unfinished input stream at the whole-call deadline", async () => {
    const core = new FixtureCore();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      duplex: "half",
      headers: {
        authorization: "Bearer api_fixture_builder",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    };
    const response = await createMcpHandler({ core: core.client, publicOrigin, timeoutMs: 10 })(
      new Request(url, init),
    );
    expect(response.status).toBe(504);
    expect(cancelled).toBe(true);
    expect(core.requests).toHaveLength(0);
  });
  it("rejects a streamed oversized request despite a false Content-Length", async () => {
    const core = new FixtureCore();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BYTES));
        controller.close();
      },
    });
    const init = {
      method: "POST",
      duplex: "half",
      headers: {
        authorization: "Bearer api_fixture_builder",
        "content-type": "application/json",
        "content-length": "1",
        accept: "application/json, text/event-stream",
      },
      body,
    };
    const response = await createMcpHandler({ core: core.client, publicOrigin })(
      new Request(url, init),
    );
    expect(response.status).toBe(413);
    expect(core.requests).toHaveLength(0);
  });
});
