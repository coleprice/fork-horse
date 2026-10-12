import type { Activity } from "./types";

export const MAX_STORED_CHANGED_PATHS = 50;

/** Older records predate the count fields; normalize on read without a migration. */
export type StoredActivity = Omit<Activity, "changedPathCount" | "changedPathsTruncated"> &
  Partial<Pick<Activity, "changedPathCount" | "changedPathsTruncated">>;

export function capActivity(entry: StoredActivity): Activity {
  // Preserve the original total when an already capped record is served again.
  const changedPathCount = entry.changedPathCount ?? entry.changedPaths.length;
  return {
    ...entry,
    changedPaths: entry.changedPaths.slice(0, MAX_STORED_CHANGED_PATHS),
    changedPathCount,
    changedPathsTruncated: changedPathCount > MAX_STORED_CHANGED_PATHS,
  };
}
