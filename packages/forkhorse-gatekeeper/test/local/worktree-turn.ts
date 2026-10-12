// Local harness adapted from the pinned OS worktree-session tests. The overlay only supplies
// the agent turn boundary; worktree creation, file operations, commits and storage are real OS code.
import { applyCodeChange, type CodeChange, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { WorktreeSessionImpl } from "../../../../cloudflare-os/packages/workshop-backend/src/worktree-session.ts";
import type { WorktreeTurnAccess } from "../../../../cloudflare-os/packages/workshop-backend/src/agent.ts";
const USER = { type: "user" as const, id: "agent@idiot.tax", name: "Fixture Agent" };
const AGENT = { type: "agent" as const, id: "fixture", name: "Fixture Agent" };
function makeTurn(impl: any, chatId: number) {
  let content = new Map<number, Map<string, string>>();
  let removed = new Map<number, Set<string>>();
  let pins = new Map<number, string>();
  let changes: { change: CodeChange }[] = [];
  let commits: { worktreeId: number, commit: string, previousHead: string }[] = [];
  let baseCommit = (id: number): string | undefined =>
      pins.get(id) ?? impl.getWorktreePinBase(id);
  let pin = (id: number) => {
    if (!pins.has(id)) pins.set(id, impl.getWorktreePinBase(id));
  };

  let access: WorktreeTurnAccess = {
    getBaseCommit: baseCommit,
    getBufferedHead: id => commits.findLast(entry => entry.worktreeId === id)?.commit,
    getOverlayFiles: id => content.get(id) ?? new Map(),
    getRemovedPaths: id => removed.get(id) ?? new Set(),
    readFile: async (id, path) => {
      let existing = content.get(id)?.get(path);
      if (existing !== undefined) return existing;
      if (removed.get(id)?.has(path)) return undefined;
      let base = baseCommit(id);
      if (base === undefined) return undefined;
      let text = await impl.readFileAtCommit(base, path);
      if (text === undefined) return undefined;
      let files = new Map(content.get(id));
      files.set(path, text);
      content.set(id, files);
      return text;
    },
    appendChange: (id, path, change) => {
      let one: CodeChange = { [id]: [[path, change]] };
      let updated: CodeContent = applyCodeChange(new Map([[id, content.get(id) ?? new Map()]]), one);
      content.set(id, new Map(updated.get(id)));
      if ("remove" in change) {
        let set = removed.get(id);
        if (set === undefined) removed.set(id, set = new Set());
        set.add(path);
      } else {
        removed.get(id)?.delete(path);
      }
      changes.push({ change: one });
      pin(id);
    },
    appendCommit: (id, commit, previousHead) => {
      commits.push({ worktreeId: id, commit, previousHead });
      pin(id);
    },
  };

  return {
    access,
    pins,
    bufferedChanges: changes,
    bufferedCommits: commits,
    session: (id: number) => new WorktreeSessionImpl(impl, id, access, async () => USER),
    barrier: async () => impl.commitAgentStep(
        chatId, AGENT, [{ type: "message", message: "step" }],
        { changes: changes.splice(0), createdGadgets: [], createdWorktrees: [],
          addedBindings: [], worktreeCommits: commits.splice(0) }),
  };
}

// Creates a worktree through the barrier and returns a session over it. The worktree is
// unpinned: the session resolves against its accepted commit until the first write or commit.
export async function createWorktreeSession(impl: any, chatId: number, commitId: string) {
  let created = await impl.createWorktree("Repo", chatId, commitId);
  await impl.commitAgentStep(chatId, AGENT, [{ type: "message", message: "create" }], {
    changes: [],
    createdGadgets: [],
    createdWorktrees: [{ worktreeId: created.id, title: created.title, bindingName: "REPO" }],
    addedBindings: [],
    worktreeCommits: [],
  });
  let turn = makeTurn(impl, chatId);
  return { id: created.id, baseCommit: created.baseCommit, turn,
           session: turn.session(created.id) };
}
