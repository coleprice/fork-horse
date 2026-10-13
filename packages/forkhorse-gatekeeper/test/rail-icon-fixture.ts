// Offline visual fixture of pinned OS rail/tile styling, not a connected OS session.
// Run with Node and redirect stdout to an HTML file; ?mode=dark switches theme.
import brand from "../../../brand.json" with { type: "json" };
import tokens from "../../forkhorse-dashboard/src/host-tokens.json" with { type: "json" };
import { markIconUrl } from "../../forkhorse-dashboard/src/mark.ts";
import { railIconUrl } from "../src/rail-icon.ts";

// Phosphor House regular 2.1.10, for comparison with the OS built-in Home row.
const housePath = "M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z";
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]!);
const vars = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}:${value}`).join(";");
const railUrl = escape(railIconUrl(brand.railIcon));
const markUrl = escape(markIconUrl(brand.mark));
console.log(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline rail icon fixture</title>
<style>
:root{${vars(tokens.light)}}:root[data-mode=dark]{${vars(tokens.dark)}}
*{box-sizing:border-box}body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:var(--color-kumo-base);color:var(--text-color-kumo-default)}
h1{font-size:14px;margin:0 0 8px}p{font-size:12px;color:var(--text-color-kumo-subtle);margin:0 0 20px}
section{display:flex;gap:32px}.rail{width:260px;padding:12px 8px;background:var(--color-kumo-elevated);border:1px solid var(--color-kumo-line);border-radius:8px}
.row{display:flex;height:32px;align-items:center;gap:10px;padding:0 10px;font-size:13px;line-height:18px;border-radius:8px;margin-bottom:2px}
.slot{display:flex;width:20px;height:20px;align-items:center;justify-content:center;color:var(--text-color-kumo-subtle);flex-shrink:0}
.slot svg,.glyph{width:14px;height:14px}.glyph{background:currentColor;mask-image:url("${railUrl}");-webkit-mask-image:url("${railUrl}");mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat;mask-position:center;-webkit-mask-position:center;mask-size:contain;-webkit-mask-size:contain}
.active{background:var(--color-kumo-fill);font-weight:500;color:var(--text-color-kumo-strong)}.active .slot{color:var(--color-kumo-brand)}
.tile{width:280px}.tile h2{font-size:18px;margin:8px 0 12px}.vendor{display:flex;gap:12px;align-items:center;padding:12px;background:var(--color-kumo-tint);border-radius:8px;font-size:14px;font-weight:600}.vendor img{width:20px;height:20px;object-fit:contain}.badge{margin-left:auto;font-size:10px;color:var(--text-color-kumo-subtle);font-weight:500}.note{margin-top:12px}
</style><script>document.documentElement.dataset.mode=new URL(location.href).searchParams.get("mode")==="dark"?"dark":"light";</script>
<h1>OFFLINE FIXTURE — FH-047 · <span id="mode"></span></h1><p>14px glyphs; pinned OS mask and row dimensions. No live connection.</p>
<section><nav class="rail" aria-label="Offline rail comparison">
<div class="row"><span class="slot"><svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${housePath}"/></svg></span>Home</div>
<div class="row"><span class="slot"><span class="glyph" aria-hidden="true"></span></span>${escape(brand.name)}</div>
<div class="row active"><span class="slot"><span class="glyph" aria-hidden="true"></span></span>${escape(brand.name)} <span class="badge">active</span></div>
</nav><div class="tile"><h2>Gatekeepers</h2><div class="vendor"><img src="${markUrl}" alt="">${escape(brand.name)}<span class="badge">auto-provisioned</span></div><p class="note">Vendor logo still uses brand.mark (${escape(brand.mark)}).</p></div></section>
<script>document.getElementById("mode").textContent=document.documentElement.dataset.mode;</script></html>`);
