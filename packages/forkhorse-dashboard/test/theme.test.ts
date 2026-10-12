import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { applyAppTheme } from "../src/theme.ts";
import tokens from "../src/host-tokens.json" with { type: "json" };
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("host theme changes mode and accent, and null restores the host's default accent", () => {
  const dom = new JSDOM("<html></html>");
  try {
    const document: Document = dom.window.document;
    applyAppTheme({ mode: "dark", accentColor: null }, document);
    assert.equal(document.documentElement.dataset.mode, "dark");
    assert.equal(document.documentElement.style.colorScheme, "dark");
    assert.equal(
      document.documentElement.style.getPropertyValue("--color-kumo-brand"),
      tokens.dark["--color-kumo-brand"],
    );
    applyAppTheme({ mode: "light", accentColor: "#abcdef" }, document);
    assert.equal(document.documentElement.dataset.mode, "light");
    assert.match(
      document.documentElement.style.getPropertyValue("--color-kumo-brand"),
      /light-dark/,
    );
    assert.match(
      document.documentElement.style.getPropertyValue("--text-color-kumo-link"),
      /abcdef/,
    );
    applyAppTheme({ mode: "light", accentColor: null }, document);
    assert.equal(
      document.documentElement.style.getPropertyValue("--color-kumo-brand"),
      tokens.light["--color-kumo-brand"],
    );
  } finally {
    dom.window.close();
  }
});
