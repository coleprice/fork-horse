/** Public metadata only. Do not turn a credential-bearing URL into an apparently safe link. */
export function publicCoreOrigin(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/") return;
    return url.origin;
  } catch { return; }
}

/** The account supplies only its already authenticated public Core origin, never its credentials. */
export function sidebarWithCoreOrigin(html: string, value: string | undefined): string {
  const origin = publicCoreOrigin(value);
  if (!origin) return html;
  const escaped = origin.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return html.replace('<div id="sidebar">', () => `<div id="sidebar" data-core-origin="${escaped}">`);
}
