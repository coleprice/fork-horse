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

export function errorResponse(error: unknown): Response {
  // Provider exceptions may contain credentials; never echo or log their text.
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: "Repository operation failed; retry or ask the owner to inspect it." }, 502);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function slug(value: unknown, max = 48): value is string {
  return (
    typeof value === "string" && value.length <= max && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  // Bound buffering even when Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON object is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new HttpError(413, "Request body exceeds 16 KiB.");
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
