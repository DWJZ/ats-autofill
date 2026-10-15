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

const rows = await page.evaluate(() => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const out = [];
  const controls = [...document.querySelectorAll("input,textarea,select")].filter(el => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    return vis(el) && t !== "hidden";
  });
  for (const el of controls) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const id = el.id || "";
    const wrap = el.closest("[class*=question], fieldset, div[class*=field]") || el.parentElement?.parentElement || el.parentElement;
    let label = "";
    if (id) {
      const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lb) label = clean(lb.innerText);
    }
    if (!label) label = clean(el.getAttribute("aria-label"));
    if (!label) label = clean(wrap?.querySelector("label, legend")?.innerText);
    // Read the value from THIS control's own react-select control container. Reading the whole
    // question wrapper leaks a sibling's value and makes an empty field look answered.
    let displayed = "";
    const control = el.closest("[class*=control]");
    const holder = control?.parentElement || wrap;
    if (holder) {
      const sv = holder.querySelectorAll("[class*=singleValue], [class*=multiValue], [class*=single-value]");
      if (sv.length) displayed = [...sv].map(n => clean(n.textContent)).filter(Boolean).join(" | ");
    }
    if (!displayed) {
      if (type === "checkbox" || type === "radio") displayed = el.checked ? "[checked]" : "[unchecked]";
      else if (["email", "tel", "password"].includes(type)) displayed = el.value ? "[masked]" : "";
      else displayed = clean(el.value);
    }
    // Some tenants (Chakra-flavoured Greenhouse: Discord's Location (City) and race fields) render the
    // chosen value as the control container's text with no singleValue node and an empty input value,
    // which made a correctly answered field look blank. Fall back to the control text for those.
    if (!displayed && /select__input|select__value/i.test(el.className || "")) {
      displayed = clean(control?.innerText);
    }
    out.push({
      id, type: type || el.tagName.toLowerCase(),
      label: label.slice(0, 90),
      required: el.required || el.getAttribute("aria-required") === "true",
      displayed: displayed.slice(0, 80),
      invalid: el.getAttribute("aria-invalid") === "true",
    });
  }
  return out;
});

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
  console.log(`${tag} ${r.required ? "REQ" : "opt"} ${r.id.padEnd(26)} ${r.type.padEnd(9)} ${r.label.padEnd(56)} = ${r.displayed}`);
}
console.log(`\ncontrols: ${rows.length} | blank: ${blank} | aria-invalid: ${invalid}`);
console.log("Blank checkboxes are expected; judge them per question, not per box.");
process.exit(0);
