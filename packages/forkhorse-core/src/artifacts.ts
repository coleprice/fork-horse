import { ZERO_SHA } from "./trees";
import type { Repository } from "./types";

/** Artifacts log resolves bare branch names, unlike Git wire refs. */
export async function branchHead(repo: Repository, branch: string): Promise<string> {
  return (await repo.log({ ref: branch, limit: 1 }))[0]?.hash ?? ZERO_SHA;
}
