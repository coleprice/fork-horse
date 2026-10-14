import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCoreOrigin, sidebarWithCoreOrigin } from "../app/owner-origin.ts";

const html = '<!doctype html><div id="sidebar"></div><script>/* fixture */</script>';
test("iframe metadata serializes only the validated public Core origin", () => {
  assert.equal(sidebarWithCoreOrigin(html, "https://core.fixture.idiot.tax"),
    '<!doctype html><div id="sidebar" data-core-origin="https://core.fixture.idiot.tax"></div><script>/* fixture */</script>');
  for (const value of [undefined, "", "null", "https://agent:fixture-secret@core.fixture.idiot.tax",
    "https://core.fixture.idiot.tax/?token=fixture-secret", "https://core.fixture.idiot.tax/#fixture-secret",
    'https://core.fixture.idiot.tax/"><script>fixture-secret</script>', "javascript:fixture-secret"]) {
    assert.equal(publicCoreOrigin(value), undefined);
    assert.equal(sidebarWithCoreOrigin(html, value), html);
  }
});

test("iframe metadata escapes attribute metacharacters and leaves the surrounding document intact", () => {
  const value = "https://owner's.fixture.idiot.tax";
  assert.equal(publicCoreOrigin(value), value);
  assert.equal(sidebarWithCoreOrigin(html, value),
    '<!doctype html><div id="sidebar" data-core-origin="https://owner&#39;s.fixture.idiot.tax"></div><script>/* fixture */</script>');
});
