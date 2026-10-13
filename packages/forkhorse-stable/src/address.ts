export interface ForkAddressInput {
  /** Canonical HTTPS origin from the connected account's configuration. */
  origin: string;
  project: string;
  repoName: string;
}

/** Matches core's project slug grammar, without accepting a trailing newline. */
export function isProjectSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 48 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !/[^a-z0-9-]/.test(value);
}

/** No normalization: a caller must supply the configured origin, never a URL path. */
export function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Address construction only; ownership and project access remain server checks. */
export function forkAddress({ origin, project, repoName }: ForkAddressInput): string {
  if (!isHttpsOrigin(origin)) throw new Error("A canonical HTTPS origin is required.");
  if (!isProjectSlug(project)) throw new Error("Invalid project slug.");
  // Core creates names as project--agent-counter. Require exactly one delimiter;
  // the suffix is a slug, while allocation and counter semantics remain in core.
  if (typeof repoName !== "string" || repoName.length > 128 ||
      !repoName.startsWith(`${project}--`)) throw new Error("Invalid fork repository name.");
  const suffix = repoName.slice(project.length + 2);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix) || /[^a-z0-9-]/.test(suffix)) {
    throw new Error("Invalid fork repository name.");
  }
  return `${origin}/projects/${project}/forks/${repoName}`;
}
