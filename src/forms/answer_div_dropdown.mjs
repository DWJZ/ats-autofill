#!/usr/bin/env node
/**
 * answer_div_dropdown.mjs — answer a custom dropdown that is neither a native <select>, a react-select, nor an
 * Ashby combobox.
 *
 * WHY THIS EXISTS. Duolingo's Greenhouse form renders five required questions as plain <div> widgets whose only visible
 * text is "SELECT...", with no <select>, no [role="combobox"] and no select__control anywhere on the page - so every
 * settled picker reported "no options" while the screenshot showed five red "This field is required." messages. A real
 * mouse click on the trigger opens a list of plain <div> rows ("Yes" / "No"), so the interaction is ordinary; it just
 * had no tool.
 *
 * HOW IT WORKS, and why each step is deliberate:
 *   - the question text is the anchor, because these widgets carry no id, no name and no role;
 *   - the container is the smallest ancestor whose OWN innerText STARTS WITH the question, which is what keeps it from
 *     matching an unrelated control further up the tree (that mistake has cost rounds on this project);
 *   - the trigger is the descendant whose text is exactly "SELECT...";
 *   - the row is chosen by EXACT option text and must equal it - never a prefix, never a word;
 *   - the new value is read back from the container before being reported.
 *
 * USAGE
 *   node src/forms/answer_div_dropdown.mjs <url-part> --file <plan.json> [--cdp <url>]
 *   plan.json: [ { "q": "^Are you willing to work from the office", "option": "Yes" }, ... ]
 */
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const urlPart = args[0];
const i = args.indexOf("--file");
if (!urlPart || i < 0) { console.error("usage: answer_div_dropdown.mjs <url-part> --file <plan.json>"); process.exit(2); }
const plan = JSON.parse(await readFile(args[i + 1], "utf8"));
const cdpIdx = args.indexOf("--cdp");
const cdp = cdpIdx >= 0 ? args[cdpIdx + 1] : "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing for", urlPart); process.exit(0); }

let problems = 0;
for (const item of plan) {
  const find = async () =>
    page.evaluate((q) => {
      const rx = new RegExp(q, "i");
      // Clear any marker left by a previous item in this plan, or the row search would scope to the LAST question's
      // container instead of this one.
      for (const old of document.querySelectorAll('[data-ats-dropdown]')) old.removeAttribute("data-ats-dropdown");
      let best = null;
      for (const el of document.querySelectorAll("div,fieldset,section,li")) {
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!rx.test(t) || t.length > 300) continue;
        const trig = [...el.querySelectorAll("div,button,span")].find((x) => /^select\.{3}$/i.test((x.innerText || "").trim()));
        if (!trig) continue;
        if (!best || t.length < best.len) {
          // MARK THE CONTAINER. The row search below must not be page-wide: once other questions on the same form have
          // been answered, their committed values render as on-screen text "YES", and a page-wide search for a row
          // literally reading "Yes" matched one of THOSE and clicked it - so the sponsorship question stayed unset while
          // the tool reported a click. Scoping the rows to this container is what fixes it.
          el.setAttribute("data-ats-dropdown", "1");
          const r = trig.getBoundingClientRect();
          best = { len: t.length, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), shown: t.slice(0, 150) };
        }
      }
      return best;
    }, item.q);

  const target = await find();
  if (!target) { console.log(`  FAIL ${item.q}: no SELECT... widget found`); problems++; continue; }

  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(90);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(1100);

  const rows = await page.evaluate(() => {
    const scope = document.querySelector('[data-ats-dropdown="1"]') || document.body;
    return [...scope.querySelectorAll("div,li,button,span")]
      .map((o) => { const r = o.getBoundingClientRect(); return { t: (o.innerText || "").replace(/\s+/g, " ").trim(), x: Math.round(r.x + Math.min(r.width, 260) / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; })
      // ON-SCREEN ONLY, and only inside the dropdown's own container. Without the viewport test this matched the job
      // header and every other long page element; without the container scope it matched ANOTHER question's committed
      // "YES" and clicked that instead.
      .filter((o) => o.t && o.w > 30 && o.h > 10 && o.h < 70 && o.t.length < 40
        && o.top >= 0 && o.top <= window.innerHeight && o.left >= 0 && o.left <= window.innerWidth);
  });

  const want = String(item.option).trim().toLowerCase();
  const row = rows.find((r) => r.t.toLowerCase() === want);
  if (!row) { console.log(`  FAIL ${item.q}: no row exactly "${item.option}" - saw ${JSON.stringify([...new Set(rows.map((r) => r.t))].slice(0, 8))}`); problems++; continue; }

  await page.mouse.move(row.x, row.y).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(90);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(900);

  const after = await page.evaluate((q) => {
    const rx = new RegExp(q, "i");
    for (const el of document.querySelectorAll("div,fieldset,section,li")) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!rx.test(t) || t.length > 300) continue;
      if (/^select\.{3}/i.test(t.replace(rx, "").trim())) continue;
      return t.slice(0, 150);
    }
    return "(not read back)";
  }, item.q);
  const ok = after.toLowerCase().includes(want);
  console.log(`  ${ok ? "OK  " : "WARN"} ${item.q.slice(0, 44)} -> ${JSON.stringify(after.slice(0, 90))}`);
  if (!ok) problems++;
}

console.log(`\n${plan.length} dropdown(s), ${problems} problem(s)`);
process.exit(0);
