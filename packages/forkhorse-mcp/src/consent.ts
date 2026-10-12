import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { PublicError } from "./core";

/** D8 requires exact registration matching, including loopback ports, before consent/enrollment. */
export async function requireRegisteredRedirect(oauth: OAuthHelpers, request: AuthRequest) {
  const client = await oauth.lookupClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) {
    throw new PublicError(400, "Redirect URI must exactly match client registration.");
  }
}

/** Emit a browser response, never fetch its Location. Preserve the registered callback and query. */
export function consentRedirect(
  request: AuthRequest,
  redirectTo: string,
  headers: Headers,
  decision: "approve" | "deny",
): Response {
  const expected = new URL(request.redirectUri);
  if (decision === "approve") {
    const code = new URL(redirectTo).searchParams.get("code");
    if (!code) throw new PublicError(502, "OAuth consent redirect refused.");
    expected.searchParams.set("code", code);
  } else {
    for (const key of ["error", "error_description", "error_uri", "state", "iss"]) {
      expected.searchParams.delete(key);
    }
    expected.searchParams.set("error", "access_denied");
  }
  if (request.state) expected.searchParams.set("state", request.state);
  if (request.issuer) expected.searchParams.set("iss", request.issuer);
  // Only the OAuth result fields may differ from the exact registered redirect_uri.
  // Comparing the whole generated URL also rejects changed paths, query values, fragments,
  // duplicate result fields, or extra parameters in a wrapped provider's response.
  if (redirectTo !== expected.href) throw new PublicError(502, "OAuth consent redirect refused.");
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}
