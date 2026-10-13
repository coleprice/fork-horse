import { body, errorResponse, HttpError, json, operation, slug } from "./http";
import type { Env } from "./types";

export async function dispatchApi(request: Request, env: Env, owner = false): Promise<Response> {
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
      const match = /^\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match || !slug(match[1])) return json({ error: "Not found." }, 404);
      const suffix = match[2]!;
      const methods =
        suffix === "/settings" ? ["PATCH"]
        : /^\/reviews\/[^/]+(?:\/diff)?$/.test(suffix) ? ["GET"]
        : /^\/reviews\/[^/]+\/receipt$/.test(suffix) ? ["GET"]
        : suffix === "/join" ||
        suffix === "/agents" ||
        suffix === "/reviews" ||
        suffix === "/usage" ||
        /^\/agents\/[^/]+\/rotate$/.test(suffix) ||
        /^\/forks\/[^/]+\/(commit|token)$/.test(suffix) ||
        /^\/packets\/[^/]+\/(archive|unarchive)$/.test(suffix) ||
        /^\/blockers\/[^/]+\/resolve$/.test(suffix) ||
        /^\/reviews\/[^/]+\/(approve|promote|return)$/.test(suffix)
          ? ["POST"]
          : /^\/forks\/[^/]+\/tokens$/.test(suffix)
            ? ["DELETE"]
            : /^\/packets\/[^/]+\/claim$/.test(suffix)
              ? ["POST", "DELETE"]
              : suffix === "/packets"
                ? ["GET", "POST"]
                : ["/activity", "/blockers", "/state", "/me"].includes(suffix)
                  ? ["GET"]
                  : [];
      if (!methods.length) return json({ error: "Not found." }, 404);
      if (!methods.includes(request.method)) return json({ error: "Method not allowed." }, 405);
      project = match[1];
    }
    const supervisor = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(project));
    if (!owner) return await supervisor.fetch(request);
    const reply = await supervisor.ownerRequest({
      url: request.url,
      method: request.method,
      body: request.body ? JSON.stringify(await body(request)) : undefined,
    });
    return new Response(reply.body, {
      status: reply.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, { op: operation(request) });
  }
}
