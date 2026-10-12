export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const operations = [
  "request", "project.create", "project.join", "fork.commit", "review.create",
  "review.approve", "review.promote", "dashboard", "oauth",
] as const;
const stages = ["heads", "prepare", "pending", "token", "push", "ledger"] as const;
export interface ErrorContext {
  op: typeof operations[number];
  stage?: typeof stages[number];
}

/** Static labels only: project IDs, fork names, review IDs and query strings never enter logs. */
export function operation(request: Request): ErrorContext["op"] {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    if (path === "/projects") return "project.create";
    if (/^\/projects\/[^/]+\/join$/.test(path)) return "project.join";
    if (/^\/projects\/[^/]+\/forks\/[^/]+\/commit$/.test(path)) return "fork.commit";
    if (/^\/projects\/[^/]+\/reviews$/.test(path)) return "review.create";
    if (/^\/projects\/[^/]+\/reviews\/[^/]+\/approve$/.test(path)) return "review.approve";
    if (/^\/projects\/[^/]+\/reviews\/[^/]+\/promote$/.test(path)) return "review.promote";
  }
  if (path === "/app" || path.startsWith("/app/")) return "dashboard";
  if (path === "/mcp" || path === "/authorize" || path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return "oauth";
  return "request";
}

function errorField(error: unknown, key: string): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return;
  try {
    return Reflect.get(error, key);
  } catch {
    // A provider's accessor must not hide the original failure or expose its exception.
    return;
  }
}
function tag(value: unknown): string | undefined {
  // Test every character, including trailing newlines; never coerce provider values.
  return typeof value === "string" && value.length >= 1 && value.length <= 64 &&
    !/[^A-Za-z0-9_.-]/.test(value) ? value : undefined;
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value : undefined;
}

export function errorResponse(error: unknown, context: ErrorContext = { op: "request" }): Response {
  // Provider messages, stacks and nested objects never enter either output.
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const id = crypto.randomUUID();
  console.error(JSON.stringify({
    event: "core.error",
    id,
    op: operations.includes(context.op) ? context.op : "request",
    stage: context.stage && stages.includes(context.stage) ? context.stage : undefined,
    name: tag(errorField(error, "name")),
    code: tag(errorField(error, "code")),
    status: httpStatus(errorField(error, "status")) ?? httpStatus(errorField(error, "statusCode")),
  }));
  return json({
    error: "Repository operation failed; retry or ask the owner to inspect it.",
    diagnosticId: id,
  }, 502);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function slug(value: unknown, max = 48): value is string {
  return (
    typeof value === "string" && value.length <= max && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export async function body(request: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  // Bound buffering even when Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON object is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isRecord(parsed)) return parsed;
  } catch {
    /* Report a bounded public error below. */
  }
  throw new HttpError(400, "A JSON object is required.");
}

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bearerHash(request: Request): Promise<string> {
  const match = /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) throw new HttpError(401, "A bearer token is required.");
  return digest(match[1]);
}

export function equalHash(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
