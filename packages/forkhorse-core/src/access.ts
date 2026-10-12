import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";
import { HttpError } from "./http";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessSettings(env: Env) {
  const issuer = env.CORE_ACCESS_ISSUER;
  const audience = env.CORE_ACCESS_AUDIENCE;
  const owners = env.CORE_ACCESS_OWNERS;
  // Only the configured Access team can supply keys; JWT jku/x5u headers are never followed.
  if (
    !issuer ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience?.trim() ||
    audience !== audience.trim() ||
    !Array.isArray(owners) ||
    !owners.length ||
    !owners.every((email) => typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email))
  ) {
    throw new HttpError(503, "Owner Access configuration is incomplete.");
  }
  return { issuer, audience, owners: owners.map((email) => email.toLowerCase()) };
}

/** Trust only a signed, current Access application JWT and an explicitly allowed owner. */
export async function verifyOwner(request: Request, env: Env): Promise<{ subject: string } | null> {
  const { issuer, audience, owners } = accessSettings(env);
  // /projects also serves bearer agents, so it is not behind an interactive edge login.
  // Same-origin owner requests carry the Access application cookie; verify that JWT identically.
  const cookie = request.headers.get("cookie") ?? "";
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    (cookie.length <= 32768 ? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] : undefined);
  if (!token || token.length > 16384) return null;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 300000,
    });
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "exp", "iat"],
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.email !== "string" ||
      !owners.includes(payload.email.toLowerCase()) ||
      payload.iat! > Date.now() / 1000
    )
      return null;
    return { subject: payload.sub };
  } catch {
    return null;
  }
}
