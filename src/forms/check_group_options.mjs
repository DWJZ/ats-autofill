// Enforce EXACT option sets in Ashby checkbox groups.
// `apply_form_spec.mjs` can check EVERY option of a multi-option group from a single
// `checks` entry, which silently turns into a false skills claim (seen on Agave and Tenex).
//
// Usage:
//   node tmp/check_only.mjs <url-part> '[["<group text regex>", ["Label A","Label B"]], ...]'
// Example:
//   node tmp/check_only.mjs 3b828a98 '[["development languages",["Go","Python"]],["tools you have hand",["Docker","Kubernetes"]],["Cloud environments",["AWS"]]]'
import { chromium } from "playwright-core";

const part = process.argv[2];
const groups = JSON.parse(process.argv[3] || "[]");
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const p = b.contexts()[0].pages().find(x => x.url().includes(part));
if (!p) { console.log("no tab for", part); process.exit(0); }

const result = await p.evaluate((groups) => {
  const out = [];
  for (const [keyRe, wanted] of groups) {
    const re = new RegExp(keyRe, "i");
    const entries = [...document.querySelectorAll("[data-field-entry-id]")]
      .filter(f => re.test((f.querySelector("label") || {}).innerText || ""));
    if (!entries.length) { out.push({ key: keyRe, error: "group not found" }); continue; }
    for (const f of entries) {
      const boxes = [...f.querySelectorAll("input[type=checkbox]")];
      if (boxes.length < 2) continue;
      for (const c of boxes) {
        const lab = document.querySelector(`label[for="${c.id}"]`) || c.closest("label") || c.parentElement;
        const txt = ((lab && lab.innerText) || "").trim();
        const want = wanted.some(w => txt.toLowerCase() === w.toLowerCase());
        if (c.checked !== want) lab.click();
      }
      out.push({
        key: keyRe,
        checked: boxes
          .filter(c => c.checked)
          .map(c => ((document.querySelector(`label[for="${c.id}"]`) || {}).innerText || "").trim()),
      });
    }
  }
  return out;
}, groups);

for (const r of result) {
  if (r.error) console.log("[MISS]", r.key, r.error);
  else console.log("[ok]", r.key, "->", JSON.stringify(r.checked));
}
process.exit(0);
