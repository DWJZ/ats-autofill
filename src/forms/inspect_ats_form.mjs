#!/usr/bin/env node
/**
 * inspect_ats_form.mjs — dump every field of an already-open ATS form tab.
 *
 * Usage:
 *   node src/forms/inspect_ats_form.mjs [urlSubstring] [--cdp URL] [--options] [--out FILE]
 *
 * For every visible control it reports:
 *   ref        stable selector to use in a fill spec (`id:<id>` or `name:<name>`)
 *   label      accessible label (label[for] / aria-label / enclosing question)
 *   tag/type   control kind (text, textarea, checkbox, radio, combobox, file, react-select)
 *   required   whether the form marks it required
 *   value      current displayed value (react-select single/multi value, or input value)
 *   widget     control-mechanism fingerprint, current option inventory, and read-back recipe
 *   extra_widgets  button pairs and div dropdowns with no input/select field
 *
 * With --options it also opens every combobox / react-select and records the option
 * texts, so the resulting JSON is directly editable into a fill spec.
 *
 * Read-only: never fills, never submits.
 */
import { connect as connectCdp } from "./cdp_connect.mjs";
import { DEFAULT_WAIT_MS, boundedPage, withDeadline } from "./bounded_waits.mjs";
import { writeFile } from "node:fs/promises";
import { classifyWidget, summarizeWidgets } from "./widget_fingerprint.mjs";
import { extractPayRange } from "./pay_range.mjs";
import { readAssociatedOptions } from "./widget_dom.mjs";
import { collectApplyAffordances, collectEmbeddedForms, collectExtraWidgets, collectFields } from "./widget_scan.mjs";

const args = process.argv.slice(2);
const urlSubstring = args.find(a => !a.startsWith("--")) || "";
const cdpIndex = args.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? args[cdpIndex + 1] : "http://127.0.0.1:9223";
const outIndex = args.indexOf("--out");
const withOptions = args.includes("--options");
// --html <regex>: print the outerHTML of the TIGHTEST container whose text matches, so a control with no id and no
// name can be READ instead of guessed at. Added 2026-10-07 after three consecutive rounds of writing a fresh selector
// or regex for Alchemy's "How did you hear about this role?" field and for Workday's education block, each failing
// because the real markup had never been looked at. When a locator fails twice, dump the DOM - do not try a third.
const htmlIndex = args.indexOf("--html");
const htmlMatch = htmlIndex >= 0 ? args[htmlIndex + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The shared connect: this tool used to leave a `playwright-artifacts-<random>` directory in the system
// temporary directory on every run. See cdp_connect.mjs for what that costs and why one shared entry point.
const browser = await connectCdp(cdp);
const tabs = browser.contexts()[0].pages();
function pickTarget() {
  if (!urlSubstring) return tabs.filter(p => /greenhouse\.io|ashbyhq\.com|lever\.co/.test(p.url())).at(-1) || tabs.at(-1);
  const matching = tabs.filter(p => p.url().includes(urlSubstring));
  // numeric tokens repeat across tenants and every submitted app keeps a /confirmation tab,
  // so prefer real form pages over confirmations
  const forms = matching.filter(p => !/confirmation/.test(p.url()));
  return forms.at(-1) || matching.at(-1);
}
let page = pickTarget();
if (!page) { console.error("no page"); process.exit(1); }
// Work silently: do NOT call page.bringToFront(), so the user's own tab keeps focus.
// Interaction still lands on this page because we address it directly.
//
// BOUNDED for the same reason as the filler: the scroll walk below is a dozen `page.evaluate` calls in a row,
// and `page.evaluate` is the call measured to ignore a timeout. The refill loop spawns this tool as a step
// with its own budget, and a step that cannot report why it stalled is what that budget then hides.
const bounded = boundedPage(page, "inspect_ats_form", Number(process.env.ATS_FORM_TIMEOUT_MS || DEFAULT_WAIT_MS));
console.log("inspecting:", page.url());

// Mount lazily rendered sections. Greenhouse EEO blocks (the standard "Please identify your race"
// combobox in particular) only mount once the page has actually dwelled near the bottom, so scroll
// with a longer dwell, then walk back up and give the observers a moment before capturing.
const pageHeight = await bounded.evaluate(() => document.body.scrollHeight);
for (let y = 0; y <= pageHeight + 2000; y += 800) {
  await bounded.evaluate(py => window.scrollTo(0, py), y);
  await sleep(260);
}
await bounded.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(900);
await bounded.evaluate(() => window.scrollTo(0, 0));
await sleep(700);

// --html: answer "what IS this control" with the page's own markup. Prints the tightest container whose text matches,
// plus every control inside it with its tag, type, id, name, placeholder, aria-label and readonly state.
if (htmlMatch) {
  const dump = await bounded.evaluate((match) => {
    const rx = new RegExp(match, "i");
    let best = null;
    for (const el of document.querySelectorAll("div,fieldset,section,form")) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!rx.test(t)) continue;
      const controls = [...el.querySelectorAll("input,textarea,select,button")].filter((c) => c.type !== "hidden");
      if (!controls.length) continue;
      // AN ERROR BANNER IS NOT A QUESTION (found 2026-10-07). Ashby's "Your form needs corrections" box names the
      // offending field in a button, and its container carries the field's text - so the tightest match for
      // "How did you hear about this role?" was the ERROR BOX, holding one button and no input at all. That is why
      // three rounds of selectors built on this text never touched the real field. Require a real data control.
      const dataControls = controls.filter((c) => /^(input|textarea|select)$/i.test(c.tagName));
      if (!dataControls.length) continue;
      if (!best || controls.length < best.controls) best = { controls: controls.length, el };
    }
    if (!best) return null;
    const describe = (c) => ({
      tag: c.tagName.toLowerCase(),
      type: c.getAttribute("type") || "",
      id: c.id || "",
      name: c.getAttribute("name") || "",
      placeholder: c.getAttribute("placeholder") || "",
      ariaLabel: c.getAttribute("aria-label") || "",
      ariaLabelledby: c.getAttribute("aria-labelledby") || "",
      role: c.getAttribute("role") || "",
      readonly: c.hasAttribute("readonly"),
      disabled: c.hasAttribute("disabled"),
      visible: Boolean(c.offsetWidth || c.offsetHeight || c.getClientRects().length),
      classes: (c.className || "").toString().slice(0, 120),
    });
    return {
      containerTag: best.el.tagName.toLowerCase(),
      containerClasses: (best.el.className || "").toString().slice(0, 160),
      controlCount: best.controls,
      controls: [...best.el.querySelectorAll("input,textarea,select,button")].map(describe),
      html: best.el.outerHTML.slice(0, 4000),
    };
  }, htmlMatch);
  console.log(JSON.stringify(dump, null, 1));
  process.exit(0);
}

