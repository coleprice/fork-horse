export interface ConnectionDraft {
  coreOrigin: string;
  project: string;
  agentCredential: string;
}

export interface DraftStatus {
  coreOrigin: string;
  project: string;
  connectionAvailable: false;
  message: string;
}

export const CONNECTION_HELD = "This fixture checks format only. Open the account connection popup to connect.";

/** Format checking only. Never fetch, store, echo or infer identity from an entered credential. */
export function checkConnectionDraft(draft: ConnectionDraft): DraftStatus {
  if (!draft || typeof draft.coreOrigin !== "string" || draft.coreOrigin.length > 2048)
    throw new Error("Enter a public HTTPS core origin.");
  let url: URL;
  try { url = new URL(draft.coreOrigin.trim()); }
  catch { throw new Error("Enter a public HTTPS core origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || (url.port && url.port !== "443") ||
      !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") ||
      /\.(localhost|local|internal|invalid)$/.test(url.hostname))
    throw new Error("Enter a public HTTPS core origin without a path, credentials or query.");
  if (typeof draft.project !== "string" || draft.project.length > 48 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.project))
    throw new Error("Enter a lowercase project ID of at most 48 characters.");
  if (typeof draft.agentCredential !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(draft.agentCredential))
    throw new Error("Enter an enrolled agent credential without spaces (16 to 256 characters).");
  return {
    coreOrigin: url.origin,
    project: draft.project,
    connectionAvailable: false,
    message: CONNECTION_HELD,
  };
}
