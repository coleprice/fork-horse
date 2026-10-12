import { isRecord, slug } from "./http";
import type { PushEvent } from "./types";

export function parsePush(value: unknown): PushEvent | null {
  if (!isRecord(value) || value.type !== "cf.artifacts.repo.pushed") return null;
  const { source, payload, metadata } = value;
  if (
    !isRecord(source) ||
    !isRecord(payload) ||
    !isRecord(metadata) ||
    typeof source.namespace !== "string" ||
    typeof source.repoName !== "string" ||
    typeof payload.ref !== "string" ||
    !payload.ref.startsWith("refs/") ||
    payload.ref.length > 1024 ||
    typeof payload.before !== "string" ||
    !/^[0-9a-f]{40}$/.test(payload.before) ||
    typeof payload.after !== "string" ||
    !/^[0-9a-f]{40}$/.test(payload.after) ||
    typeof metadata.eventTimestamp !== "string" ||
    !Number.isFinite(Date.parse(metadata.eventTimestamp))
  ) {
    throw new Error("Malformed push event");
  }
  return {
    type: "cf.artifacts.repo.pushed",
    source: { namespace: source.namespace, repoName: source.repoName },
    payload: { ref: payload.ref, before: payload.before, after: payload.after },
    metadata: { eventTimestamp: metadata.eventTimestamp },
  };
}

export function projectForRepo(repoName: string): string | null {
  const project = repoName.split("--")[0];
  return slug(project) ? project : null;
}
