#!/usr/bin/env node
/**
 * list_yesno_pairs.mjs — enumerate every Ashby Yes/No button pair on the page with its real state.
 *
 * Each pair owns a checkbox whose NAME is the field id, and the checkbox (not aria-pressed) is what the server reads.
 * The question text of an unanswered pair often appears only in the server's refusal, so this reports the checkbox
 * name, the pressed states and the checked flag for every pair in form order - which is enough to press the right
 * ones with confidence instead of guessing.
 *
 * USAGE: node tmp/list_yesno_pairs.mjs <url-part>
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2] || "";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const report = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    const name = box.name || box.id || "";
    if (!name || seen.has(name)) continue;
    let node = box;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const btns = Array.from(node.querySelectorAll("button")).filter((x) => /^(yes|no)$/i.test((x.innerText || "").trim()));
      if (btns.length < 2) continue;
      seen.add(name);
      const r = box.getBoundingClientRect();
      const container = (node.innerText || "").replace(/\s+/g, " ").trim();
      out.push({
        name,
        checked: box.checked,
        states: btns.map((x) => (x.innerText || "").trim() + "=" + (x.getAttribute("aria-pressed") || "?")),
        text: container.slice(0, 90),
        visible: r.width > 2 || container.length > 0,
      });
      break;
    }
  }
  // also surface the server's own list of missing fields
  const t = document.body.innerText.replace(/\s+/g, " ");
  return { pairs: out, missing: [...new Set(t.match(/Missing entry for required field: [^.]{5,110}/g) || [])] };
});

console.log(`pairs found: ${report.pairs.length}`);
report.pairs.forEach((p, i) => {
  console.log(`  ${i + 1}. box=${p.name}`);
  console.log(`     checked=${p.checked} states=${JSON.stringify(p.states)}`);
  console.log(`     text=${JSON.stringify(p.text)}`);
});
console.log("\nserver says missing:");
report.missing.forEach((m) => console.log(`  - ${m.slice(0, 130)}`));
process.exit(0);
