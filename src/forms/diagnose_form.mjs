#!/usr/bin/env node
/**
 * diagnose_form.mjs — answer "what is still blocking this form?" in ONE call, with the checks that actually found the
 * blockers on Pindrop, Datavant, TRM, Remesh, Rula, PermitFlow and Backflip.
 *
 * Written because those wins were each reached with a throwaway inline script, and the same diagnostics were re-derived
 * by hand every time. Every check here earned its place:
 *
 *  1. EMPTY COMBOBOXES. Must query BOTH `[role="combobox"]` AND `[class*="select__control"]`. Pindrop sat blocked for
 *     two rounds because the scan only looked for the class and four required questions render as
 *     `INPUT[type=text][role=combobox]` with no wrapper class.
 *  2. UNANSWERED YES/NO PAIRS. Ashby renders Yes/No as two <button>s over a hidden checkbox; the state lives on that
 *     checkbox. Counting them and naming the false one found TRM's real last blocker after the refusal had named two
 *     fields that do not exist in the DOM at all.
 *  3. INLINE REQUIRED MARKER. The literal text "This field is required." with the nearest question around it. This is
 *     how Datavant's missing `race` and Pindrop's four comboboxes were identified when the refusal list was empty.
 *  4. THE REFUSAL'S OWN NAMED FIELDS - and a warning, because that list is CONCATENATED and can name fields that are
 *     not in the rendered DOM (TRM: "Outside Work and Advisory Disclosure", "High Performance Environment").
 *  5. EMPTY REQUIRED TEXT FIELDS and the SPAM FLAG.
 *
 * Committed-value reads walk up to five ancestors looking for a single-value element, because a local lookup reported
 * "no value" for values that were in fact committed - which twice made a successful press look like a failure.
 *
 * USAGE: node src/forms/diagnose_form.mjs <url-part> [--cdp http://127.0.0.1:9223]
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const urlPart = args[0];
if (!urlPart) { console.error("usage: diagnose_form.mjs <url-part>"); process.exit(2); }
const cdpIdx = args.indexOf("--cdp");
const cdp = cdpIdx >= 0 ? args[cdpIdx + 1] : "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing for", urlPart); process.exit(0); }

const report = await page.evaluate(() => {
  const nearestText = (el, maxLen = 74) => {
    let w = el.closest("div,fieldset,li") || el.parentElement;
    for (let i = 0; i < 6 && w; i++) {
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 16) return t.slice(0, maxLen);
      w = w.parentElement;
    }
    return "(no label found)";
  };

  // 1. comboboxes with no committed value (page-wide read, walking ancestors)
  const emptyCombos = [];
  for (const el of document.querySelectorAll('[role="combobox"], [class*="select__control"]')) {
    let val = "";
    let w = el.closest("div") || el.parentElement;
    for (let i = 0; i < 5 && w; i++) {
      const sv = w.querySelector('[class*="singleValue"], [class*="select__single-value"]');
      if (sv && (sv.innerText || "").trim()) { val = (sv.innerText || "").trim(); break; }
      w = w.parentElement;
    }
    if (val) continue;
    const q = nearestText(el, 68);
    if (/^option , selected|^\d+ results found|Afghanistan\+93/.test(q)) continue;   // the country search box
    emptyCombos.push(q);
  }

  // 2. Yes/No pairs whose hidden checkbox is NOT CHECKED. CAUTION: on a paired Yes/No control the checkbox being
  // unchecked is how "No" is stored (TRM's outside-employment pair was answered No and read as unchecked), so an
  // unchecked box is NOT proof of an unanswered question - it means "not Yes". Read the buttons' own state before
  // concluding anything, and never report these as "unanswered" without checking.
  const uncheckedPairs = [];
  const pairBoxes = [...document.querySelectorAll('input[type="checkbox"]')];
  for (const cb of pairBoxes) {
    if (cb.checked) continue;
    const label = (cb.closest("label")?.innerText || cb.parentElement?.innerText || "").replace(/\s+/g, " ").trim();
    if (!/^yes\s*no$/i.test(label) && !/^yes$/i.test(label)) continue;               // the pair pattern
    const q = nearestText(cb, 78);
    if (q && q !== "(no label found)") uncheckedPairs.push(q);
  }

  // 3. the inline required marker, with its nearest question
  const inlineRequired = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.children.length) continue;
    const t = (el.innerText || "").trim();
    if (t !== "This field is required." && t !== "This field is required") continue;
    inlineRequired.push(nearestText(el.parentElement || el, 90));
  }
  // 5a. empty required text inputs / textareas
  const emptyRequiredText = [];
  for (const el of document.querySelectorAll("input[type=text], input[type=email], input[type=tel], textarea")) {
    if ((el.value || "").trim()) continue;
    if (!(el.required || el.getAttribute("aria-required") === "true")) continue;
    if (!el.offsetParent) continue;
    emptyRequiredText.push(`${(el.id || "-").slice(0, 30)} :: ${nearestText(el, 52)}`);
  }

  const body = document.body.innerText.replace(/\s+/g, " ");
  return {
    spamFlagged: /flagged as possible spam/i.test(body),
    refusalNames: [...new Set((body.match(/Missing entry for required field: [^.]{3,80}/g) || []))].slice(0, 6),
    inlineRequired: [...new Set(inlineRequired)].slice(0, 4),
    // NOTE: on Ashby's NATIVE combobox (INPUT[type=text][role=combobox] with no wrapper class) the committed value
    // is not exposed as a single-value element, so a filled question can still appear here. Treat this list as
    // "possibly empty", and confirm by opening the question with pick_ashby_combobox.mjs --rowsOnly instead.
    emptyCombos: [...new Set(emptyCombos)].slice(0, 8),
    uncheckedPairs: [...new Set(uncheckedPairs)].slice(0, 8),
    emptyRequiredText: emptyRequiredText.slice(0, 6),
    pairCount: pairBoxes.length,
    pairChecked: pairBoxes.filter((c) => c.checked).length,
  };
});

console.log(JSON.stringify(report, null, 1));
process.exit(0);
