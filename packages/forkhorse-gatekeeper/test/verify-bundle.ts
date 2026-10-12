import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};
const html = readFileSync(new URL("../dist/sidebar.html", import.meta.url), "utf8");
const brand = JSON.parse(readFileSync(new URL("../../../brand.json", import.meta.url), "utf8"));
const dom = new JSDOM(html);
const document = dom.window.document;
assert.equal(document.title, brand.name);
assert.equal(document.querySelectorAll('script[src],link[rel="stylesheet"]').length, 0);
assert.equal(document.querySelectorAll("script").length, 1);
assert.ok(document.querySelector("style")!.textContent!.length > 1000, "dashboard CSS is inlined");
assert.doesNotMatch(html, /Fixture update batch|LOCAL FIXTURE ONLY|git\.idiot\.tax/);
assert.equal(document.getElementById("sidebar")!.dataset.fixture, undefined);
console.log("Bundle verified: branded inline HTML, JavaScript and CSS; fixture data absent.");
dom.window.close();
const configurator = new JSDOM(readFileSync(new URL("../dist/configurator.html", import.meta.url), "utf8"));
assert.equal(configurator.window.document.title, brand.name);
assert.equal(configurator.window.document.querySelectorAll('script[src],link[rel="stylesheet"]').length, 0);
assert.ok(configurator.window.document.querySelector("style")!.textContent!.length > 300);
console.log("Configurator verified: self-contained draft-only frame.");
configurator.window.close();