const captureFields = async () => bounded.evaluate(collectFields);

// capture twice and union by ref: late-mounting sections can still be missing on the first pass
const first = await captureFields();
await sleep(900);
const second = await captureFields();
const byRef = new Map();
for (const f of [...first, ...second]) {
  // Several id-less controls may coexist; an empty ref is not a shared identity.
  const identity = f.ref || f.key;
  const prev = byRef.get(identity);
  if (!prev) { byRef.set(identity, f); continue; }
  // prefer the entry that has a value/options and more information
  const score = x => (x.options?.length || 0) * 10 + (x.value ? 5 : 0) + (x.help ? 1 : 0);
  if (score(f) > score(prev)) byRef.set(identity, f);
}
const fields = [...byRef.values()];

// The usual input/select inventory cannot see button-only pairs or a bare
// SELECT... div. Report these separately so draft_form_spec.py's existing
// `fields` contract stays unchanged, while an unknown control becomes visible.
const extraWidgets = await bounded.evaluate(collectExtraWidgets);

if (withOptions) {
  for (const f of fields) {
    if (!f.react_select || !f.ref.startsWith("id:")) continue;
    const id = f.ref.slice(3);
    const box = bounded.locator(`[id="${id}"]`);
    if (await box.count() === 0) continue;
    await page.keyboard.press("Escape").catch(() => {});
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await box.click({ timeoutMs: 6000 }).catch(() => {});
    await sleep(600);
    const openedOptions = await withDeadline(box.evaluate(readAssociatedOptions),
      "reading the options this control opened", DEFAULT_WAIT_MS);
    if (openedOptions.length) f.options = openedOptions;
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(150);
  }
}

// Keep the old field keys intact for draft_form_spec.py. The widget description
// records only the driver shape; question and current options remain per field.
for (const f of [...fields, ...extraWidgets]) f.widget = classifyWidget(f);

