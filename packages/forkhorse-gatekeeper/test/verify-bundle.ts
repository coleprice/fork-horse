import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { markIconUrl } from "../../forkhorse-dashboard/src/mark.ts";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options?: { virtualConsole: unknown },
  ) => { window: { document: Document; close(): void } };
  VirtualConsole: new () => {
    on(type: string, handler: (error: Error & { type?: string }) => void): unknown;
  };
};
// jsdom does not parse CSS4 @layer/@property. Geometry and appearance are checked in the real browser.
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  if (error.type !== "css parsing") throw error;
});
const options = { virtualConsole };
const html = readFileSync(new URL("../dist/sidebar.html", import.meta.url), "utf8");
const brand = JSON.parse(readFileSync(new URL("../../../brand.json", import.meta.url), "utf8"));
const dom = new JSDOM(html, options);
const document = dom.window.document;
assert.equal(document.title, brand.name);
assert.equal(document.querySelector('link[rel="icon"]')!.getAttribute("href"), markIconUrl(brand.mark));
assert.equal(document.querySelectorAll('script[src],link[rel="stylesheet"]').length, 0);
assert.equal(document.querySelectorAll("script").length, 2);
assert.match(document.querySelector("script")!.textContent!, /prefers-color-scheme/);
assert.ok(document.querySelector("style")!.textContent!.length > 1000, "dashboard CSS is inlined");
assert.doesNotMatch(html, /Fixture update batch|LOCAL FIXTURE ONLY|git\.idiot\.tax/);
assert.doesNotMatch(html, /\bprocess\.env\b/, "the sandboxed browser has no Node process global");
assert.equal(document.getElementById("sidebar")!.dataset.fixture, undefined);
assert.equal(document.querySelector("#sidebar [role=status]")!.textContent, `Loading ${brand.slug}…`);
assert.match(document.querySelector("style")!.textContent!, /:root\{--font-sans/);
console.log("Bundle verified: branded inline HTML, JavaScript and CSS; fixture data absent.");
dom.window.close();
const configurator = new JSDOM(
  readFileSync(new URL("../dist/configurator.html", import.meta.url), "utf8"),
  options,
);
assert.equal(configurator.window.document.title, brand.name);
assert.equal(configurator.window.document.querySelector('link[rel="icon"]')!.getAttribute("href"), markIconUrl(brand.mark));
assert.equal(
  configurator.window.document.querySelectorAll('script[src],link[rel="stylesheet"]').length,
  0,
);
assert.ok(configurator.window.document.querySelector("style")!.textContent!.length > 300);
console.log("Configurator verified: self-contained draft-only frame.");
configurator.window.close();
const picker = new JSDOM(
  readFileSync(new URL("../dist/picker.html", import.meta.url), "utf8"),
  options,
);
assert.equal(picker.window.document.title, brand.name);
assert.equal(picker.window.document.querySelector('link[rel="icon"]')!.getAttribute("href"), markIconUrl(brand.mark));
assert.equal(
  picker.window.document.querySelectorAll('script[src],link[rel="stylesheet"]').length,
  0,
);
picker.window.close();
const worker = readFileSync(new URL("../dist/worker.js", import.meta.url), "utf8");
assert.doesNotMatch(
  worker,
  /fixture-agent-credential-only|LOCAL FIXTURE batch|This local fixture refuses/,
);
console.log("Picker verified; production Worker excludes offline fixture entrypoints.");
