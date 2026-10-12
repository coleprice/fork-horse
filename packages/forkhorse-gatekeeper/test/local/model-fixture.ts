// Deterministic protocol fixture, not an AI model. It emits only the local S7 tool sequence.
import type { ServerResponse } from "node:http";
let step = 0;
export function modelFixture(body: Buffer, res: ServerResponse, head: string): void {
  const request = JSON.parse(body.toString());
  const agent = request.tools?.some((tool: { name: string }) => tool.name === "createWorktree");
  let name: string | undefined, input: Record<string, unknown> = {};
  if (agent) {
    const transcript = JSON.stringify(request.messages);
    const committed = [...transcript.matchAll(/LOCAL_COMMIT=([a-f0-9]{40})/g)].at(-1)?.[1];
    const code = (value: string) => { name = "executeCode"; input = { code: `export default async function(self, env, ctx) { ${value} }` }; };
    switch (step++) {
      case 0: code('console.log(JSON.stringify(await env.FORK.getHead()));'); break;
      case 1: name = "createWorktree"; input = { title: "Synthetic S7 worktree", bindingName: "REPO", commitId: head }; break;
      case 2: code('console.log("BEFORE=" + await env.REPO.readFile("README.md")); await env.REPO.writeFile("README.md", "After full run-local approval\\n"); console.log("LOCAL_COMMIT=" + await env.REPO.commit("Synthetic full OS acceptance"));'); break;
      case 3:
        if (!committed) throw new Error("Synthetic model fixture did not receive a worktree commit");
        code(`await env.FORK.push("main", "${committed}"); console.log("LOCAL_APPROVAL_QUEUED");`); break;
    }
    console.log(`LOCAL MODEL FIXTURE step=${step} tool=${name ?? "complete"}`);
  }
  const content = name ? { type: "tool_use", id: `fixture_tool_${step}`, name, input } : { type: "text", text: "Synthetic local acceptance complete. No inference was performed." };
  const message = { id: `fixture_${step}`, type: "message", role: "assistant", model: request.model,
    content: [content], stop_reason: name ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
  if (!request.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
  res.setHeader("content-type", "text/event-stream");
  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: { ...message, content: [], stop_reason: null } });
  event("content_block_start", { index: 0, content_block: name ? { ...content, input: {} } : { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: name ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: (content as { text: string }).text } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 50 } });
  event("message_stop", {}); res.end();
}
