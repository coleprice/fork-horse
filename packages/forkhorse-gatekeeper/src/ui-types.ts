import type { RpcTarget } from "capnweb";
import type { ProjectState } from "../../forkhorse-dashboard/src/contracts.ts";

/** One credential-free, project-bound snapshot. Version is local to this UI session. */
export interface SidebarBatch {
  version: number;
  state: ProjectState;
}

export interface UpdateReceiver extends RpcTarget {
  receive(batch: SidebarBatch): Promise<void>;
}

export interface Subscription extends RpcTarget {
  close(): Promise<void>;
}

/** Read-only capability. No owner action, Git credential or arbitrary project selector. */
export interface SidebarUi extends RpcTarget {
  snapshot(): Promise<SidebarBatch>;
  subscribe(receiver: UpdateReceiver): Promise<Subscription>;
  waitForChanges(after: number): Promise<SidebarBatch>;
}
