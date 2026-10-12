/** Validate an authority-selected HTTPS remote; credentials never belong in this URL. */
export function remoteUrl(remote: string): URL {
  const url = new URL(remote);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || url.pathname === "/" || url.pathname.endsWith("/") ||
      url.href !== remote) throw new Error("Invalid fork remote");
  return url;
}

/** Restrict egress to this fork's Git read protocol. Never follow a credential-bearing redirect. */
export async function forwardGitRead(
  request: Request, remote: string, forward: typeof fetch = fetch,
): Promise<Response> {
  const repo = remoteUrl(remote);
  const url = new URL(request.url);
  const allowed = url.origin === repo.origin && (
    (request.method === "GET" && url.pathname === `${repo.pathname}/info/refs` &&
      url.search === "?service=git-upload-pack") ||
    (request.method === "POST" && url.pathname === `${repo.pathname}/git-upload-pack` && !url.search)
  );
  if (!allowed) return new Response("Forbidden", { status: 403 });
  const headers = new Headers(request.headers);
  headers.set("User-Agent", "git/2.47.0");
  // Only Git protocol headers and the repo-scoped read authorization cross the boundary.
  const safe = new Headers();
  for (const name of ["authorization", "content-type", "accept", "git-protocol", "user-agent"]) {
    const value = headers.get(name);
    if (value) safe.set(name, value);
  }
  return forward(new Request(request, { headers: safe, redirect: "manual" }));
}
