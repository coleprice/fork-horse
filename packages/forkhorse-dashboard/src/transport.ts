import { stateView } from "./model.ts";
import type {
  ActivityPage,
  DashboardTransport,
  StateResponse,
  OwnerReceipt,
  ReviewDetail,
  ReviewDiff,
} from "./contracts.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface HttpTransportOptions {
  /** Origin is the embedding page's origin. Cross-origin owner calls are refused. */
  origin: string;
  fetch?: typeof fetch;
  /** Optional existing same-origin socket route supplied by the host; no route is invented. */
  socketUrl?: (project: string) => string;
  openSocket?: (url: string) => WebSocket;
}

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

/** Cookie/Access session only: there is deliberately no token or custom-header option. */
export function createHttpTransport(options: HttpTransportOptions): DashboardTransport {
  const origin = new URL(options.origin).origin;
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function call<T>(path: string, method = "GET", body = {}): Promise<T> {
    const response = await request(new URL(path, origin), {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      ...(method === "POST" || method === "PATCH"
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      // Only the core's sanitized {error} convention is displayed; HTML login pages stay out.
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === "string") message = data.error;
      } catch {
        /* Non-JSON errors use the status message above. */
      }
      if (response.status === 401 || response.status === 403) {
        message =
          "Owner session unavailable. Sign in through the configured Access application, then refresh.";
      }
      throw new ApiError(response.status, message);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new ApiError(
        502,
        "Expected a JSON API response. Check the host's Access and API configuration.",
      );
    }
    return (await response.json()) as T;
  }
  return {
    archivePacket: (id, packet) => call(`${projectPath(id)}/packets/${encodeURIComponent(packet)}/archive`, "POST"),
    unarchivePacket: (id, packet) => call(`${projectPath(id)}/packets/${encodeURIComponent(packet)}/unarchive`, "POST"),
    getReview: (id, review) =>
      call<ReviewDetail>(`${projectPath(id)}/reviews/${encodeURIComponent(review)}`),
    getDiff: (id, review, path) =>
      call<ReviewDiff>(
        `${projectPath(id)}/reviews/${encodeURIComponent(review)}/diff?path=${encodeURIComponent(path)}`,
      ),
    returnReview: (id, review, reason) =>
      call(`${projectPath(id)}/reviews/${encodeURIComponent(review)}/return`, "POST", { reason }),
    resolveBlocker: (id, blocker, reason) =>
      call(`${projectPath(id)}/blockers/${encodeURIComponent(blocker)}/resolve`, "POST", { reason }),
    getState: async (id) => stateView(await call<StateResponse>(`${projectPath(id)}/state`)),
    getActivity: (id, after = 0) =>
      call<ActivityPage>(`${projectPath(id)}/activity?after=${after}&limit=100`),
    approve: (id, review) =>
      call(`${projectPath(id)}/reviews/${encodeURIComponent(review)}/approve`, "POST"),
    getReceipt: (id, review) =>
      call<OwnerReceipt>(`${projectPath(id)}/reviews/${encodeURIComponent(review)}/receipt`),
    setSettings: (id, settings) => call(`${projectPath(id)}/settings`, "PATCH", settings),
    promote: (id, review) =>
      call<{ sha: string }>(
        `${projectPath(id)}/reviews/${encodeURIComponent(review)}/promote`,
        "POST",
      ),
    ...(options.socketUrl
      ? {
          subscribe: (id: string, invalidate: () => void) => {
            const expected = new URL(origin);
            expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
            const url = new URL(options.socketUrl!(id), expected);
            if (
              url.origin !== expected.origin ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            ) {
              throw new Error(
                "Activity socket must use the page's origin without credentials or query parameters.",
              );
            }
            const socket = (options.openSocket ?? ((address) => new WebSocket(address)))(url.href);
            socket.addEventListener("message", invalidate);
            socket.addEventListener("open", invalidate);
            // Socket loss is surfaced by the next explicit refresh; writes are never retried.
            return () => {
              socket.removeEventListener("message", invalidate);
              socket.removeEventListener("open", invalidate);
              socket.close();
            };
          },
        }
      : {}),
  };
}
