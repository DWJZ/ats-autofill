#!/usr/bin/env node
/**
 * answer_by_question_text.mjs — operate controls that have neither an id nor a name, located only by their question.
 *
 * Runway's late-rendered questions (side projects, early-stage startup, based in the US, authorised to work) render as
 * checkbox-based Yes/No pairs with an EMPTY id and NO name, so neither the field inventory nor the pair scanner can
 * address them. What works is the pattern used on PermitFlow's office question and Taekus: find the container whose text
 * carries the question, then act on whatever control it holds - press the Yes/No button if there is one, otherwise type
 * into the input or textarea - measuring the target immediately before the interaction.
 *
 * USAGE: node src/forms/answer_by_question_text.mjs <url-part> --file <plan.json> [--cdp <url>]
 * plan.json: [
 *   { "match": "early stage startup", "answer": "yes" },
 *   { "match": "authorized to work in the US", "answer": "yes" },
 *   { "match": "side projects", "type": "text", "value": "..." }
 * ]
 */
import { chromium } from "playwright-core";
import { DEFAULT_WAIT_MS, boundedPage } from "./bounded_waits.mjs";
import { readFile } from "node:fs/promises";

// Typographic-character normalisation (added 2026-10-03). Fluidstack's non-compete question uses a NON-BREAKING HYPHEN
// (U+2011) in "non-compete", so a regex written with an ASCII hyphen matched nothing and the question went unanswered -
// it was submitted with the wrong value. Normalise dashes, non-breaking spaces and smart quotes on BOTH sides of every
// comparison, and apply the same normalisation to the pattern's own literal characters.
function normText(s) {
  return String(s || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"');
}


const args = process.argv.slice(2);
const urlPart = args[0];
const fileIdx = args.indexOf("--file");
// `--cdp` matches pick_option.mjs, apply_form_spec.mjs and every other driver. It exists so the tool
// can be pointed at a private browser in tests; the live default is unchanged.
const cdpIdx = args.indexOf("--cdp");
const cdp = cdpIdx >= 0 ? args[cdpIdx + 1] : "http://127.0.0.1:9223";
if (!urlPart || fileIdx < 0) { console.error("usage: answer_by_question_text.mjs <url-part> --file <plan.json> [--cdp <url>]"); process.exit(2); }
const plan = JSON.parse(await readFile(args[fileIdx + 1], "utf8"));

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }
// Every read this tool makes is a `page.evaluate`, and it makes several - one to find the pair, one to measure
// its geometry, one to read the answer back. A frozen renderer must name the read that stalled.
const bounded = boundedPage(page, "answer_by_question_text", Number(process.env.ATS_FORM_TIMEOUT_MS || DEFAULT_WAIT_MS));

for (const item of plan) {
  // Locate the tightest container that mentions the question and holds a control.
  const found = await bounded.evaluate((match) => {
    const rx = new RegExp(match, "i");
    let best = null;
    for (const el of document.querySelectorAll("div,fieldset,section")) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!rx.test(t) || t.length > 420) continue;
      const ctrls = [...el.querySelectorAll("input,textarea,select,button")].filter((c) => c.type !== "hidden");
      if (!ctrls.length) continue;
      if (!best || ctrls.length < best.n) best = { n: ctrls.length, text: t.slice(0, 140) };
    }
    return best;
  }, item.match);
  if (!found) { console.log(`  FAIL ${item.match}: no container`); continue; }

  if (item.type === "text") {
    // A text control is only a candidate if its TIGHTEST matching container holds few controls. Without that check the
    // walk-up matches the whole form - which also contains the question text - and the first input in it (the name
    // field) receives the answer. That is exactly what happened on Runway, where a 530-character side-projects answer
    // was typed into "Name"; the submit was refused, so nothing was sent, but the field had to be repaired by hand.
    const geo = await bounded.evaluate((match) => {
      // normText is defined in Node scope, so it does NOT exist here: calling it inside evaluate aborted the tool with
      // "ReferenceError: normText is not defined" on every question (found on Bubble's sexual-orientation field,
      // 2026-10-03). The normalisation must be redeclared inside the browser context, and the PATTERN must go through
      // it too, which is what the comment above always claimed.
      const norm = (s) =>
        String(s || "")
          .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
          .replace(/[\u00a0\u2007\u202f]/g, " ")
          .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
          .replace(/[\u201c\u201d\u201e\u201f]/g, '"');
      const rx = new RegExp(norm(match), "i");
      for (const el of document.querySelectorAll("textarea,input[type=text],input:not([type])")) {
        if ((el.id || "").startsWith("g-recaptcha")) continue;
        let w = el.closest("div,fieldset,section") || el.parentElement;
        for (let i = 0; i < 6 && w; i++) {
          const text = norm(w.innerText).replace(/\s+/g, " ");
          const controls = [...w.querySelectorAll("input,textarea,select,button")].filter((c) => c.type !== "hidden");
          if (rx.test(text)) {
            if (controls.length > 4) break;                 // too broad: this is a form wrapper, not the question
            el.scrollIntoView({ block: "nearest" });
            el.focus();
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2), controls: controls.length };
          }
          w = w.parentElement;
        }
      }
      return null;
    }, item.match);
    if (!geo) { console.log(`  FAIL ${item.match}: no text control (no tight container matched)`); continue; }
    await page.mouse.click(geo.x, geo.y).catch(() => {});
    await page.keyboard.type(String(item.value), { delay: 8 });
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(600);
    // Verify the value actually landed in a field, and say where - never report success from the typing alone.
    const landed = await bounded.evaluate((needle) => {
      const want = String(needle).slice(0, 24);
      for (const el of document.querySelectorAll("textarea,input")) {
        if ((el.value || "").startsWith(want)) return { id: el.id || "(no id)", name: el.name || "(no name)", len: el.value.length };
      }
      return null;
    }, item.value);
    console.log(landed
      ? `  OK   ${item.match}: typed into ${landed.id || landed.name} (${landed.len} chars, container had ${geo.controls} controls)`
      : `  FAIL ${item.match}: typed, but the value is in no field - check the container`);
    continue;
  }

  // Yes/No: find the button inside the container and press it, measuring immediately before the press.
  const pt = await bounded.evaluate(({ match, want }) => {
    const rx = new RegExp(match, "i");
    const rxWant = new RegExp(`^${want}`, "i");
    for (const el of document.querySelectorAll("div,fieldset,section")) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!rx.test(t) || t.length > 420) continue;
      const btn = [...el.querySelectorAll("button")].find((b) => rxWant.test((b.innerText || "").trim()));
      if (!btn) continue;
      btn.scrollIntoView({ block: "nearest" });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (btn.innerText || "").trim() };
    }
    return null;
  }, { match: item.match, want: item.answer });
  if (!pt) { console.log(`  FAIL ${item.match}: no ${item.answer} button`); continue; }
  await page.mouse.move(pt.x, pt.y).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(80);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(800);
  console.log(`  OK   ${item.match}: pressed ${pt.label}`);
}
process.exit(0);
