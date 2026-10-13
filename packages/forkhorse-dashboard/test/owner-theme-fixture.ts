// Included only by the loopback owner-bundle fixture response, never by production entrypoints.
import { applyAppTheme } from "../src/theme.ts";
import type { GatekeeperAppTheme } from "@gadgets/workshop-shared/theme";
window.addEventListener(
  "message",
  (event: MessageEvent<{ type: string; theme: GatekeeperAppTheme }>) => {
    if (
      event.source === window.parent &&
      event.origin === location.origin &&
      event.data?.type === "offline-fixture-theme"
    )
      applyAppTheme(event.data.theme);
  },
);
