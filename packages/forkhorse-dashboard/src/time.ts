/** Relative copy shared by activity, receipt history and running-check captions. */
export function relativeTime(
  value: string,
  now = Date.now(),
  maxUnit: "day" | "hour" = "day",
): string {
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000 || maxUnit === "hour")
    return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  const days = Math.floor(elapsed / 86_400_000);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