console.log(`\nfields: ${fields.length}\n`);
const blank = fields.filter(f => !f.value || f.value === "[unchecked]");
for (const f of fields) {
  const empty = !f.value || f.value === "[unchecked]";
  console.log(`${empty ? "EMPTY" : "ok   "} ${f.required ? "REQ" : "opt"} ${f.ref.padEnd(30)} ${(f.type || f.tag).padEnd(9)} ${f.label.slice(0, 50).padEnd(52)} = ${f.value} [${f.widget.kind}]`);
  if (f.options?.length) console.log(`        options: ${f.options.join(" || ").slice(0, 300)}`);
}
console.log(`\nfields: ${fields.length} | blank: ${blank.length}`);
// A zero inventory on the company-hosted shape is a SILENT failure: the top document carries no
// controls, the real form sits one frame down, and "fields: 0" reads like "this form has no fields"
// rather than "the form is somewhere else". Asana's posting did exactly this on 2026-10-07 (Roblox on
// 2026-10-06). Printing the frame's src is the whole fix - it is the URL to open instead.
if (fields.length === 0 && extraWidgets.length === 0) {
  const frames = await bounded.evaluate(collectEmbeddedForms);
  if (frames.length) {
    console.log(`\nBUT THIS PAGE EMBEDS ${frames.length} FRAME(S). A company-hosted posting usually keeps the real`);
    console.log("form one frame down, and this scanner reads the top document only. Open the frame's own URL:");
    for (const f of frames) console.log(`  ${(f.id || "(no id)").padEnd(18)} ${f.src}`);
  } else {
    // The third reason a page reads zero: the form has not been opened. Workable's /j/<id> is the job
    // description plus an "Apply for this job" button; the same posting under /j/<id>/apply reads six
    // fields. Reporting the control is what makes a blank inventory a next step.
    const affords = await bounded.evaluate(collectApplyAffordances);
    if (affords.length) {
      console.log("\nNO APPLICATION FORM IS OPEN ON THIS PAGE, but it carries an apply control, so the real form");
      console.log("is one step further on - usually the same URL with /apply appended, or this control:");
      for (const a of affords) console.log(`  ${a.tag.padEnd(8)} ${a.text.slice(0, 34).padEnd(36)} ${a.href}`);
    }
  }
}
// ---- the posting's own published pay range ------------------------------------------------------------------
//
// A Greenhouse job board renders the description in the SAME document as the form, so the band is already on the page
// this scanner is reading and needs no second fetch. It is recorded because `draft_form_spec.py`'s compensation rule
// is "top of the published band, or the fallback", and the only band it could see was the one in the FIELD's help
// text - which on the Twitch form is empty, so the fallback fired and $200,000 went into the spec for a posting that
// publishes $127,100 - $185,000. The user asked why the fill did not go through the control-to-answer JSON; it did,
// and the JSON held the wrong number because nothing upstream had looked at the posting.
// THE PAGE SIDE RETURNS ITS TEXT; NODE DOES THE READING. A `page.evaluate` argument cannot be a closure, which is
// exactly why the extraction used to exist twice - and the copy in the API path is the one that got the decode order
// and the span guard wrong. The SCOPE choice stays here because it is genuinely page-specific: a job board renders its
// description somewhere no module can know. The RULE lives in `pay_range.mjs`, with the cases that failed.
const postingText = await bounded.evaluate(() => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  // The POSTING, not the form: a tenant's help text is a different claim from the employer's published band.
  const scope = document.querySelector("#content, .job__description, [class*='job-post'], [class*='job-description'], main")
    || document.body;
  return clean(scope.innerText || "");
});
const payRange = extractPayRange(postingText);
if (payRange && !payRange.source) payRange.source = "the page's own job description";

// ---- an EMBED form has no description on it, so the band has to be looked up -----------------------------------
//
// `/embed/job_app?for=esri&token=5190253007` renders the form alone. `payRange` came back null, the drafter used the
// recorded fallback, and the JD publishes $79,040 - $133,016: the value written was ~50% above the band's top. The
// fallback is for a posting that publishes NOTHING - here a band exists and simply was not read, which is a different
// thing and must not be answered the same way.
//
// The embed URL carries both halves the lookup needs: `for=<board>` and `token=<id>`. This runs only when the page
// produced no range and the route is recognisably an embed, so no other tenant pays for it.
const resolvedPayRange = payRange || await (async () => {
  const m = /\/embed\/job_app[^#]*[?&]for=([^&#]+)[^#]*[?&]token=([^&#]+)/.exec(page.url() || "");
  if (!m) return null;
  const [, board, id] = m;
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
    if (!res.ok) return null;
    const job = await res.json();
    // `pay_range.mjs` decodes the entities, strips the tags and REFUSES a pair with no span. Those are the three
    // things this path got wrong while the page path beside it was right: the content is escaped twice, so `&amp;`
    // must be decoded before `&mdash;`, and without the span guard the two endpoints read as a band
    // `{low: 79040, high: 79040}` whose TOP - the number the drafter takes - is actually the LOWER bound.
    const best = extractPayRange(job.content);
    if (!best) return null;
    return { ...best, source: `boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` };
  } catch {
    // A band that could not be fetched is not a band that does not exist, but the drafter can only act on what it is
    // given - and the fallback's note already says a fallback was used, which is the honest signal for a person.
    return null;
  }
})();

const allWidgets = [...fields, ...extraWidgets];
const unknown = allWidgets.filter(f => !f.widget.recipe);
const widgetSummary = summarizeWidgets(allWidgets);
console.log(`widget types: ${Object.keys(widgetSummary.by_fingerprint).length} | unknown controls: ${widgetSummary.unknown} | provisional verification: ${widgetSummary.provisional}`);
for (const f of extraWidgets) console.log(`  WIDGET ${f.widget.kind} ${f.ref || f.key} ${f.label.slice(0, 80)} options=${JSON.stringify(f.widget.options)}`);
for (const f of unknown) console.log(`  UNKNOWN ${f.widget.kind} ${f.ref || f.key} ${f.label.slice(0, 80)}`);
if (outIndex >= 0) {
  const path = args[outIndex + 1] || "tmp/apply/form_fields.json";
  await writeFile(path, JSON.stringify({ url: page.url(), fields, extra_widgets: extraWidgets, widget_summary: widgetSummary, payRange: resolvedPayRange }, null, 2));
  console.log("wrote", path);
}
process.exit(0);
