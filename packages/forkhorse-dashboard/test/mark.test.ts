import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import brand from "../../../brand.json" with { type: "json" };
import { markIconUrl } from "../src/mark.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("the mark is font-rendered accessible SVG text, including untrusted future values", () => {
  for (const mark of [brand.mark, `</text><script>alert("x")</script>&'`]) {
    const url = markIconUrl(mark);
    assert.ok(url.startsWith("data:image/svg+xml,"));
    assert.doesNotMatch(url, /[<>"']/);
    const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
    const document = dom.window.document;
    assert.equal(document.querySelector("text")!.textContent, mark);
    assert.equal(document.documentElement.getAttribute("role"), "img");
    assert.equal(document.documentElement.getAttribute("aria-label"), brand.name);
    assert.match(document.querySelector("text")!.getAttribute("font-family")!, /emoji/);
    assert.equal(document.querySelectorAll("script, image, path").length, 0);
    dom.window.close();
  }
});
