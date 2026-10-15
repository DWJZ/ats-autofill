// answer_ashby_pair.mjs — answer EVERY hidden-checkbox Yes/No pair on an Ashby form from the standing table.
// Usage: node src/forms/answer_ashby_pair.mjs <url-part> [--cdp URL] [--dry-run]
//
// This exists because answer_by_checkbox.mjs anchors on `input[type=checkbox][name="..."]` and reports "no anchor" when that
// selector misses, and because press_all_pairs.mjs reports these pairs as answered from the buttons' aria-pressed - which the
// Ashby reference states is NOT proof. THE ONLY VALID PROOF IS THE HIDDEN CHECKBOX ITSELF, so that is what this tool reads
// before and after every press, and it retries opposite-then-wanted, the documented desync cure.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
// The standing table is configuration, so it is located through the one definition of `ATS_DATA_DIR`
// (`src/paths.mjs`) instead of a path relative to whatever directory this happens to be run from.
import { DATA_DIR } from "../paths.mjs";
import { join } from "node:path";
const urlPart = process.argv[2];
const cdp = (() => { const i = process.argv.indexOf("--cdp"); return i > 0 ? process.argv[i + 1] : "http://127.0.0.1:9223"; })();
const dry = process.argv.includes("--dry-run");
if (!urlPart) { console.error("usage: answer_ashby_pair.mjs <url-part> [--cdp URL] [--dry-run]"); process.exit(2); }
const rules = JSON.parse(readFileSync(join(DATA_DIR, "form_specs", "ashby_pairs_standing.json"), "utf8")).rules || [];
const b = await chromium.connectOverCDP(cdp);
const page = b.contexts()[0].pages().find((p) => (p.url() || "").includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(2); }
const scan = () => page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll("input[type=checkbox]")) {
    const r = e.getBoundingClientRect();
    if (r.width > 2 || r.height > 2) continue;                 // the hidden 0x0 twin is the real control
    let w = e, q = "";
    for (let i = 0; i < 20 && w; i++) { const t = (w.innerText || "").replace(/\s+/g, " ").trim(); if (t && t.length > 10 && t.length < 500) { q = t; break; } w = w.parentElement; }
    // locate the container holding the two option buttons WITHOUT trusting their exact text
    let box = e, opts = null;
    for (let i = 0; i < 10 && box; i++) {
      const bs = [...box.querySelectorAll("button")].filter((x) => /^\s*(yes|no)\b/i.test((x.innerText || "").trim()) && (x.innerText || "").trim().length < 24);
      if (bs.length >= 2) { opts = bs.slice(0, 2); break; }
      box = box.parentElement;
    }
    out.push({
      name: e.name || "-", checked: e.checked === true, q: (q || "").replace(/ Yes No$/, ""),
      opts: opts ? opts.map((x) => {
        // Scroll with block:"nearest" FIRST: a pair below the fold yields a y outside the viewport, and a mouse click at
        // that coordinate lands nowhere while looking like a click that the widget ignored.
        try { x.scrollIntoView({ block: "nearest" }); } catch {}
        const rr = x.getBoundingClientRect();
        return { text: (x.innerText || "").trim().slice(0, 6), x: Math.round(rr.x + Math.min(rr.width, 160) / 2), y: Math.round(rr.y + rr.height / 2) };
      }) : null,
    });
  }
  return out;
});
const pairs = await scan();
console.log(`hidden pairs found: ${pairs.length}`);
let bad = 0;
for (const p of pairs) {
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(p.q); } catch { return false; } });
  const want = rule ? String(rule.answer).toLowerCase() : null;
  console.log(`  "${p.q.slice(0, 58)}" | box=${p.checked} | options=${p.opts ? JSON.stringify(p.opts.map((o) => o.text)) : "NOT FOUND"} | rule=${want || "NONE"}`);
  if (!want || !["yes", "no"].includes(want)) { console.log("     -> no standing rule; left for a human"); bad++; continue; }
  if (!p.opts) { console.log("     -> could not find the option buttons"); bad++; continue; }
  const target = p.opts.find((o) => new RegExp("^\\s*" + want, "i").test(o.text)) || (want === "yes" ? p.opts[0] : p.opts[1]);
  const wanted = want === "yes";
  const already = p.checked === wanted;
  if (already) { console.log(`     -> already ${want.toUpperCase()} (checkbox agrees)`); continue; }
  // Re-measure right before clicking: scrolling for an earlier pair can move this one, and a stale coordinate is exactly
  // how a click misses a button that is plainly visible.
  const fresh = (await scan()).find((x) => x.name === p.name);
  if (fresh && fresh.opts) {
    const f = fresh.opts.find((o) => new RegExp("^\\s*" + want, "i").test(o.text)) || (want === "yes" ? fresh.opts[0] : fresh.opts[1]);
    if (f) { target.x = f.x; target.y = f.y; }
    if (fresh.opts[0] && fresh.opts[1]) p.opts = fresh.opts;
  }
  if (dry) { console.log(`     -> would press "${target.text}"`); continue; }
  let ok = false;
  for (const mode of ["wanted", "opposite-then-wanted"]) {
    if (mode === "opposite-then-wanted") {
      const opp = p.opts.find((o) => o !== target);
      if (opp) { await page.mouse.click(opp.x, opp.y); await page.waitForTimeout(430); }
    }
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(520);
    const now = (await scan()).find((x) => x.name === p.name);
    const good = now && now.checked === wanted;
    console.log(`     ${mode}: checkbox=${now ? now.checked : "?"} -> ${good ? "COMMITTED (checkbox is the proof)" : "not yet"}`);
    if (good) { ok = true; break; }
  }
  if (!ok) bad++;
}
const final = await scan();
console.log("FINAL CHECKBOX STATES:", JSON.stringify(final.map((x) => ({ q: x.q.slice(0, 34), box: x.checked }))).slice(0, 400));
console.log(bad ? `WARNING: ${bad} pair(s) could not be committed` : "ALL PAIRS COMMITTED (verified by the hidden checkbox)");
process.exit(bad ? 1 : 0);
