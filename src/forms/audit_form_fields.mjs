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

  /** A short, greppable name for the element a value was read from: `div.select__single-value#country`. */
  const describeNode = el => {
    if (!el) return "nothing";
    const cls = typeof el.className === "string" ? (el.className.trim().split(/\s+/).find(c => !/^(remix|css)-/.test(c)) || "") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls : ""}`;
  };

  /**
   * What ONE display node says, and whether that is a fragment of the option the control committed.
   *
   * THE FRAGMENT CASE, observed on greenhouse's board 2026-10-14: the dial-code select commits the option
   * `Canada +1` (`<div class="iti__flag iti__ca"></div>Canada +1` in its menu) and renders the committed value as
   * `<div class="iti__flag iti__ca"></div><span>+1</span>`. Its textContent is `+1` - TWO characters that name no
   * country, and that the United States and twenty Caribbean nations share. intl-tel-input keeps its whole
   * country list mounted inside the same widget (hidden, never removed), and each row carries
   * `data-country-code` beside its own country name and dial code, so the option's own text is recoverable from
   * the page rather than from a table in this file. The lookup is keyed by the code the VALUE NODE itself
   * carries (`iti__ca`), so it reads the country the control actually committed and not the first row of a list
   * that always starts at Afghanistan.
   *
   * A node whose own text is already the whole option is left exactly as it was - `option !== text` is the test,
   * so a tenant that renders `Canada +1` sees no change at all.
   */
  const readDisplayNode = node => {
    const text = clean(node.textContent);
    const flag = node.querySelector('[class*="iti__flag"]');
    const code = flag ? /(?:^|\s)iti__([a-z]{2})(?=\s|$)/.exec(String(flag.className || "")) : null;
    // SCOPE THE LOOKUP TO THE SMALLEST ANCESTOR THAT CARRIES THE LIST - this widget, not the document. A form with
    // two phone fields carries two of these lists, and a document-wide lookup could read the other widget's row:
    // the "two controls confused for one another" defect in a different disguise.
    let row = null;
    if (code) {
      let scope = null;
      for (let n = node.parentElement; n && !scope; n = n.parentElement) {
        if (n.querySelector(`[data-country-code="${code[1]}"]`)) scope = n;
      }
      row = (scope || node.ownerDocument).querySelector(`[data-country-code="${code[1]}"]`);
    }
    if (row && text) {
      const name = clean(row.querySelector(".iti__country-name")?.textContent);
      const dial = clean(row.querySelector(".iti__dial-code")?.textContent);
      const option = [name, dial].filter(Boolean).join(" ");
      if (name && option && option !== text && option.includes(text)) {
        return { text: option, resolvedFrom: `iti__${code[1]} -> ${option}` };
      }
    }
    return { text, resolvedFrom: "" };
  };

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
    // ══ READ THIS CONTROL'S OWN VALUE, AND RECORD WHERE IT CAME FROM ═══════════════════════════════════════
    //
    // TWO DEFECTS MET HERE, on greenhouse's own board (posting 8279799, 2026-10-14, in a headless Chrome on
    // port 9333), and both produced a CLEAN report for a form that was not:
    //
    //   step7_audit.log:6  ok  REQ country  text  Country*  = +1
    //   step7_audit.log:7  ok  REQ phone    tel   Phone*    = +1
    //
    // 1. A WRAPPER MAY NOT ANSWER FOR A CONTROL INSIDE IT. `id:phone` is the `Phone*` tel input of a composite
    //    phone widget - a react-select `Country*` dial-code selector beside it inside one `fieldset.phone-input`.
    //    It has no `[class*=control]` ancestor of its own, so `holder` fell through to that fieldset and found
    //    the COUNTRY's value node in it: the phone reported the neighbouring control's value, and the phone
    //    number it actually held (`+1 416-555-0182`) was never read. The wrapper below is therefore used ONLY
    //    when this control is the only one in it - the same refusal the label fallback above already makes.
    //
    // 2. A FRAGMENT IS NOT A VALUE. The country's committed option is `Canada +1`, but the control renders the
    //    value node as `<div class="iti__flag iti__ca"></div><span>+1</span>` - textContent `+1`, a dialling code
    //    shared by the United States, Canada and twenty Caribbean nations. Reporting `+1` cannot tell them apart,
    //    which is the rule-5 failure this whole file exists to prevent: a check that asked "is there a value
    //    here" and answered yes. The country name IS on the page - intl-tel-input keeps its full country list
    //    mounted (hidden) inside the widget, each row naming its own code - so the committed option is read back
    //    from it, and `from` records both the element and the resolution.
    //
    // `from` is EMPTY when the value came from the control's own input, so an ordinary row prints exactly as it
    // always did. It is set whenever the value came from somewhere else, which is the case a reader cannot check
    // by eye.
    const ownShell = el.closest('[class*="select__control"], [class*="select-shell"]');
    let holder = null;
    let from = "";
    // ONE RULE FOR EVERY CONTAINER, WHETHER IT IS THE CONTROL'S OWN SHELL OR A WRAPPER AROUND IT: a container may
    // answer for this control only when this control is the ONLY one in it. It matters one level further in than
    // the fieldset case above, and the same page shows why - react-select mounts a second, ref-less `requiredInput`
    // INSIDE `.select-shell`, next to the real select, so a shell-sized read hands the phantom row the country's
    // value and the audit prints an answer for a control that has none.
    const onlyControlIn = node => {
      if (!node) return false;
      const inside = [...node.querySelectorAll("input,textarea,select,[role=combobox]")]
        .filter(n => vis(n) && (n.getAttribute("type") || "").toLowerCase() !== "hidden");
      return inside.length === 1 && inside[0] === el;
    };
    if (onlyControlIn(ownShell)) holder = ownShell;
    else if (onlyControlIn(wrap)) holder = wrap;
    let displayed = "";
    if (holder) {
      const sv = [...holder.querySelectorAll("[class*=singleValue], [class*=multiValue], [class*=single-value]")];
      if (sv.length) {
        const read = sv.map(readDisplayNode);
        displayed = read.map(r => r.text).filter(Boolean).join(" | ");
        const resolved = read.filter(r => r.resolvedFrom);
        const where = sv.length === 1 ? describeNode(sv[0]) : `${sv.length} display nodes in ${describeNode(holder)}`;
        from = resolved.length
          ? `${where}, resolved from ${resolved.map(r => r.resolvedFrom).join(" | ")}`
          : where;
      }
    }
    if (!displayed) {
      if (type === "checkbox" || type === "radio") displayed = el.checked ? "[checked]" : "[unchecked]";
      // A PHONE NUMBER IS READ, NOT MASKED. Email and password stay masked, but `tel` is the one field type whose
      // committed value this audit exists to show: it is the fact the pre-submit review checks, and masking it is
      // how `Phone* = +1` - the NEIGHBOURING country control's dial code - spent a run looking like an answer
      // (greenhouse board 8279799, 2026-10-14). A masked row would have hidden the same defect one layer down.
      else if (["email", "password"].includes(type)) displayed = el.value ? "[masked]" : "";
      else displayed = clean(el.value);
    }
    // Some tenants (Chakra-flavoured Greenhouse: Discord's Location (City) and race fields) render the
    // chosen value as the control container's text with no singleValue node and an empty input value,
    // which made a correctly answered field look blank. Fall back to the control text for those.
    if (!displayed && /select__input|select__value/i.test(el.className || "")) {
      const control = el.closest("[class*=control]");
      displayed = clean(control?.innerText);
      if (displayed) from = `${describeNode(control)} text (no display node)`;
    }
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
  // THE PROVENANCE IS PRINTED ONLY WHERE IT IS NOT OBVIOUS. A value read from the control's own input needs no
  // note - `r.from` is empty for those and the line is byte-for-byte what it always was. A value read from a
  // display node, or resolved out of a fragment, carries the element it came from, because that is the one thing
  // a reader cannot check by eye and the thing that made `Country* = +1` look like an answer.
  console.log(`${tag} ${r.required ? "REQ" : "opt"} ${r.id.padEnd(26)} ${r.type.padEnd(9)} ${r.label.padEnd(56)} = ${r.displayed}${r.from ? `  [${r.from}]` : ""}`);
}
console.log(`\ncontrols: ${rows.length} | blank: ${blank} | aria-invalid: ${invalid}`);
console.log("Blank checkboxes are expected; judge them per question, not per box.");
process.exit(0);
