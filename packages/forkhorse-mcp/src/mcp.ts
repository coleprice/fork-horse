import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import brand from "../../../brand.json";
import { boundedCall, CALL_TIMEOUT_MS, MAX_BYTES, PublicError, readBounded } from "./core";
import type { CoreClient, CoreOperation } from "./core";

const slug = z
  .string()
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const agent = z
  .string()
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const repoName = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const packet = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const project = { project: slug };
const file = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
          !path.split("/").some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase())),
        "Use a safe relative repository path.",
      ),
    content: z.string(),
  })
  .strict();
const schemas = {
  get_context: z.object(project).strict(),
  status: z.object(project).strict(),
  activity: z
    .object({
      ...project,
      after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  join: z
    .object({ ...project, agent, ttlSeconds: z.number().int().min(60).max(3600).optional() })
    .strict(),
  claim: z.object({ ...project, packet, repoName: repoName.optional() }).strict(),
  request_review: z
    .object({ ...project, packet, repoName, sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .strict(),
  submit_work: z
    .object({
      ...project,
      packet,
      files: z
        .array(file)
        .min(1)
        .max(200)
        .refine(
          (files) => new Set(files.map((entry) => entry.path)).size === files.length,
          "Duplicate paths are not allowed.",
        ),
      message: z.string().min(1).max(4096),
    })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  get_context: "Read the current project snapshot, packet scope, claims, blockers and reviews.",
  status: "Read the current project state and review status.",
  activity: "Read recorded activity after a cursor (up to 100 entries).",
  join: "Create a new caller-owned fork. Pass its repoName explicitly to claim. Do not retry blindly.",
  claim:
    "Claim packet paths and bind a fork. Pass the repoName returned by join; omitted means the latest successfully registered fork. Binding is immutable for the claim's life.",
  request_review:
    "Request owner review of an exact fork commit; this does not approve or promote it.",
  submit_work:
    "Commit up to 200 files to the caller's immutable packet claim binding. Inspect status after an uncertain result before retrying.",
};
const readTools = new Set(["get_context", "status", "activity"]);
export interface McpOptions {
  core: CoreClient;
  publicOrigin: string;
  path?: string;
  allowedOrigins?: string[];
  timeoutMs?: number;
}
export function endpointConfig(options: Pick<McpOptions, "publicOrigin" | "path" | "timeoutMs">) {
  const url = new URL(options.publicOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== options.publicOrigin ||
    url.username ||
    url.password
  )
    throw new Error("publicOrigin must be a canonical HTTPS origin from owner configuration.");
  const path = options.path ?? "/mcp";
  if (
    !/^\/[a-zA-Z0-9/_-]+$/.test(path) ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.startsWith("/.well-known") ||
    /^\/(authorize|oauth)(\/|$)/.test(path)
  )
    throw new Error("Invalid MCP path.");
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 30_000)
    throw new Error("Timeout must be below 30 seconds.");
  return { origin: url.origin, path, resource: `${url.origin}${path}`, timeoutMs };
}
export function publicFailure(error: unknown): Response {
  const known = error instanceof PublicError;
  return Response.json(
    { error: known ? error.message : "Operation failed; retry or ask the owner to inspect it." },
    { status: known ? error.status : 502, headers: { "cache-control": "no-store" } },
  );
}

/** Stateless Streamable HTTP (JSON response mode); one server/transport per request. */
export function createMcpHandler(options: McpOptions): (request: Request) => Promise<Response> {
  const config = endpointConfig(options);
  return async (request) => {
    let server: McpServer | undefined;
    try {
      return await boundedCall(
        async (signal) => {
          const url = new URL(request.url);
          if (url.origin !== config.origin || url.pathname !== config.path)
            return new Response(null, { status: 404 });
          const origin = request.headers.get("origin");
          if (origin && ![config.origin, ...(options.allowedOrigins ?? [])].includes(origin))
            throw new PublicError(403, "Origin is not allowed.");
          const token = /^Bearer ([^\s]{1,512})$/i.exec(
            request.headers.get("authorization") ?? "",
          )?.[1];
          const identity = token ? await options.core.authenticate(token, signal) : null;
          if (
            !token ||
            !identity ||
            !slug.safeParse(identity.project).success ||
            !agent.safeParse(identity.agent).success
          ) {
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource${config.path}"`,
                "cache-control": "no-store",
              },
            });
          }
          // This implementation offers request/response only, not a persistent SSE subscription.
          if (request.method !== "POST")
            return new Response(null, { status: 405, headers: { allow: "POST" } });
          const requestBody = await readBounded(request.body, MAX_BYTES - 1, signal);
          const bufferedRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: requestBody,
            redirect: "manual",
            signal,
          });
          signal.throwIfAborted();
          server = new McpServer({ name: brand.slug, title: brand.name, version: "0.1.0" });
          for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
            const readOnly = readTools.has(name);
            server.registerTool(
              name,
              {
                description: descriptions[name],
                inputSchema: schemas[name],
                annotations: {
                  readOnlyHint: readOnly,
                  destructiveHint: !readOnly,
                  idempotentHint: readOnly,
                  openWorldHint: false,
                },
              },
              async (raw: unknown) => {
                try {
                  const args = schemas[name].parse(raw);
                  if (args.project !== identity.project)
                    throw new PublicError(403, "Credential belongs to another project.");
                  let operation: CoreOperation;
                  switch (name) {
                    case "get_context":
                    case "status":
                      operation = { kind: "state", project: args.project };
                      break;
                    case "activity":
                      operation = { kind: "activity", ...schemas.activity.parse(args) };
                      break;
                    case "join": {
                      const input = schemas.join.parse(args);
                      if (input.agent !== identity.agent)
                        throw new PublicError(403, "Credential belongs to another agent.");
                      operation = { kind: "join", ...input };
                      break;
                    }
                    case "claim":
                      operation = { kind: "claim", ...schemas.claim.parse(args) };
                      break;
                    case "request_review":
                      operation = { kind: "review", ...schemas.request_review.parse(args) };
                      break;
                    case "submit_work": {
                      const input = schemas.submit_work.parse(args);
                      const snapshot = z
                        .object({ claims: z.array(z.object({ packet, agent, repoName })) })
                        .parse(
                          await options.core.execute(
                            token,
                            { kind: "state", project: input.project },
                            signal,
                          ),
                        );
                      const matches = snapshot.claims.filter(
                        (claim) => claim.packet === input.packet && claim.agent === identity.agent,
                      );
                      if (matches.length !== 1)
                        throw new PublicError(
                          409,
                          "Exactly one live caller-owned claim binding is required.",
                        );
                      operation = { kind: "commit", ...input, repoName: matches[0]!.repoName };
                      break;
                    }
                  }
                  signal.throwIfAborted();
                  const result = await options.core.execute(token, operation, signal);
                  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
                } catch (error) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text" as const,
                        text:
                          error instanceof PublicError
                            ? error.message
                            : "Tool operation failed; inspect status before retrying a write.",
                      },
                    ],
                  };
                }
              },
            );
          }
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
            maxRequestBodySize: MAX_BYTES - 1,
          });
          await server.connect(transport);
          const response = await transport.handleRequest(bufferedRequest);
          const body = await readBounded(response.body, MAX_BYTES - 1, signal);
          const headers = new Headers(response.headers);
          headers.set("cache-control", "no-store");
          return new Response(body || null, { status: response.status, headers });
        },
        config.timeoutMs,
        request.signal,
      );
    } catch (error) {
      return publicFailure(error);
    } finally {
      void server?.close().catch(() => {});
    }
  };
}
