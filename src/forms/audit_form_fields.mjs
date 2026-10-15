#!/usr/bin/env node
/**
 * audit_form_fields.mjs — full-field audit of an already-filled ATS tab.
 *
 * Usage:
 *   node src/forms/audit_form_fields.mjs [urlSubstring] [--cdp http://127.0.0.1:9223]
 *
 * Why this exists: the fill drivers only report *required* controls, and Greenhouse stores
 * combobox answers in hidden radio inputs, so "0 invalid controls" is NOT evidence that the
 * form is complete. This walks every visible control, resolves its label, reads the displayed
 * value (react-select single/multi value nodes, or the input value) and prints every blank
 * field — required or optional.
 *
 * Read-only: it never fills or submits anything. A blank checkbox is reported as `[unchecked]`,
 * which is only meaningful together with the question it belongs to.
 */
import { chromium } from "playwright-core";
import { isEmptyDisplayed } from "./field_state.mjs";
import { CONTROL_VALUE_SOURCE } from "./control_value.mjs";

const args = process.argv.slice(2);
const urlSubstring = args.find(a => !a.startsWith("--")) || "";
const cdpIndex = args.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? args[cdpIndex + 1] : "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdp);
const tabs = browser.contexts()[0].pages();
const page = tabs.filter(p => urlSubstring ? p.url().includes(urlSubstring) : /greenhouse\.io/.test(p.url())).at(-1)
  || tabs.at(-1);
if (!page) {
  console.error("no page found");
  process.exit(1);
}
// Work silently: do NOT call page.bringToFront(), so the user's own tab keeps focus.
// Interaction still lands on this page because we address it directly.
page.setDefaultTimeout(Number(process.env.ATS_FORM_TIMEOUT_MS || 15000));
console.log("auditing:", page.url());

// Greenhouse mounts some sections (the standard EEO block with "Please identify your race" in
// particular) only once the page has dwelt near the bottom. Without this pass the audit reports
// "0 blanks" while a required field further down is still empty. Scroll with a real dwell, come
// back up, then audit; repeat the sweep twice to catch sections that mount on the way up.
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let pass = 0; pass < 2; pass++) {
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height + 1500; y += 700) {
    await page.evaluate(py => window.scrollTo(0, py), y);
    await sleep(180);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
}

const rows = await page.evaluate((controlValueSource) => {
  // THE RULE ITSELF LIVES IN `control_value.mjs`, and this file is one of its two readers. It travels in as source
  // and is evaluated here because `page.evaluate` serialises this callback by SOURCE: a Node-side helper is simply
  // not defined in the browser. `clean` and `vis` come out of the same object as `read`, so the normalisation this
  // report prints with and the one the rule reads with cannot drift apart.
  const rule = eval(controlValueSource);
  const { clean, vis } = rule;

  const out = [];
  const controls = [...document.querySelectorAll("input,textarea,select")].filter(el => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    return vis(el) && t !== "hidden";
  });
  for (const el of controls) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const id = el.id || "";
    const wrap = rule.wrapOf(el);
    let label = "";
    if (id) {
      const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lb) label = clean(lb.innerText);
    }
    if (!label) label = clean(el.getAttribute("aria-label"));
    if (!label) label = clean(wrap?.querySelector("label, legend")?.innerText);
    // ══ READ THIS CONTROL'S OWN VALUE, AND RECORD WHERE IT CAME FROM ═══════════════════════════════════════
    //
    // `rule.read` is the composite rule (a wrapper may not answer for a control inside it; a fragment is resolved
    // to the option the control committed), and its cases - with the live form they were observed on - are in
    // `control_value.mjs`. What belongs HERE is why this report prints `from`: the audit's own clean report was
    //
    //     step7_audit.log:6  ok  REQ country  text  Country*  = +1
    //     step7_audit.log:7  ok  REQ phone    tel   Phone*    = +1
    //
    // on greenhouse's board (posting 8279799, 2026-10-14), where `+1` was the NEIGHBOURING country control's dial
    // code wearing the phone's name. `from` is EMPTY when the value came from the control's own input, so an
    // ordinary row prints exactly as it always did; it is set whenever the value came from somewhere else, which is
    // the one thing a reader cannot check by eye.
    const { displayed, from } = rule.read(el, wrap);
    out.push({
      id, type: type || el.tagName.toLowerCase(),
      label: label.slice(0, 90),
      required: el.required || el.getAttribute("aria-required") === "true",
      displayed: displayed.slice(0, 80),
      from: from.slice(0, 90),
      invalid: el.getAttribute("aria-invalid") === "true",
    });
  }
  return out;
}, CONTROL_VALUE_SOURCE);

let blank = 0, invalid = 0;
for (const r of rows) {
  // A PLACEHOLDER IS NOT AN ANSWER. `Select...` is what an unfilled react-select shows, and this test used to count
  // it as a value - so a required, visibly-empty field reported `ok` (the Twitch race field, 2026-10-10). The
  // decision and its cases live in field_state.mjs, where they are tested from both sides: a placeholder must not
  // read as an answer, and a real answer must not read as a placeholder.
  const isEmpty = isEmptyDisplayed(r.displayed);
  if (isEmpty) blank += 1;
  if (r.invalid) invalid += 1;
  const tag = r.invalid ? "INVALID" : isEmpty ? "EMPTY  " : "ok     ";
  // THE PROVENANCE IS PRINTED ONLY WHERE IT IS NOT OBVIOUS. A value read from the control's own input needs no
  // note - `r.from` is empty for those and the line is byte-for-byte what it always was. A value read from a
  // display node, or resolved out of a fragment, carries the element it came from, because that is the one thing
  // a reader cannot check by eye and the thing that made `Country* = +1` look like an answer.
  console.log(`${tag} ${r.required ? "REQ" : "opt"} ${r.id.padEnd(26)} ${r.type.padEnd(9)} ${r.label.padEnd(56)} = ${r.displayed}${r.from ? `  [${r.from}]` : ""}`);
}
console.log(`\ncontrols: ${rows.length} | blank: ${blank} | aria-invalid: ${invalid}`);
console.log("Blank checkboxes are expected; judge them per question, not per box.");
process.exit(0);
