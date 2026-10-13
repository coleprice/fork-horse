/** Verified core identity. The FH-012 adapter must reject owner credentials. */
export interface AgentIdentity {
  project: string;
  agent: string;
}
/** A live, immutable D1 binding returned by core. */
export interface ClaimBinding {
  packet: string;
  agent: string;
  repoName: string;
}
export interface StateSnapshot {
  claims: ClaimBinding[];
  packets?: { id: string; mode?: "standard" | "race"; [key: string]: unknown }[];
  races?: import("./races").RaceState[];
  [key: string]: unknown;
}
export interface WorkFile {
  path: string;
  content: string;
}
/** Owner identity supplied only after FH-012 verifies its Access JWT and owner policy. */
export interface OwnerIdentity {
  subject: string;
}
export interface EnrolledAgent extends AgentIdentity {
  apiToken: string;
}

export type CoreOperation =
  | { kind: "state"; project: string }
  | { kind: "me"; project: string }
  | { kind: "refresh_token"; project: string; repoName: string; ttlSeconds: number }
  | { kind: "activity"; project: string; after?: number; limit?: number }
  | { kind: "join"; project: string; agent: string; ttlSeconds?: number }
  | { kind: "claim"; project: string; packet: string; repoName?: string }
  | { kind: "review"; project: string; packet: string; repoName: string; sha: string }
  | { kind: "review_detail"; project: string; review: string }
  | { kind: "review_diff"; project: string; review: string; path: string }
  | { kind: "verdict"; project: string; packet: string; ranking: string[]; rationale: string }
  | {
      kind: "commit";
      project: string;
      packet: string;
      repoName: string;
      files: WorkFile[];
      message: string;
    };

/** Narrow adapter seam: no owner HTTP route is reachable through an MCP operation. */
export interface CoreClient {
  authenticate(token: string, signal: AbortSignal): Promise<AgentIdentity | null>;
  execute(token: string, operation: CoreOperation, signal: AbortSignal): Promise<unknown>;
  /** Maps to FH-005 enrollment, using owner authority held inside the adapter. */
  enrollAgent(
    owner: OwnerIdentity,
    project: string,
    agent: string,
    signal: AbortSignal,
  ): Promise<EnrolledAgent>;
}

/** Public messages are fixed locally; provider exception text must never reach clients. */
export class PublicError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const MAX_BYTES = 1024 * 1024;
export const CALL_TIMEOUT_MS = 25_000;

export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max = MAX_BYTES - 1,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  signal?.throwIfAborted();
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => {});
        throw new PublicError(413, "Payload exceeds the supported size.");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Whole-call deadline includes authorization, core I/O, and response buffering. */
export async function boundedCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CALL_TIMEOUT_MS,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const abort = new AbortController();
  let onParentAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    onParentAbort = () => {
      abort.abort();
      reject(new PublicError(504, "Call cancelled; inspect status before retrying a write."));
    };
    parent?.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(() => {
      abort.abort();
      reject(new PublicError(504, "Call timed out; inspect status before retrying a write."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
    if (onParentAbort) parent?.removeEventListener("abort", onParentAbort);
    abort.abort();
  }
}

/** Exact FH-003/FH-005 route mapping; this Request goes to a trusted binding, never public fetch. */
export function coreRequest(token: string, operation: CoreOperation, signal: AbortSignal): Request {
  const component = encodeURIComponent;
  const base = `/projects/${component(operation.project)}`;
  let path: string;
  let data: unknown;
  switch (operation.kind) {
    case "state":
      path = `${base}/state`;
      break;
    case "me":
      path = `${base}/me`;
      break;
    case "refresh_token":
      path = `${base}/forks/${component(operation.repoName)}/token`;
      data = { scope: "write", ttlSeconds: operation.ttlSeconds };
      break;
    case "activity": {
      const query = new URLSearchParams();
      if (operation.after !== undefined) query.set("after", String(operation.after));
      if (operation.limit !== undefined) query.set("limit", String(operation.limit));
      path = `${base}/activity?${query}`;
      break;
    }
    case "join":
      path = `${base}/join`;
      data = { agent: operation.agent, ttlSeconds: operation.ttlSeconds };
      break;
    case "claim":
      path = `${base}/packets/${component(operation.packet)}/claim`;
      data = { repoName: operation.repoName };
      break;
    case "review":
      path = `${base}/reviews`;
      data = { repoName: operation.repoName, sha: operation.sha, packet: operation.packet };
      break;
    case "review_detail":
      path = `${base}/reviews/${component(operation.review)}`;
      break;
    case "review_diff": {
      const query = new URLSearchParams({ path: operation.path });
      path = `${base}/reviews/${component(operation.review)}/diff?${query}`;
      break;
    }
    case "verdict":
      path = `${base}/races/${component(operation.packet)}/verdict`;
      data = { ranking: operation.ranking, rationale: operation.rationale };
      break;
    case "commit":
      path = `${base}/forks/${component(operation.repoName)}/commit`;
      data = { packet: operation.packet, files: operation.files, message: operation.message };
      break;
  }
  const body = data === undefined ? undefined : JSON.stringify(data);
  if (body && new TextEncoder().encode(body).byteLength > MAX_BYTES)
    throw new PublicError(413, "Commit exceeds 1 MiB.");
  return new Request(`https://core.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal,
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
}

/** Compose the HTTP part with trusted auth/enrollment capabilities supplied by FH-012. */
export function createCoreClient(
  options: Pick<CoreClient, "authenticate" | "enrollAgent"> & {
    fetch(request: Request): Promise<Response>;
  },
): CoreClient {
  return {
    authenticate: options.authenticate,
    enrollAgent: options.enrollAgent,
    async execute(token, operation, signal) {
      signal.throwIfAborted();
      const response = await options.fetch(coreRequest(token, operation, signal));
      // workerd supports manual redirect handling, not the Fetch "error" mode.
      // Refuse every upstream 3xx without reading or exposing its Location/body.
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new PublicError(502, "Core redirect refused.");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = [400, 401, 403, 404, 409, 413, 429].includes(response.status)
          ? response.status
          : 502;
        throw new PublicError(
          status,
          status === 409
            ? "Core conflict; refresh status before retrying."
            : `Core request refused (${status}).`,
        );
      }
      try {
        return JSON.parse(await readBounded(response.body, MAX_BYTES - 1, signal));
      } catch (error) {
        if (error instanceof PublicError) throw error;
        throw new PublicError(502, "Core returned an invalid response.");
      }
    },
  };
}
