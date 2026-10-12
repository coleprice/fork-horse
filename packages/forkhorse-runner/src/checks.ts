import type { Check, ForkRepository } from "./types";

export const CHECKS_PATH = ".forkhorse/checks";
export const MAX_CONFIG_BYTES = 32_768;

export function parseChecks(text: string): Check[] {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) throw new Error("Checks file too large");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error("Expected 1–16 checks");
  const names = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid check");
    const check = item as Record<string, unknown>;
    if (Object.keys(check).toSorted().join() !== "image,name,run,tier" ||
        typeof check.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(check.name) ||
        names.has(check.name) || check.tier !== "full" ||
        typeof check.image !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(check.image) ||
        typeof check.run !== "string" || !check.run.trim() || check.run.length > 8192 ||
        check.run.includes("\0")) throw new Error("Invalid check");
    names.add(check.name);
    return { name: check.name, tier: "full", image: check.image, run: check.run };
  });
}

/** Resolve the regular checks blob from the exact authorized commit, never a moving ref. */
export async function loadChecks(repo: ForkRepository, commit: string): Promise<Check[]> {
  const metadata = await repo.readCommit(commit);
  if (!metadata || metadata.hash !== commit) throw new Error("Commit unavailable");
  const root = await repo.readTree(metadata.treeHash);
  const dir = root?.find((entry) => entry.name === ".forkhorse" && entry.type === "tree");
  if (!dir) throw new Error("Missing checks directory");
  const tree = await repo.readTree(dir.hash);
  const file = tree?.find((entry) => entry.name === "checks" && entry.type === "blob");
  if (!file) throw new Error("Missing regular checks file");
  const blob = await repo.readBlob(file.hash);
  if (!blob || blob.size > MAX_CONFIG_BYTES) throw new Error("Checks file unavailable or too large");
  return parseChecks(await blob.text());
}
