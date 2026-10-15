#!/usr/bin/env node
/**
 * scan_button_pairs.mjs — find Ashby's Yes/No button-pair widgets and print their hidden checkbox names.
 *
 * WHY THIS EXISTS. This widget has now cost time on four tenants (Material Security, Superhuman, Wrapbook, OnePay):
 * a question renders as two `<button>Yes|No</button>` controls over a **hidden checkbox whose `name` is the field id**,
 * and the server reads the checkbox rather than the buttons. Crucially the question can be invisible to both the field
 * inventory AND the validation audit while still being required at submit, so the reliable order is: scan for pairs
 * BEFORE the first submit, answer them with real mouse presses, then submit.
 *
 * The scan walks up from every checkbox (name length >= 30, which is what a UUID-shaped field id looks like) until it
 * finds a container holding both a Yes and a No button, then hunts the question text in the preceding siblings.
 *
 * USAGE
 *   node src/forms/scan_button_pairs.mjs <url-part> [--cdp <url>] [--answer yes|no] [--plan plan.json]
 *
 * --plan takes precedence over --answer and maps each question to its own answer:
 *   [ { "match": "authorized to work", "answer": "yes" },
 *     { "match": "experience working at a startup", "answer": "yes" } ]
 *
 * With --answer, each pair found is answered with that value using real mouse down/up at the button's coordinates and
 * the checkbox state is read back. Without it, the tool only reports what it found.
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const urlPart = args[0];
const cdpIdx = args.indexOf("--cdp");
const cdp = cdpIdx >= 0 ? args[cdpIdx + 1] : "http://127.0.0.1:9223";
const ansIdx = args.indexOf("--answer");
const answer = ansIdx >= 0 ? args[ansIdx + 1] : null;
const planIdx = args.indexOf("--plan");
let plan = null;
if (planIdx >= 0) {
  const { readFile } = await import("node:fs/promises");
  plan = JSON.parse(await readFile(args[planIdx + 1], "utf8"));
}
if (!urlPart) { console.error("usage: scan_button_pairs.mjs <url-part> [--cdp <url>] [--answer yes|no]"); process.exit(2); }

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log(`tab matching "${urlPart}" not found`); process.exit(0); }

const pairs = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    const name = box.name || "";
    if (!name || seen.has(name) || name.length < 30) continue;
    let node = box;
    for (let i = 0; i < 14 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const yes = [...node.querySelectorAll("button")].find((b) => /^yes$/i.test((b.innerText || "").trim()));
      const no = [...node.querySelectorAll("button")].find((b) => /^no$/i.test((b.innerText || "").trim()));
      if (yes && no) {
        seen.add(name);
        let q = "";
        let cursor = node;
        for (let k = 0; k < 4 && cursor && !q; k++) {
          let sib = cursor.previousElementSibling;
          while (sib) {
            const t = (sib.innerText || "").replace(/\s+/g, " ").trim();
            if (t.length > 14) { q = t.slice(0, 120); break; }
            sib = sib.previousElementSibling;
          }
          if (!q) cursor = cursor.parentElement;
        }
        const grab = (b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
                // Expose a longer CONTEXT as well as the question. On Reframe Systems the located question text was only the
        // tail fragment "It's ok if you don't, but this is certainly helpful." while the real question lived in the
        // wrapper, so a plan keyed on the full wording matched nothing. context gives plan authors something usable.
        const context = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240);
        out.push({ name, question: q, context, yes: grab(yes), no: grab(no), checked: box.checked });
        break;
      }
    }
  }
  return out;
});

console.log(`button pairs found: ${pairs.length}`);
for (const p of pairs) {
  console.log(`  ${p.name}`);
  console.log(`     Q: ${p.question || "(question text not located)"}`);
  if (p.context && p.context !== p.question) console.log(`     ctx: ${p.context}`);
  console.log(`     currently checked: ${p.checked}`);
  // A blanket --answer is wrong as soon as two pairs ask different things - on Updoc, "are you authorized to work?"
  // and "do you have experience working at a startup?" got the same Yes, and the second one had to be corrected by
  // hand. --plan lets each question carry its own answer: [{ "match": "<regex on the question>", "answer": "yes|no" }].
  let chosen = answer;
  let force = false;
  if (plan) {
    for (const rule of plan) {
      if (new RegExp(rule.match, "i").test(p.question || "")) { chosen = rule.answer; force = !!rule.force; break; }
    }
  }
  if (!chosen) continue;
  // These widgets TOGGLE: pressing the already-selected button clears it. A pair already in the wanted state must
  // therefore be left alone - found by re-running this tool on Updoc and watching a correct Yes turn false.
  //
  // BUT "ALREADY CORRECT" IS JUDGED AGAINST THE DOM, AND THE DOM IS NOT WHAT THE SERVER HAS. On Prompt's AI Engineer form
  // a pair read No on every pass, this tool reported "already NO - left alone" every time, and the server named that exact
  // field in every refusal: the value was in the DOM and never in the request, the same re-render loss documented for
  // Close's textareas. So a plan rule may now carry "force": true, which is meant for a field a REFUSAL HAS NAMED. Because
  // the widget toggles rather than being idempotent, a forced press is followed by a read-back and, if the press cleared
  // the answer, one corrective press - so the pair cannot be left in the wrong state.
  const wanted = /^yes$/i.test(chosen);
  if (p.checked === wanted && !force) { console.log(`     already ${chosen.toUpperCase()} - left alone`); continue; }
  if (p.checked === wanted && force) console.log(`     already ${chosen.toUpperCase()}, but a refusal named it - forcing a re-press`);
  // Re-measure immediately before pressing: the coordinates taken during the scan go stale as soon as the page
  // scrolls, and a stale press lands on nothing while the checkbox silently stays false (learned on Notion).
  const pt = await page.evaluate(({ name, want }) => {
    const rx = new RegExp(`^${want}$`, "i");
    const box = document.querySelector(`input[name="${CSS.escape(name)}"]`);
    let node = box;
    for (let i = 0; i < 14 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const btn = [...node.querySelectorAll("button")].find((b) => rx.test((b.innerText || "").trim()));
      if (btn) {
        btn.scrollIntoView({ block: "nearest" });
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  }, { name: p.name, want: chosen });
  if (!pt) { console.log(`     could not re-locate the ${chosen.toUpperCase()} button`); continue; }
  await page.mouse.move(pt.x, pt.y).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(70);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(1000);
  const now = await page.evaluate((name) => { const el = document.querySelector(`input[name="${CSS.escape(name)}"]`); return el ? el.checked : "gone"; }, p.name);
  console.log(`     pressed ${chosen.toUpperCase()} -> checkbox=${now}`);
  // A forced press on a toggling widget can CLEAR the answer instead of setting it. Correct it rather than leave the pair
  // wrong, and re-verify so the log tells the truth about the final state.
  if (force && now !== wanted) {
    // A forced press TOGGLES on some tenants, so it can clear a pair that was already correct - and if the caller then
    // submits, the application carries a FALSE answer. That happened on Prompt: the authorization pair ended up No and the
    // submit succeeded. So this now retries the OPPOSITE option first (the documented Ashby desync cure: toggle to the
    // opposite and back) and then the wanted one, up to three rounds, and FAILS LOUDLY if it cannot leave the pair correct.
    let fixed = now;
    for (let attempt = 0; attempt < 3 && fixed !== wanted; attempt++) {
      console.log(`     correcting (attempt ${attempt + 1}): pressing the opposite option, then ${chosen.toUpperCase()}`);
      for (const step of [wanted ? "No" : "Yes", chosen]) {
        const stepPt = await page.evaluate(({ name, want }) => {
          const rx = new RegExp(`^${want}$`, "i");
          const box = document.querySelector(`input[name="${CSS.escape(name)}"]`);
          let node = box;
          for (let i = 0; i < 14 && node; i++) {
            node = node.parentElement;
            if (!node) break;
            const btn = [...node.querySelectorAll("button")].find((b) => rx.test((b.innerText || "").trim()));
            if (btn) {
              btn.scrollIntoView({ block: "nearest" });
              const r = btn.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            }
          }
          return null;
        }, { name: p.name, want: step });
        if (!stepPt) continue;
        await page.mouse.move(stepPt.x, stepPt.y).catch(() => {});
        await page.mouse.down().catch(() => {});
        await page.waitForTimeout(90);
        await page.mouse.up().catch(() => {});
        await page.waitForTimeout(900);
      }
      fixed = await page.evaluate((name) => { const el = document.querySelector(`input[name="${CSS.escape(name)}"]`); return el ? el.checked : "gone"; }, p.name);
      console.log(`     after attempt ${attempt + 1}: checkbox=${fixed}`);
    }
    if (fixed !== wanted) {
      console.log(`     FATAL ${p.question || p.name}: could not set ${chosen.toUpperCase()} - DO NOT SUBMIT this form`);
      process.exitCode = 5;
    }
  }
}
process.exit(0);
