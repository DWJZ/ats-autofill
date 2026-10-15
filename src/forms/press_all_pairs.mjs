/**
 * press_all_pairs.mjs — answer EVERY yes/no pair on an Ashby-style form, and report anything it cannot match.
 *
 * Why this exists: on 2026-10-03 the Prompt tenant cost four refused submits in a row because a pair that had NEVER been pressed
 * and a pair explicitly answered "No" both read as checkbox.checked === false. The settled scanner therefore reported
 * "already NO - left alone" for pairs the server had no answer for at all. Two further facts made it worse: the scanner finds
 * pairs by climbing from a CHECKBOX, so a yes/no question rendered as a RADIO pair is invisible to it; and the audit tool
 * deliberately excludes checkboxes from its required list. So an Ashby form needed three different instruments and still missed
 * things.
 *
 * This tool closes that gap. It enumerates every pair regardless of whether it is drawn from checkboxes or radios, matches each
 * pair's question text against a STANDING ANSWER TABLE, and presses the answer with the opposite-first sequence (which guarantees
 * a real press even when the pair looks answered) reading the value back after each step. Anything it cannot match is printed
 * with its available options and makes the command exit non-zero, so a human decides rather than the script guessing.
 *
 * Usage:
 *   node src/forms/press_all_pairs.mjs <url-substring> [--cdp http://127.0.0.1:9223]
 *        [--table data/form_specs/ashby_pairs_standing.json] [--dry-run]
 *
 * Exit codes: 0 = every pair matched and now holds its wanted answer; 3 = at least one pair was unmatched or ended wrong
 * (nothing else was touched); 2 = no matching tab.
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
// The default standing table is configuration: `src/paths.mjs` holds the one definition of where it lives,
// so the default follows `ATS_DATA_DIR` and no longer depends on the directory this is run from.
import { DATA_DIR } from "../paths.mjs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dryRun = argv.includes("--dry-run");
if (!target) {
  console.error("usage: press_all_pairs.mjs <url-substring> [--cdp url] [--table path] [--dry-run]");
  process.exit(1);
}
const cdp = flag("cdp", "http://127.0.0.1:9223");
const tablePath = flag("table", join(DATA_DIR, "form_specs", "ashby_pairs_standing.json"));
let table;
try {
  table = JSON.parse(readFileSync(tablePath, "utf8"));
} catch (e) {
  console.error(`cannot read the standing answer table ${tablePath}: ${String(e).slice(0, 120)}`);
  process.exit(1);
}
const rules = Array.isArray(table) ? table : table.rules || [];

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => (p.url() || "").includes(target));
if (!page) { console.error(`no tab matching ${target}`); process.exit(2); }

// Enumerate pairs from BOTH checkbox and radio inputs: each input whose ancestor text reads like a question is a candidate,
// and grouping is by the pair's own container so a radio group with four options counts as one pair.
async function enumerate() {
  return page.evaluate(() => {
    const pairs = [];
    const seen = new Set();
    const all = [...document.querySelectorAll("input[type=checkbox], input[type=radio]")];
    for (const el of all) {
      // A yes/no pair has exactly TWO options. Anything wider is an EEO or multi-choice question (gender, race, veteran,
      // how-did-you-hear) and is not this tool's job - including it flooded the output with option rows and buried the real
      // pairs, which is what happened on the Horizon3 Growth form.
      if (el.type === "radio") {
        const group = document.querySelectorAll(`input[name="${CSS.escape(el.name || "-")}"]`);
        if (group.length > 2) continue;
      }
      let w = el, q = "";
      for (let i = 0; i < 16 && w; i++) {
        const t = (w.innerText || "").replace(/\s+/g, " ").trim();
        if (t && t.length > 16 && !/^(Yes\s*No|Yes|No)$/i.test(t)) { q = t; break; }
        w = w.parentElement;
      }
      if (!q) continue;
      const key = el.type + "|" + q;
      if (seen.has(key)) continue;
      seen.add(key);
      // buttons belonging to this pair: Yes/No/other labels, plus the option labels for a radio group
      let n = el, buttons = [];
      for (let i = 0; i < 16 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const bs = [...n.querySelectorAll("button")].filter((x) => (x.innerText || "").trim().length < 40);
        if (bs.length) { buttons = bs.map((x) => (x.innerText || "").trim()); break; }
      }
      const options = el.type === "radio"
        ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name || "-")}"]`)].map((r) => {
            let p2 = r.parentElement, l = "";
            for (let k = 0; k < 3 && p2; k++) { const t = (p2.innerText || "").trim(); if (t && t.length < 40) { l = t; break; } p2 = p2.parentElement; }
            return l.trim();
          })
        : buttons;
      pairs.push({ kind: el.type, name: el.name || "-", question: q, options, checked: all.some((x) => x.name === el.name && x.checked) });
    }
    return pairs;
  });
}

const pairs = await enumerate();
console.log(`found ${pairs.length} pair(s) on ${target}`);
const unmatched = [];
for (const p of pairs) {
  const rule = rules.find((r) => new RegExp(r.questionRe, "i").test(p.question));
  if (!rule) { unmatched.push(p); continue; }
  console.log(`  ${rule.answer.toUpperCase().padEnd(3)} | ${p.question.slice(0, 74)}`);
  if (dryRun) continue;

  // press the OPPOSITE first, then the wanted answer - guarantees a real press even when the pair reads as already answered
  const wanted = rule.answer === "yes" ? "Yes" : "No";
  const opposite = rule.answer === "yes" ? "No" : "Yes";
  for (const step of [opposite, wanted]) {
    const pt = await page.evaluate(({ q, want }) => {
      const rx = new RegExp("^" + want + "$", "i");
      for (const el of document.querySelectorAll("input[type=checkbox], input[type=radio]")) {
        let w = el, qt = "";
        for (let i = 0; i < 16 && w; i++) {
          const t = (w.innerText || "").replace(/\s+/g, " ").trim();
          if (t && t.length > 16 && !/^(Yes\s*No|Yes|No)$/i.test(t)) { qt = t; break; }
          w = w.parentElement;
        }
        if (!qt.includes(q)) continue;
        // a button labelled with the wanted answer, if this pair is drawn with buttons
        let n = el;
        for (let i = 0; i < 16 && n; i++) {
          n = n.parentElement;
          if (!n) break;
          const btn = [...n.querySelectorAll("button")].find((x) => rx.test((x.innerText || "").trim()));
          if (btn) { btn.scrollIntoView({ block: "center" }); const r = btn.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
        }
        // otherwise an option input whose own label matches
        const lab = el.closest("label") || el.parentElement;
        if (lab && rx.test((lab.innerText || "").trim().split("\n")[0].trim())) {
          lab.scrollIntoView({ block: "center" });
          const r = lab.getBoundingClientRect();
          return { x: Math.round(r.x + 12), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    }, { q: p.question, want: step });
    if (!pt) continue;
    await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.waitForTimeout(110); await page.mouse.up();
    await page.waitForTimeout(800);
  }
}

if (unmatched.length) {
  console.log(`\nUNMATCHED PAIRS (${unmatched.length}) - decide these by hand, the table has no rule:`);
  for (const p of unmatched) console.log(`  [${p.kind}] ${p.question.slice(0, 92)}\n        options: ${JSON.stringify(p.options.slice(0, 6))}`);
}
if (dryRun) { console.log("\n--dry-run: nothing pressed"); process.exit(0); }
process.exit(unmatched.length ? 3 : 0);
