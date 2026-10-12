import { HttpError } from "./http";

/** Literal repository paths; a trailing slash and double star denotes a subtree. */
export function claimPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return filePath(value.endsWith("/**") ? value.slice(0, -3) : value);
}
export function filePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    // Control bytes and Windows separators cannot denote portable repository paths.
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[\\*?[\]{}:]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          !part.endsWith(".") &&
          !part.endsWith(" "),
      )
  );
}
function root(path: string): string {
  return path.replace(/\/\*\*$/, "");
}
/** A plain path also claims descendants; sibling prefixes do not overlap. */
export function overlaps(a: string, b: string): boolean {
  a = root(a);
  b = root(b);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
export function covers(claim: string, path: string): boolean {
  claim = root(claim);
  return path === claim || path.startsWith(claim + "/");
}
export function requireCovered(paths: string[], files: string[]): void {
  if (files.some((file) => !paths.some((path) => covers(path, file))))
    throw new HttpError(403, "Files must be inside the packet's claimed paths.");
}
