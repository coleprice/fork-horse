import { publicFetch } from "./public";
import { parsePush, projectForRepo } from "./events";
import type { Env } from "./types";
export { ReceiptRunner, GitReadGateway } from "../../forkhorse-runner/src/index";
export { Supervisor } from "./supervisor";

export default {
  fetch: publicFetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = parsePush(message.body);
        if (event && event.source.namespace === env.ARTIFACTS_NAMESPACE) {
          const project = projectForRepo(event.source.repoName);
          if (
            project &&
            !(await env.SUPERVISOR.get(env.SUPERVISOR.idFromName(project)).recordPush(event))
          ) {
            message.retry();
            continue;
          }
        }
        message.ack();
      } catch {
        // Retry provider/storage failures and malformed push envelopes; configure a DLQ.
        // Never acknowledge a push whose complete diff could not be recorded.
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
