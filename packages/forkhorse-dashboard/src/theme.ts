import { applyAccentColor, type GatekeeperAppTheme } from "@gadgets/workshop-shared/theme";
import tokens from "./host-tokens.json" with { type: "json" };

/** Reviewed host tokens live in JSON; components consume semantic variables only. */
export function applyAppTheme(theme: GatekeeperAppTheme, document: Document = globalThis.document) {
  const root = document.documentElement;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  const defaults = Object.entries({ ...tokens.shared, ...tokens[theme.mode] });
  for (const [name, value] of defaults) root.style.setProperty(name, value);
  applyAccentColor(root.style, theme.accentColor);
  // Clearing an accent removes inline variables; restore the reviewed default seed tokens.
  for (const [name, value] of defaults)
    if (!root.style.getPropertyValue(name)) root.style.setProperty(name, value);
}

/** The standalone copy tracks system changes; the embedded copy stops at host handoff. */
export function followSystemTheme(document: Document = globalThis.document) {
  const media = document.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
  const update = () =>
    applyAppTheme({ mode: media?.matches ? "dark" : "light", accentColor: null }, document);
  update();
  media?.addEventListener("change", update);
  return () => media?.removeEventListener("change", update);
}
