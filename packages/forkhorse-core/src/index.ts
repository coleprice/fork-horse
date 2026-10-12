import { body, errorResponse, HttpError, json, slug } from "./http";
import { parsePush, projectForRepo } from "./events";
import { ZERO_SHA } from "./trees";
import type { Env } from "./types";
export { Supervisor } from "./supervisor";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      let project: string;
      if (request.method === "POST" && url.pathname === "/projects") {
        const data = await body(request);
        if (!slug(data.id))
          throw new HttpError(400, "id must be a lowercase slug of at most 48 characters.");
        project = data.id;
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(data),
        });
      } else {
        const match = /^\/projects\/([^/]+)\/(join|activity)$/.exec(url.pathname);
        if (!match || !slug(match[1])) return json({ error: "Not found." }, 404);
        if (
          (match[2] === "join" && request.method !== "POST") ||
          (match[2] === "activity" && request.method !== "GET")
        )
          return json({ error: "Method not allowed." }, 405);
        project = match[1];
      }
      return await env.SUPERVISOR.get(env.SUPERVISOR.idFromName(project)).fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = parsePush(message.body);
        if (
          event &&
          event.source.namespace === env.ARTIFACTS_NAMESPACE &&
          event.payload.after !== ZERO_SHA
        ) {
          const project = projectForRepo(event.source.repoName);
          if (
            project &&
            !(await env.SUPERVISOR.get(env.SUPERVISOR.idFromName(project)).recordPush(event))
          ) {
            message.retry();
            continue;
          }
        }
        message.ack();
      } catch {
        // Retry provider/storage failures and malformed push envelopes; configure a DLQ.
        // Never acknowledge a push whose complete diff could not be recorded.
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
