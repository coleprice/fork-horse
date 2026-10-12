import brand from "../../../brand.json" with { type: "json" };

const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

/** Identity only: draw text in the viewer's font; distribute no platform emoji artwork. */
export function markIconUrl(mark: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="${escapeXml(brand.name)}"><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, emoji, sans-serif" font-size="84">${escapeXml(mark)}</text></svg>`;
  // encodeURIComponent leaves apostrophes literal; encode them for either HTML quote style.
  return `data:image/svg+xml,${encodeURIComponent(svg).replaceAll("'", "%27")}`;
}
