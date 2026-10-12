export class CliError extends Error {}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function slug(value: string | undefined, max = 48): string {
  if (!value || value.length > max || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    throw new CliError("Expected a lowercase ID with single internal hyphens.");
  return value;
}

export function endpoint(value: unknown, originOnly = false): URL {
  if (typeof value !== "string") throw new CliError("A base URL is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("Invalid endpoint URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== "/")
  )
    throw new CliError(
      "Use an HTTPS origin (loopback HTTP is for fixtures only), without credentials, query or fragment.",
    );
  return url;
}

// Redact credential fields at every depth, plus credentials embedded in ordinary text/keys.
// Error bodies are never rendered at all. Core's agent API tokens have the api_ prefix.
export function redact(value: unknown, owner: string): unknown {
  const clean = (text: string) =>
    (owner ? text.split(owner).join("[REDACTED]") : text)
      .replace(/api_[a-zA-Z0-9_-]+/g, "[REDACTED]")
      .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED]");
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, owner));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        clean(key),
        /token|secret|password|credential|authorization|cookie|hash/i.test(key)
          ? "[REDACTED]"
          : redact(item, owner),
      ]),
    );
  return value;
}

export class Api {
  private base: URL;
  private owner: string;
  private signal: AbortSignal;

  constructor(base: URL, owner: string, signal: AbortSignal) {
    this.base = base;
    this.owner = owner;
    this.signal = signal;
  }

  async request(path: string, data?: unknown): Promise<Record<string, unknown>> {
    const encoded = data === undefined ? undefined : JSON.stringify(data);
    if (encoded && Buffer.byteLength(encoded) > 16384)
      throw new CliError("Request exceeds core's 16 KiB body limit.");
    try {
      const response = await fetch(new URL(path, this.base), {
        method: encoded === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.owner}`, "content-type": "application/json" },
        body: encoded,
        redirect: "manual",
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(25000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CliError(
          `Core returned HTTP ${response.status}; inspect state before retrying writes.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CliError("Core returned an empty response.");
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          throw new CliError("Core response exceeds 1 MiB.");
        }
        chunks.push(value);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(parsed)) throw new CliError("Core returned an invalid JSON object.");
      return parsed;
    } catch (error) {
      if (error instanceof CliError) throw error;
      // Native fetch/JSON errors may include URLs, credentials or response text.
      throw new CliError("Core request failed or timed out; inspect state before retrying writes.");
    }
  }
}
