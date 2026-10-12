import type { Env } from "./types";

export interface RepoEvents {
  namespace: string;
  repoName: string;
  events: "pending" | "active";
  subscriptionId?: string;
  attempts: number;
  retryAt: number;
}
const prefix = "repoEvents:";
const backoff = (attempts: number) => Math.min(30_000 * 2 ** Math.min(attempts, 7), 3_600_000);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value);

/** Keep the registry's membership value unchanged; subscription state lives beside it. */
export async function registerEvents(
  storage: DurableObjectTransaction,
  namespace: string,
  repoName: string,
): Promise<void> {
  const retryAt = Date.now() + backoff(0);
  await storage.put(`${prefix}${repoName}`, {
    namespace, repoName, events: "pending", attempts: 0, retryAt,
  } satisfies RepoEvents);
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > retryAt) await storage.setAlarm(retryAt);
}

export async function publicEvents(storage: DurableObjectStorage, repoName: string) {
  const record = await storage.get<RepoEvents>(`${prefix}${repoName}`);
  return {
    events: record?.events ?? "pending",
    ...(record?.subscriptionId && { subscriptionId: record.subscriptionId }),
  };
}

interface Subscription {
  id: string;
  enabled: boolean;
  source: { type: string; namespace: string; repo_name: string };
  destination: { type: string; queue_id: string };
  events: string[];
}

/** Matches Wrangler 4.149.0 queues/client.ts and subscription/create.ts.
 * Queue ID is owner-resolved so this token never needs Queue Read permission.
 * Only fixed-origin requests; no redirects, provider errors, or bodies escape.
 */
export class EventSubscriptions {
  constructor(private storage: DurableObjectStorage, private env: Env) {}

  private async ensure(record: RepoEvents): Promise<string> {
    const { CF_ACCOUNT_ID: account, CF_EVENTS_API_TOKEN: token, PUSH_QUEUE_ID: queue } = this.env;
    if (!identifier(account) || !identifier(queue) || !token)
      throw new Error("Event subscription configuration is incomplete.");
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/event_subscriptions/subscriptions`;
    const signal = AbortSignal.timeout(10_000);
    const request = async (url: string, payload?: unknown) => {
      const response = await fetch(url, {
        method: payload ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: "manual",
        signal,
      });
      if (!response.ok) throw new Error("Event subscription request failed.");
      const envelope = await response.json<{ success: boolean; result: unknown }>();
      if (envelope.success !== true) throw new Error("Event subscription request failed.");
      return envelope.result;
    };
    // Scan every page before creating. An incomplete listing must never imply absence.
    for (let page = 1; page <= 100; page++) {
      const result = await request(`${endpoint}?${new URLSearchParams({ queue_id: queue, page: String(page), per_page: "20" })}`);
      if (!Array.isArray(result)) throw new Error("Invalid subscription listing.");
      const existing = result.find((value: Subscription | null) =>
        value && identifier(value.id) && value.enabled === true &&
        value.source?.type === "artifacts.repo" &&
        value.source.namespace === record.namespace && value.source.repo_name === record.repoName &&
        value.destination?.type === "queues.queue" && value.destination.queue_id === queue &&
        Array.isArray(value.events) && value.events.includes("pushed"),
      );
      if (existing) return existing.id;
      if (result.length < 20) {
        const created = await request(endpoint, {
          name: `${record.namespace}/${record.repoName} pushed`,
          enabled: true,
          source: { type: "artifacts.repo", namespace: record.namespace, repo_name: record.repoName },
          destination: { type: "queues.queue", queue_id: queue },
          events: ["pushed"],
        }) as Subscription | null;
        if (!created || !identifier(created.id)) throw new Error("Invalid subscription result.");
        return created.id;
      }
    }
    throw new Error("Subscription listing limit reached.");
  }

  private async schedule(): Promise<void> {
    const records = await this.storage.list<RepoEvents>({ prefix });
    const pending = [...records.values()].filter((record) => record.events === "pending");
    if (pending.length) await this.storage.setAlarm(Math.min(...pending.map((record) => record.retryAt)));
    else await this.storage.deleteAlarm();
  }

  async attempt(repoName: string): Promise<void> {
    const key = `${prefix}${repoName}`;
    const record = await this.storage.get<RepoEvents>(key);
    if (!record || record.events === "active") return;
    // Advance and arm recovery BEFORE external I/O. A crash after POST is recovered by LIST.
    record.retryAt = Date.now() + backoff(record.attempts);
    record.attempts++;
    await this.storage.transaction(async (txn) => {
      await txn.put(key, record);
      await this.schedule();
    });
    let subscriptionId: string;
    try {
      subscriptionId = await this.ensure(record);
    } catch {
      // Never log or persist provider bodies/errors (they may echo authorization headers).
      return;
    }
    await this.storage.transaction(async (txn) => {
      await txn.put(key, { ...record, events: "active", subscriptionId } satisfies RepoEvents);
      await this.schedule();
    });
  }

  async alarm(): Promise<void> {
    const records = await this.storage.list<RepoEvents>({ prefix });
    // Bound one alarm's external work; remaining due records retain an immediate alarm.
    const due = [...records.values()]
      .filter((record) => record.events === "pending" && record.retryAt <= Date.now())
      .toSorted((a, b) => a.retryAt - b.retryAt).slice(0, 10);
    for (const record of due) await this.attempt(record.repoName);
    await this.schedule();
  }
}
