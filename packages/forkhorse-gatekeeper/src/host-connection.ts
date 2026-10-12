import type { SidebarUi } from "./ui-types.ts";

/** A closed host port may be replaced; a healthy host never receives a second handshake. */
export function hostConnection<T extends { readonly ui: PromiseLike<SidebarUi> | SidebarUi }>(
  connect: () => { host: T; dispose(): void },
) {
  let connection = connect();
  return {
    get host() {
      return connection.host;
    },
    async acquireUi(): Promise<SidebarUi> {
      try {
        return await connection.host.ui;
      } catch {
        // The host's local ui getter has no service work: a failed getter means its RPC session
        // is unavailable. The pinned host resets its handshake when the frame capability changes.
        connection.dispose();
        connection = connect();
        return await connection.host.ui;
      }
    },
    dispose() {
      connection.dispose();
    },
  };
}
