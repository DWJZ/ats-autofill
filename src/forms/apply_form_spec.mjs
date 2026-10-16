#!/usr/bin/env node
/**
 * apply_form_spec.mjs — fill any ATS form (Greenhouse / Ashby / Lever / react-select
 * variants) from a small JSON spec, then verify. Never submits.
 *
 * Usage:
 *   node src/forms/apply_form_spec.mjs <spec.json> [--cdp URL] [--dry-run]
 *
 * Spec format (all sections optional):
 * {
 *   "target": "job_application_requests",     // url substring of the tab to use
 *   "texts":   [ { "ref": "id:first_name", "value": "Example" } ],
 *   "textareas":[ { "ref": "id:question_1", "value": "..." } ],
 *   "selects": [ { "ref": "id:question_2", "option": "Yes", "search": "Yes" } ],
 *   // A PLACE PICKER WHOSE LIST DOES NOT EXIST UNTIL A QUERY IS TYPED - a `typeahead` entry instead of an
 *   // option list. The query and the acceptance test are derived from `typeahead` by location_place.mjs.
 *   "selects": [ { "ref": "id:candidate-location", "option": "Springfield, Illinois, United States of America",
 *                  "typeahead": { "city": "Springfield", "state": "Illinois",
 *                                 "country": "United States of America" } } ],
 *   "checks":  [ { "ref": "id:cb_1", "checked": true } ],
 *   "files":   [ { "ref": "group:Resume/CV", "path": "/abs/path.pdf" } ],
 *   "verify_blank": true                       // print every visible blank field at the end
 * }
 *
 * Everything is data: no job-specific code. Fill specs are cached per job beside
 * the generated ATS configs, which live in the DATA directory
 * (<data>/autofill/<platform>/<slug>.json) rather than in the source tree - they hold
 * the applicant's own answers, so `src/` is the one place they must not be.
 *
 * Safety: never clicks a submit control. If the page shows a submit button it is
 * reported, not pressed.
 */
import { connect as connectCdp } from "./cdp_connect.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSubmit } from "./spec_guard.mjs";
import { DEFAULT_WAIT_MS, boundedPage } from "./bounded_waits.mjs";
// THE PLACE RULE IS SHARED, NOT RESTATED. What to type into a place picker and what a committed row must look
// like are derived from ONE address by `location_place.mjs` - the module Ashby's Location autocomplete already
// uses. A second copy here is how `, CA` and "california" ended up in the same call path on a candidate who
// lived in Toronto.
import { committedMatches, locationPlan } from "./location_place.mjs";

const args = process.argv.slice(2);
const specPath = args.find(a => !a.startsWith("--"));
const cdpIndex = args.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? args[cdpIndex + 1] : "http://127.0.0.1:9223";
const dryRun = args.includes("--dry-run");
if (!specPath) { console.error("usage: apply_form_spec.mjs <spec.json>"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spec = JSON.parse(await readFile(specPath, "utf8"));
// Refuse a spec that asks for a submit BEFORE touching the page. This filler never presses Submit, so such a spec
// is either a mistake or a shape this filler does not understand; failing here is much cheaper than half-applying
// it and finding out at review. Verified against all 1,502 specs in data/form_specs/ with zero false positives.
assertNoSubmit(spec);

// A FILL MUST NOT LITTER THE MACHINE IT RUNS ON, and the first attempt at that was the tempting wrong fix:
// passing `artifactsDir` only chooses WHERE Playwright's `playwright-artifacts-<random>` directory goes, and
// nothing removes it - not `await browser.close()` (measured: the count still rose 52 -> 53), and not an
// `artifactsDir` in the checkout, which leaves the directory sitting in `tmp/` instead of the system temp dir.
// The removal is what was missing. `cdp_connect.mjs` owns it now, for this tool and every other one that
// attaches, so there is a single place where attaching and cleaning up are the same act.
const browser = await connectCdp(cdp);
const tabs = browser.contexts()[0].pages();
// Prefer an actual application form over a confirmation page: several tenants share
// numeric job tokens (…1002 vs …2002), so also require the form path when possible.
function pickTarget() {
  // With no explicit target, derive one from the spec's own job URL (host + first path segments), which
  // is enough for Ashby (`jobs.ashbyhq.com/<org>/<uuid>`) and other path-based ATS. Without this the
  // function fell back to "last tab on the browser", which silently filled the Outlook mailbox search box
  // instead of the Suno application (2026-09-27).
  const derived = (() => {
    if (spec.target || !spec.url) return "";
    try {
      const u = new URL(spec.url);
      const parts = u.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
      return parts ? `${u.hostname}/${parts}` : u.hostname;
    } catch { return ""; }
  })();
  const target = spec.target || derived;
  if (!target) return tabs.filter(p => /greenhouse\.io/.test(p.url())).at(-1) || tabs.at(-1);
  const matching = tabs.filter(p => p.url().includes(target)).filter(p => !/confirmation/.test(p.url()));
  const forms = matching.filter(p => /embed\/job_app|job_application_requests|\/apply|\/application/.test(p.url()));
  return forms.at(-1) || matching.at(-1);
}
let page = pickTarget();
if (!page) { console.error("no matching tab for target:", spec.target); process.exit(1); }
if (/confirmation/.test(page.url())) {  console.error(`refusing to fill a confirmation page: ${page.url()}`);
  process.exit(2);
}
// Work silently: do NOT call page.bringToFront(), so the user's own tab keeps focus.
// Interaction still lands on this page because we address it directly.
//
// BOUNDED. `setDefaultTimeout` covers the actions Playwright gives a timeout to; it does NOT cover
// `page.evaluate` or `locator.count()`, which are measured to ignore one and wait forever on a renderer that
// has stopped answering. Both go through `boundedPage`, so a page that goes quiet ends this run with a
// message naming the read instead of a process that never exits and a caller that reports `status: null`.
const bounded = boundedPage(page, "apply_form_spec", Number(process.env.ATS_FORM_TIMEOUT_MS || DEFAULT_WAIT_MS));
console.log("filling:", page.url());

function locator(ref) {
  // NEVER MATCH LOOSELY. An empty ref used to fall through to `[id=""]`, which matches whatever the ATS has not yet
  // hydrated - on Oneleet/Ashby that was the NAME input, and the city string was submitted as the candidate's name
  // (2026-10-05). An empty or unprefixed ref is a planning bug, so it stops the run instead of guessing.
  const _r = String(ref ?? "");
  if (!_r.trim()) {
    throw new Error(
      "apply_form_spec: refusing an EMPTY ref. An empty ref falls through to [id=\"\"] and can type into the wrong " +
      "control (this wrote a city into a name field once). Use id:, name:, label:, role:, group: or css: - and for a " +
      "field with none of those, use retype_all_text.mjs --values with a 'question:<text>' key.",
    );
  }
  if (!/^(id|name|role|label|group|css):/.test(_r)) {
    throw new Error(
      `apply_form_spec: refusing a BARE ref ${JSON.stringify(_r)}. Prefix it with id:, name:, label:, role:, group: or ` +
      "css: so the target is explicit.",
    );
  }
  // A `checks` ENTRY MUST BE AN OBJECT WITH A `ref`, NEVER A BARE STRING. `{"checks": ["id:question_.."]}`
  // crashes HERE with `Cannot read properties of undefined (reading 'startsWith')` and fills nothing at all -
  // the failure appears before any control is touched, so it reads as a broken form rather than a malformed spec.
  // The shape is `{"checks": [{"ref": "id:question_..._749518315"}]}`. (Upstart, 2026-10-05)
  if (_r.startsWith("id:")) return bounded.locator(`[id="${_r.slice(3)}"]`);
  if (_r.startsWith("name:")) return bounded.locator(`[name="${_r.slice(5)}"]`);
  if (_r.startsWith("role:")) return bounded.getByRole("combobox", { name: new RegExp(esc(_r.slice(5))) }).first();
  if (_r.startsWith("label:")) return bounded.getByLabel(new RegExp("^" + esc(_r.slice(6)))).first();
  if (_r.startsWith("group:")) return bounded.getByRole("group", { name: new RegExp("^" + esc(_r.slice(6)), "i") }).first();
  if (_r.startsWith("css:")) return bounded.locator(_r.slice(4));
  return bounded.locator(`[id="${ref}"]`);
}

const log = [];

async function fillText(item) {
  const el = locator(item.ref);
  if (await el.count() === 0) return log.push({ ref: item.ref, kind: "text", ok: false, err: "not found" });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // A NUMBER INPUT REJECTS FORMATTED TEXT. Playwright throws "Cannot type text into input[type=number]" and the whole
  // run aborts - which is how PermitFlow's spec died on a compensation value written as "$250,000". Strip currency
  // symbols and thousands separators for number inputs instead of failing, and say so in the log.
  let value = item.value;
  let numberNote = "";
  const inputType = (await el.getAttribute("type").catch(() => null)) || "";
  if (inputType === "number") {
    const cleaned = String(value).replace(/[^0-9.\-]/g, "");
    // AN ANSWER THAT CLEANS TO NOTHING IS NOT A REFORMATTED ANSWER. "$250,000" -> "250000" is the intended repair
    // (PermitFlow, whose spec died on the currency symbol). "negotiable" -> "" is the value being DESTROYED, and
    // until now the line below reported it as a success BEFORE the field was touched - so the only entry the step
    // produced said OK about a field that was about to be left empty. Counsel, driving-widgets-cases-3.
    if (cleaned === "" && String(value).trim() !== "") {
      return log.push({ ref: item.ref, kind: "text", ok: false,
        err: `a number input cannot hold ${JSON.stringify(String(value).slice(0, 24))}: nothing numeric survives, so the field would stay empty. Give a number, or list it for a human.` });
    }
    if (cleaned !== String(value)) numberNote = `${value} -> ${cleaned} (number input)`;
    value = cleaned;
  }
  // REAL MOUSE AND KEYBOARD, NEVER DOM VALUE-SETTING. This line used to be `el.fill(...)`, which sets the value in one
  // shot through the DOM. That is forbidden by the standing contract for exactly the reason Hex exposed on 2026-10-05:
  // a React-controlled input IGNORES a programmatic fill, so the value either never lands or lands and is reverted by
  // the framework's own state - while this tool reported OK for both fields. The name field ended up holding the text
  // meant for a different question and the source field stayed empty, and the SERVER refused the submission twice.
  // Clicking, selecting and typing drives the same event path a person does.
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // A CLICK THAT FAILS WITH A HEALTHY BOX IS AN OVERLAY, AND WHAT IS ON TOP AT THE POINT IS HOW YOU TELL.
  // Reach for that diagnostic BEFORE inventing any theory about a form that will not accept input; the Workday
  // helper learned it and the generic filler kept swallowing the failure. A consent banner over the field reads as
  // "this widget refuses input" and sends the next reader hunting for a widget bug when the page is simply covered.
  //
  // REPORTED, NEVER ACTED ON: typing proceeds exactly as before, because a covered field is often still
  // reachable by keyboard - and because changing what the filler does on a failed click is a different change
  // from telling the reader what happened.
  let clickNote = "";
  const clickFailed = await el.click({ timeout: 12000 }).then(() => false).catch(() => true);
  if (clickFailed) {
    const at = await el.evaluate(node => {
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return "the control has no box on screen";
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return "the point is off-screen or empty";
      if (top === node || node.contains(top)) return "nothing is covering it";
      const cls = typeof top.className === "string" && top.className.trim() ? "." + top.className.trim().split(/\s+/)[0] : "";
      return `${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}${cls} is on top`;
    }).catch(() => null);
    clickNote = at ? `the click failed; at the control's centre: ${at}`
      : "the click failed, and the point could not be read";
  }
  await sleep(180);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 8 });
  // BLUR SO THE change EVENT FIRES (Baseten, 2026-10-03). A value can sit in the DOM and read back correctly through
  // inputValue while the SERVER still reports the field missing - Baseten named Email and Current Company repeatedly after
  // fills that looked flawless, and the same values committed the moment a Tab blurred the field.
  await page.keyboard.press("Tab").catch(() => {});
  await sleep(260);
  // READ BACK AND FAIL LOUDLY. Reporting OK without checking is what let the Hex failure through twice. Any mismatch
  // between what was typed and what committed is a failure, not a note.
  const readBack = (await el.inputValue().catch(() => null));
  if (readBack === null) {
    log.push({ ref: item.ref, kind: "text", ok: false, err: "could not read the field back" });
    return;
  }
  // A PAGE MASK THAT REFORMATS THE VALUE IS NOT A MISMATCH (fixed 2026-10-07). Workable's salary fields carry a
  // thousands-separator mask: pressing "170000" into one reads back "170,000", and the exact-equality test above
  // called that a failure on a field that was in fact correct - the same shape as a phone that stores "202-555-0173"
  // for "+1 202 555 0173". When the two sides agree once grouping separators, spaces, currency signs and parentheses
  // are removed, the value committed and the difference is the page's own formatting. Anything else is still a
  // failure, so the desync this check exists to catch is unaffected.
  const stripFormatting = (s) => String(s).replace(/[\s,\u00a0\u202f$()]/g, "");
  // A PHONE FIELD GETS THE SAME TREATMENT, BUT ONLY BY ITS DIGITS (fixed 2026-10-07). Greenhouse rewrites
  // "+1 202 555 0173" to "+1 202-555-0173" and the separator rule above still called it a mismatch because a hyphen
  // is not in the strip set. Adding the hyphen there would also weaken every date and version field, so the digit
  // comparison is confined to `tel` inputs, where the digits ARE the value and the punctuation is presentation.
  const digitsOnly = (s) => String(s).replace(/\D/g, "");
  if (readBack.trim() !== String(value).trim()) {
    const sameDigits = inputType === "tel" && digitsOnly(readBack).length >= 7 && digitsOnly(readBack) === digitsOnly(value);
    if (sameDigits || (stripFormatting(readBack) && stripFormatting(readBack) === stripFormatting(value))) {
      log.push({ ref: item.ref, kind: "text", ok: true, value, verified: true, reformatted: readBack });
      return;
    }
    log.push({ ref: item.ref, kind: "text", ok: false,
      // The note belongs on THIS entry most of all: a covered field is exactly the case where the click failed
      // AND the value did not land, so the reader needs to know a banner is on top rather than that the widget
      // is broken.
      err: `read-back mismatch: typed ${JSON.stringify(String(value).slice(0, 30))} but the field holds ${JSON.stringify(readBack.slice(0, 30))}`,
      ...(clickNote ? { note: clickNote } : {}) });
    return;
  }
  // Always exactly one entry per ref. The old guard skipped this one whenever the number cleaning had changed
  // the value, because the premature entry above had already been pushed - so removing that entry means
  // removing the guard, and the cleaning note now travels on the entry that reports the real read-back.
  log.push({ ref: item.ref, kind: "text", ok: true, value: numberNote || value, verified: true,
    ...(clickNote ? { note: clickNote } : {}) });
}

/**
 * What the control at `ref` currently displays, read from ITS OWN container and nothing else.
 *
 * A react-select keeps the committed value in a display node, not in `input.value` (greenhouse's
 * `Location (City)` holds the chosen place in `div.select__single-value` while its input is empty), and a native
 * `<select>` keeps it in the selected option. Both branches scope to THIS control: the search starts at the
 * control's own `[class*=control]` container, so a composite that holds two controls cannot answer for its
 * neighbour. Greenhouse's phone widget is that composite - a `Country*` react-select beside the
 * `Phone*` input inside one `fieldset.phone-input` - and a read that climbed to the fieldset reported the dial
 * code `+1` as the phone number in the audit (`step7_audit.log:7`, 2026-10-14).
 */
async function committedText(ref) {
  const selector = ref.startsWith("id:") ? `[id="${ref.slice(3)}"]` : ref;
  return bounded.evaluate(sel => {
    const node = document.querySelector(sel);
    if (!node) return "";
    // Native <select> (Greenhouse EEO dropdowns: ids 430/431/432/433/434/436) keeps its value in the
    // selected option, not in a react-select control container.
    if (node.tagName === "SELECT") {
      const option = node.selectedOptions && node.selectedOptions[0];
      return ((option?.textContent || "") + " " + (node.value || "")).replace(/\s+/g, " ").trim();
    }
    // THE DISPLAY NODE IS THE AUTHORITY; THE CONTAINER'S TEXT IS NOT. This used to read
    // `closest('div[class*="control"]').innerText`, and on a committed react-select that returns the whole
    // container's text - the PLACEHOLDER first, then every option of the menu that happens to be rendered:
    //
    //     "Select... United States +1 Canada +1 Afghanistan +93"
    //
    // Two failures came out of that one expression. The value was never at the start, so `committed()` - which
    // anchors on `^option` - reported "not committed" for a control that HAD committed, and the filler then
    // re-opened a control it had already set. Round 1 of a refill loop happened to pass (the menu was not in the
    // DOM when it verified), and by round 3 re-opening an already-committed list timed out on an invisible
    // `<option>` and aborted the whole fill with exit 1.
    //
    // `control_value.mjs` - what the AUDIT reads a field with - has always looked for the `singleValue` /
    // `multiValue` node, and it reported this control correctly the whole time. THE TWO READERS DISAGREEING IS
    // THE DEFECT: the audit said "United States +1" while the filler said "not committed". Reading the same node
    // in both places is what makes filling and verifying agree about what the page holds.
    const container = node.closest('div[class*="control"]') || node;
    const values = container.querySelectorAll(
      "[class*=singleValue], [class*=multiValue], [class*=single-value], [class*=multi-value]");
    const shown = [...values].map(el => el.textContent || "").join(" ").replace(/\s+/g, " ").trim();
    if (shown) return shown;
    // NO DISPLAY NODE: the control is empty, or its own input carries the value (a text input inside a
    // react-select shell). The input's `value` is the fact there - never the container's text.
    return String(node.value || "").replace(/\s+/g, " ").trim();
  }, selector).catch(() => "");
}

/**
 * The listbox THIS control is offering, as a locator, or null when it is offering none.
 *
 * SCOPED, ALWAYS. `getByRole("option")` over the whole page returns other widgets' rows: Greenhouse's phone
 * widget keeps intl-tel-input's 244 dial-code rows mounted inside a hidden dropdown, so an unscoped search
 * reports that the location control "returns countries" (the misdiagnosis DoorDash's form cost two rounds on).
 * The control's own listbox is named by its `aria-controls`; a combobox that does not wire one gets the listbox
 * inside its own `select__control`/`select-shell`, and nothing outside it.
 */
async function offeredScope(ref) {
  const el = locator(ref);
  const listboxId = await el.getAttribute("aria-controls").catch(() => null);
  if (listboxId) {
    const box = bounded.locator(`[id="${listboxId}"]`);
    if (await box.count()) return box.first();
  }
  const shell = el.locator('xpath=ancestor::*[contains(@class,"select__control") or contains(@class,"select-shell")][1]');
  if (await shell.count()) {
    const box = shell.first().locator('[role="listbox"]');
    if (await box.count()) return box.first();
  }
  return null;
}

/**
 * The rows that control is offering: `{index, text}` in document order, each read in ONE page call.
 *
 * A hidden row is not offered. The dial-code list above is exactly that - present in the DOM, listed as
 * `role="option"`, and never on screen - so visibility is read here rather than left to a click timeout.
 */
async function offeredRows(ref) {
  const scope = await offeredScope(ref);
  if (!scope) return { scope: null, rows: [] };
  const rows = await scope.locator('[role="option"]').evaluateAll(nodes => nodes.map((node, index) => ({
    index,
    text: (node.textContent || "").replace(/\s+/g, " ").trim(),
    visible: Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
  }))).catch(() => []);
  return { scope, rows: rows.filter(row => row.visible && row.text) };
}

/**
 * Drive a PLACE TYPEAHEAD, where the spec says `typeahead` instead of an option list.
 *
 * WHY THIS EXISTS (greenhouse board, posting 8279799, 2026-10-14). `Location (City)*` is a react-select
 * combobox whose listbox is not in the DOM until a query is typed into it, so the drafter used to describe it as
 * an option list and the filler asked it for the option `Toronto, Ontario, Canada`:
 *
 *     step7_fill.log:10  FAIL select id:candidate-location  option not found: Toronto, Ontario, Canada
 *
 * The control wanted a query typed into it, a wait for the rows it then offers, and a commit that is read back.
 * That is the same shape Ashby's Location autocomplete has, so the queries and the acceptance test come from the
 * same shared rule (`location_place.mjs`) rather than from anything written here.
 *
 * THE READ-BACK IS THE POINT OF THE CHANGE. A row is offered only for the query that was typed, and a place list
 * offers NAMESAKES: typing "Toronto" on this page offered `Toronto, Ontario, Canada` first and then Toronto,
 * Ohio; Toronto, Kansas; Toronto, England, United Kingdom; ... A picker that clicks and reports OK commits
 * whichever row it happened to hit, and nothing downstream can tell a right city from a wrong one on a field that
 * decides a pay band or an office. So a row is clicked only when its own text satisfies the address's state or
 * country, and after the commit the control's RENDERED value is read back and checked again. A commit that does
 * not name the profile's place is reported as a failure naming what the list offered, and the field is left for a
 * person rather than filled with a plausible-looking wrong city.
 */
async function chooseTypeahead(item) {
  const plan = locationPlan(item.typeahead);
  if (!plan.queries.length) {
    return log.push({ ref: item.ref, kind: "select", ok: false,
      err: "typeahead entry carries no place to type (no city in it) - nothing was typed into the control" });
  }
  const el = locator(item.ref);
  if (await el.count() === 0) return log.push({ ref: item.ref, kind: "select", ok: false, err: "not found" });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const expected = plan.expectations.join(" | ") || "(nothing)";
  const attempted = [];
  // The first rows the list offered, quoted once. They are the same rows for every query on a place list (the
  // query narrows a remote list rather than filtering a local one), so repeating them per query only makes the
  // failure line unreadable - and this line is the whole report of a refusal.
  let offered = "";
  for (const query of plan.queries) {
    await el.click({ timeoutMs: 8000 }).catch(() => {});
    await sleep(200);
    await page.keyboard.press("Meta+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    // Real keystrokes, never a DOM value-set: a react-select opens its menu from typing, and a remote list is
    // asked for its rows per keystroke.
    await el.pressSequentially(query, { delayMs: 40, timeoutMs: 8000 }).catch(() => {});
    await sleep(900);
    const { scope, rows } = await offeredRows(item.ref);
    if (!rows.length) { attempted.push(`${JSON.stringify(query)}: no rows`); continue; }
    if (!offered) offered = rows.slice(0, 3).map(r => r.text).join(" | ");
    // The aim first (the list may print exactly what the address says), then any row that names the same STATE
    // or COUNTRY. Never "the first row": that is how a namesake gets committed.
    const pick = rows.find(r => r.text === item.option) || rows.find(r => committedMatches(r.text, plan.expectations));
    if (!pick) {
      attempted.push(`${JSON.stringify(query)}: ${rows.length} row(s), none naming ${expected}`);
      continue;
    }
    const row = scope.locator('[role="option"]').nth(pick.index);
    await row.click({ timeoutMs: 8000 }).catch(async () => {
      const box = await row.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        await page.mouse.down().catch(() => {});
        await page.mouse.up().catch(() => {});
      }
    });
    await sleep(500);
    const committed = await committedText(item.ref);
    if (committedMatches(committed, plan.expectations)) {
      return log.push({ ref: item.ref, kind: "select", ok: true, value: committed, verified: true,
        note: `typeahead: clicked ${JSON.stringify(pick.text)} after typing ${JSON.stringify(query)}` });
    }
    attempted.push(`${JSON.stringify(query)}: clicked ${JSON.stringify(pick.text)}, read back ${JSON.stringify(committed)}`);
  }
  await page.keyboard.press("Escape").catch(() => {});
  // NOTHING IS COMMITTED, SO NOTHING MAY BE LEFT LOOKING COMMITTED. The queries were typed into the control and a
  // react-select keeps the typed text in its input until a row is clicked, so a failed typeahead used to leave
  // "Toronto" sitting in the field as if it were an answer - the same shape as Brex's `HeHeHeHeHe`, where the
  // filter text survived as the value. The typed text is cleared with real keystrokes before the failure is
  // reported, and what the control holds afterwards is what the FAIL line names.
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  return log.push({ ref: item.ref, kind: "select", ok: false,
    err: `typeahead did not commit a place naming ${expected}. Tried ${attempted.join("; ")}` +
         (offered ? `. The list offered: ${offered}` : "") });
}

async function choose(item) {
  // A PLACE TYPEAHEAD IS NOT AN OPTION LIST, so it is not driven like one. The spec entry says `typeahead` when
  // the control's list does not exist until a query is typed (see `chooseTypeahead`).
  if (item.typeahead) return chooseTypeahead(item);
  await page.keyboard.press("Escape").catch(() => {});
  const el = locator(item.ref);
  if (await el.count() === 0) return log.push({ ref: item.ref, kind: "select", ok: false, err: "not found" });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // Native <select> (Lever's country picker, Greenhouse's numeric-id EEO dropdowns): pick by visible
  // label, falling back to a case-insensitive prefix/substring match on the option text. The
  // react-select path below would only look for a popup that a native select never renders.
  if (await el.first().evaluate(element => element.tagName === "SELECT").catch(() => false)) {
    const select = el.first();
    // A MULTIPLE SELECT ACCUMULATES; A SINGLE ONE REPLACES. `selectOption` SETS the selection, so a second spec
    // entry naming the same `multiple` select silently discarded the first - which is exactly why
    // `native_multi_select` was the corpus's one known gap: it was fingerprinted and never driven, and its test
    // recorded the overwrite instead of the behaviour. Three fields in the corpus use the shape. Adding to what
    // is already chosen is what the widget means, and it is what the recipe now claims.
    const isMultiple = await select.evaluate(element => element.multiple).catch(() => false);
    const alreadyChosen = isMultiple
      ? await select.evaluate(element => [...element.selectedOptions].map(option => option.textContent.trim()))
      : [];
    await select.selectOption(isMultiple ? [...alreadyChosen, item.option] : { label: item.option }).catch(() => {});
    let value = await select.evaluate(element =>
      (element.multiple ? [...element.selectedOptions] : [element.selectedOptions[0]])
        .map(option => option?.textContent?.trim() || "").filter(Boolean).join(", "));
    if (!new RegExp("^" + esc(item.option), "i").test(value)) {
      const options = await select.evaluate(element => [...element.options].map(option => option.textContent.trim()));
      const match = options.find(option => new RegExp("^" + esc(item.option), "i").test(option))
        || options.find(option => new RegExp(esc(item.option), "i").test(option));
      if (match) await select.selectOption(isMultiple ? [...alreadyChosen, match] : { label: match }).catch(() => {});
      value = await select.evaluate(element =>
        (element.multiple ? [...element.selectedOptions] : [element.selectedOptions[0]])
          .map(option => option?.textContent?.trim() || "").filter(Boolean).join(", "));
    }
    const ok = new RegExp(esc(item.option), "i").test(value);
    return log.push({ ref: item.ref, kind: "select", ok, value, err: ok ? undefined : `native select did not take: ${item.option}` });
  }
  // A react-select keeps the chosen value in the control container's text, not in input.value, so a
  // field that already holds the wanted option must be detected before re-opening it (re-opening and
  // re-picking can drop the selection).
  const selectedText = () => committedText(item.ref);
  // A react-select country-code control renders "United States +1" as just "+1", so an exact prefix
  // match is too strict; accept the dial-code token as evidence the option was committed.
  const committed = (text, option) => {
    if (new RegExp("^" + esc(option)).test(text)) return true;
    const dial = option.match(/\+\d{1,4}\b/);
    return Boolean(dial && text.includes(dial[0]) && text.length <= dial[0].length + 4);
  };
  if (committed(await selectedText(), item.option)) {
    return log.push({ ref: item.ref, kind: "select", ok: true, value: item.option, note: "already selected" });
  }
  // react-select renders its real <input> a few pixels wide inside a control div; clicking that
  // sliver is flaky (Grafana's Location (City), Affirm's Pronouns), so click the control instead.
  let clicked = false;
  const control = bounded.locator(`xpath=//*[@id="${item.ref.startsWith("id:") ? item.ref.slice(3) : ""}"]/ancestor::div[contains(@class,'control')][1]`);
  if (item.ref.startsWith("id:") && await control.count() > 0) {
    clicked = await control.first().click({ timeoutMs: 8000 }).then(() => true).catch(() => false);
  }
  if (!clicked) await el.click({ timeoutMs: 8000 });
  if (item.search) {
    // react-select opens its menu from keystrokes. THE FIRST ATTEMPT IS NOW REAL KEYSTROKES TOO: it used to be
    // `el.fill(item.search)`, with a `pressSequentially` fallback that only ran when NO options appeared. That fallback
    // could never fire on a tenant where fill() appears to work but never commits - which is the failure mode the
    // contract's "never DOM value-setting" rule exists to prevent, and which Hex demonstrated on a plain text field the
    // same day (fill() reported OK while the form reverted the value). Typing is the only path used now.
    let menuOpen = false;
    for (let attempt = 0; attempt < 2 && !menuOpen; attempt++) {
      if (attempt > 0) {
        await page.keyboard.press("Meta+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      }
      await el.pressSequentially(item.search, { delayMs: 60, timeoutMs: 8000 }).catch(() => {});
      await sleep(800);
      menuOpen = (await bounded.getByRole("option").count()) > 0;
    }
  }
  let option = null;
  // TRY EVERY ALTERNATIVE, IN ORDER (2026-10-05). A spec may carry an `options` array as well as `option`, because the
  // answer set lists several acceptable phrasings for one question - gender is the standing example, since tenants print
  // "Male" or "Man" and the rule cannot know which. InstaLILY's form offers only "Male" while the rule's first entry was
  // "Man", so the field reported "option not found" and stayed BLANK until it was set by hand. Only the first entry was
  // ever tried. The wanted list is therefore every candidate, in order.
  const wants = [item.option, ...(Array.isArray(item.options) ? item.options : [])].filter(Boolean);
  // AN OPTION THAT CANNOT BE CLICKED IS NOT AN OPTION. `getByRole("option")` matches BOTH the react-select
  // rows (`<div role="option">`) AND every native `<option>` in a `<select>` on the page, and a native option
  // is invisible by definition - its box belongs to the `<select>`. Selecting on `count() > 0` alone therefore
  // picked an invisible `<option>United States</option>` out of an unrelated native country select and then
  // timed out clicking it (`locator.click: Timeout 15000ms exceeded` ... `element is not visible`), which the
  // filler reports as an uncaught TimeoutError: the whole RUN aborts, and the loop's round exits 1 having
  // filled nothing. On the live board this was found on, the same expression resolved against the hidden
  // options of a phone country picker while the react-select it was aiming at was fine.
  //
  // A NATIVE `<select>` IS NOT AFFECTED: it never reaches this loop, because `choose()` handles it above with
  // `selectOption()`, which drives hidden options correctly.
  const visible = async (locator) => {
    if (await locator.count() === 0) return false;
    return await locator.first().isVisible().catch(() => false);
  };
  for (let i = 0; i < 12 && !option; i++) {
    await sleep(400);
    // For each candidate: exact -> prefix -> substring. Some tenants expose the full description as the
    // option text ("East Asian (inclusive of Chinese, Japanese, ...)"), so a prefix match on the configured
    // label is the reliable middle ground.
    for (const want of wants) {
      const patterns = [
        new RegExp("^" + esc(want) + "\\s*$"),
        new RegExp("^" + esc(want) + "(?:\\s|$)"),
        new RegExp(esc(want)),
      ];
      for (const pattern of patterns) {
        const opt = bounded.getByRole("option", { name: pattern });
        if (await visible(opt)) { option = opt; break; }
      }
      if (option) break;
    }
  }
  if (!option) {
    // Do NOT press Escape here: it would close the menu that the coordinate fallback needs.
    // Some react-selects ignore a DOM click on the option (the row is virtualized/overlaid):
    // fall back to a real mouse click at the option's coordinates before giving up.
    const byText = bounded.getByRole("option", { name: new RegExp(esc(item.option)) }).first();
    if (await visible(byText)) {
      const box = await byText.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        await sleep(150);
        await page.mouse.down().catch(() => {});
        await sleep(120);
        await page.mouse.up().catch(() => {});
        await sleep(600);
        if (committed(await selectedText(), item.option)) {
          return log.push({ ref: item.ref, kind: "select", ok: true, value: item.option, note: "mouse click" });
        }
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    return log.push({ ref: item.ref, kind: "select", ok: false, err: `option not found: ${item.option}` });
  }
  await option.first().click({ timeoutMs: 8000 });
  await sleep(400);
  // Verify the click actually committed; if the control still shows nothing, retry at coordinates.
  if (!committed(await selectedText(), item.option)) {
    const box = await option.first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await sleep(150);
      await page.mouse.down().catch(() => {});
      await sleep(120);
      await page.mouse.up().catch(() => {});
      await sleep(600);
    }
    if (!committed(await selectedText(), item.option)) {
      await page.keyboard.press("Escape").catch(() => {});
      return log.push({ ref: item.ref, kind: "select", ok: false, err: `option not committed: ${item.option}` });
    }
  }
  log.push({ ref: item.ref, kind: "select", ok: true, value: item.option });
}


/**
 * Choose a radio option by its LABEL TEXT inside the group the ref resolves to.
 *
 * Spec entries for radio groups are `{ref, option}`: the ref usually points at the shared group id (Ashby renders
 * every radio in a group with one id), so the option must be matched by text. Clicks follow the project's
 * visibility-and-verify rule: only visible labels, a real click, then read `checked` back and fall back to the
 * input's own click if the label click did not register (the Ashby proxy swallows some label clicks).
 */
async function chooseRadio(item) {
  const group = locator(item.ref);
  const n = await group.count();
  if (n === 0) return log.push({ ref: item.ref, kind: "radio", ok: false, err: "group not found" });
  const wanted = String(item.option || "").trim();
  for (let i = 0; i < n; i++) {
    const el = group.nth(i);
    const scope = el.locator("xpath=ancestor::*[self::fieldset or @data-field-path][1]");
    const root = (await scope.count()) ? scope.first() : el.locator("xpath=..");
    const labels = root.locator("label");
    const count = await labels.count();
    for (let k = 0; k < count; k++) {
      const label = labels.nth(k);
      const text = ((await label.innerText().catch(() => "")) || "").trim();
      if (!text || !text.toLowerCase().includes(wanted.toLowerCase())) continue;
      const box = await label.boundingBox().catch(() => null);
      if (!box || box.width < 2 || box.height < 2) continue;
      await label.scrollIntoViewIfNeeded().catch(() => {});
      const input = label.locator("input");
      const already = (await input.count()) ? await input.first().isChecked().catch(() => false) : false;
      if (!already) {
        await label.click({ timeoutMs: 8000, force: true }).catch(() => {});
        await sleep(250);
        const now = (await input.count()) ? await input.first().isChecked().catch(() => false) : true;
        if (!now && (await input.count())) await input.first().click({ timeoutMs: 8000, force: true }).catch(() => {});
      }
      await sleep(250);
      const final = (await input.count()) ? await input.first().isChecked().catch(() => false) : true;
      return log.push({ ref: item.ref, kind: "radio", option: text.slice(0, 60), ok: Boolean(final) });
    }
  }
  return log.push({ ref: item.ref, kind: "radio", ok: false, err: `option not found: ${wanted}` });
}

async function check(item) {
  const el = locator(item.ref);
  if (await el.count() === 0) return log.push({ ref: item.ref, kind: "check", ok: false, err: "not found" });
  const want = item.checked !== false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const isChecked = () => el.isChecked().catch(() => false);
  // Greenhouse renders its own checkbox proxy; a forced click on the hidden input does not always
  // reach React, so verify the state and fall back to clicking the wrapping label.
  await el.setChecked(want, { timeoutMs: 8000, force: true }).catch(() => {});
  await sleep(200);
  if (await isChecked() !== want) {
    const label = el.locator("xpath=ancestor::label[1]");
    if (await label.count() > 0) await label.first().click({ timeoutMs: 8000, force: true }).catch(() => {});
    else await el.click({ timeoutMs: 8000, force: true }).catch(() => {});
    await sleep(300);
  }
  // The DOM property can be right while React's model is still empty (the proxy swallowed the
  // click), which only shows up later as a stale "This field is required." on submit. A real
  // keyboard toggle on the focused input always dispatches through React, so force one round-trip
  // and leave the box in the wanted state.
  if ((await isChecked()) === want) {
    await el.focus().catch(() => {});
    await page.keyboard.press("Space").catch(() => {});
    await sleep(150);
    if ((await isChecked()) !== want) {
      await page.keyboard.press("Space").catch(() => {});
      await sleep(150);
    }
  }
  const ok = (await isChecked()) === want;
  log.push({ ref: item.ref, kind: "check", ok, value: want, err: ok ? undefined : "checkbox did not change state" });
}

/**
 * Fall back to a FILE INPUT matched by the ref's own name.
 *
 * Ashby does not always wrap the resume control in an aria group: on the Spur form it is `input#_systemfield_resume`
 * labelled "Resume", so a spec written as `group:Resume/CV` found nothing. A group ref is a LABEL here, not a DOM
 * promise, so when it does not resolve - or resolves to a container with no file input - the visible file input whose
 * label / help text / nearest question starts with the name (or with the name's first segment) is used instead. That
 * keeps one spec vocabulary working across both shapes instead of failing on a control that is plainly present.
 */
async function fileInputByLabel(name) {
  const rx = new RegExp("^" + esc(name), "i");
  const head = name.split("/")[0].trim();
  const rxHead = new RegExp("^" + esc(head), "i");
  const files = bounded.locator('input[type="file"]');
  const n = await files.count();
  for (let i = 0; i < n; i++) {
    const el = files.nth(i);
    const text = await el.evaluate((node) => {
      const parts = [];
      if (node.labels && node.labels[0]) parts.push(node.labels[0].innerText || "");
      let w = node;
      for (let k = 0; k < 6 && w; k++) { const t = (w.innerText || "").trim(); if (t) { parts.push(t); break; } w = w.parentElement; }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    if (rx.test(text) || rxHead.test(text)) return el;
  }
  return null;
}

/**
 * Find the "Attach" button that belongs to a field identified by its LABEL text.
 *
 * Greenhouse's newer board renders the resume field as a button, not an input, and the label sits in a sibling node rather
 * than wrapping the control. Walk up from the label until an ancestor contains an Attach button, then return that button.
 * Returns null when nothing matches, so the caller can still report a clean failure.
 */
async function attachButtonForLabel(labelText) {
  const want = String(labelText || "").trim().toLowerCase();
  const handle = await bounded.evaluateHandle((want) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const labels = [...document.querySelectorAll("label, .label, legend, div, span")]
      .filter((el) => clean(el.textContent).startsWith(want) && clean(el.textContent).length < want.length + 30);
    for (const el of labels) {
      let node = el;
      for (let i = 0; i < 5 && node; i++) {
        const btn = [...node.querySelectorAll("button, a, div[role=button]")]
          .find((b) => /^attach$/i.test((b.textContent || "").trim()));
        if (btn) return btn;
        node = node.parentElement;
      }
    }
    return null;
  }, want).catch(() => null);
  const el = handle && (await handle.asElement());
  return el || null;
}

async function upload(item) {
  let group = locator(item.ref);
  let count = await group.count();
  if (count) {
    // A resolved group must actually CONTAIN a file input, or it is the wrong node for an upload.
    const inner = group.first().locator('input[type="file"]');
    if (await inner.count()) group = inner;
    else {
      const selfIsFile = await group.first().evaluate(el => el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file").catch(() => false);
      if (!selfIsFile) { const fb = await fileInputByLabel(item.ref.replace(/^group:/, "")); if (fb) group = fb; else count = 0; }
    }
  } else if (item.ref.startsWith("group:")) {
    const fb = await fileInputByLabel(item.ref.slice(6));
    if (fb) { group = fb; count = 1; }
  }
  if (count === 0 || (await group.count()) === 0) {
    // FALLBACK: some Greenhouse boards render no file input for the resume at all - the field is an "Attach" button that
    // opens the platform file chooser. Resolve the field by its LABEL, then reuse the Attach+filechooser path below.
    if (item.ref.startsWith("group:")) {
      const label = item.ref.slice(6);
      const btn = await attachButtonForLabel(label);
      if (btn) {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 12000 }).catch(() => null);
        await btn.click({ timeoutMs: 8000 }).catch(() => {});
        const chooser = await chooserPromise;
        if (chooser) {
          await chooser.setFiles(item.path).catch(() => {});
          await sleep(2000);
          const name = item.path.split("/").pop();
          const shown = await bounded.evaluate((want) => (document.body.innerText || "").includes(String(want).slice(0, 40)), name).catch(() => false);
          return log.push({ ref: item.ref, kind: "file", ok: true, value: name, err: shown ? undefined : "attached via the Attach file chooser" });
        }
      }
    }
    return log.push({ ref: item.ref, kind: "file", ok: false, err: "group not found" });
  }
  // Ashby (and other tenants) expose a plain file input rather than Greenhouse's "Attach" button:
  // set the files on it directly.
  const isFileInput = await group.first().evaluate(el => el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file").catch(() => false);
  if (isFileInput) {
    const name = item.path.split("/").pop();
    let threw = null;
    await group.first().setInputFiles(item.path, { timeoutMs: 20000 }).catch(e => { threw = e.message; });
    await sleep(1800);
    // VERIFY THROUGH THE PAGE, NOT ONLY THROUGH el.files. Affirm removes the resume input once it has processed the
    // upload, so files.length read 0 and this reported FAIL on an upload that had in fact succeeded - a false negative
    // on the one check that exists to prove an upload. Accept any of three kinds of evidence: files still attached to
    // an input, the input gone from the DOM altogether, or the filename visible in the page's own text.
    const state = await bounded.evaluate((wantName) => {
      const inputs = [...document.querySelectorAll('input[type="file"]')];
      const attached = inputs.some(el => el.files && el.files.length > 0);
      const text = (document.body.innerText || "");
      return { attached, gone: inputs.length === 0, nameOnPage: !!wantName && text.includes(wantName.slice(0, 40)) };
    }, name).catch(() => ({ attached: false, gone: false, nameOnPage: false }));
    const ok = state.attached || state.nameOnPage || state.gone;
    const how = state.attached ? "files attached" : state.nameOnPage ? "filename shown on the page" : state.gone ? "input consumed by the page" : (threw || "no evidence of the upload");
    return log.push({ ref: item.ref, kind: "file", ok, value: name, err: ok ? undefined : `upload not evidenced: ${how}` });
  }
  const btn = group.getByRole("button", { name: "Attach", exact: true }).first();
  if (await btn.count() === 0) return log.push({ ref: item.ref, kind: "file", ok: false, err: "Attach button not found" });
  const chooserPromise = page.waitForEvent("filechooser");
  await btn.click({ timeoutMs: 8000 });
  const chooser = await chooserPromise;
  await chooser.setFiles(item.path);
  await sleep(1500);
  log.push({ ref: item.ref, kind: "file", ok: true, value: item.path.split("/").pop() });
}

async function removeFile(item) {
  const group = locator(item.ref);
  if (await group.count() === 0) return log.push({ ref: item.ref, kind: "remove", ok: false, err: "group not found" });
  const btn = group.getByRole("button", { name: /remove|delete/i }).first();
  if (await btn.count() === 0) return log.push({ ref: item.ref, kind: "remove", ok: false, err: "remove button not found" });
  await btn.click({ timeoutMs: 8000 });
  await sleep(900);
  log.push({ ref: item.ref, kind: "remove", ok: true });
}

if (!dryRun) {
  for (const item of spec.texts || []) await fillText(item);
  for (const item of spec.textareas || []) await fillText(item);
  // `selects` entries historically had to say "option"; writing "value" (as texts/checks do) crashed the
  // runner on Remesh, 2026-10-02, with "Cannot read properties of undefined (reading 'match')" because the
  // two spellings disagreed. Accept both so the mixed spelling cannot cost a cycle again.
  for (const item of spec.selects || []) await choose({ ...item, option: item.option ?? item.value });
  for (const item of spec.radios || []) await chooseRadio(item);
  for (const item of spec.checks || []) await check(item);
  for (const item of spec.files || []) await upload(item);
  for (const item of spec.removes || []) await removeFile(item);
  if (spec.order_after_texts) {
    for (const item of spec.order_after_texts.texts || []) await fillText(item);
    for (const item of spec.order_after_texts.selects || []) await choose({ ...item, option: item.option ?? item.value });
    for (const item of spec.order_after_texts.checks || []) await check(item);
  }
}

// ---- the refs the spec asked for, so the verification can name what it did NOT ask for
//
// A CONDITIONAL CONTROL CANNOT BE FOUND BY A SCAN TAKEN BEFORE THE FILL. On the Twitch form the user's diagnosis was
// exact: `Please identify your race` renders only after `Are you Hispanic/Latino?` is answered `No`. The blank form
// scanned 59 controls and no `id:race`; the answered form scans `id:race` with seven options. A drafter working from
// the first scan cannot emit what the scan could not see, so the second scan has to be the filler's, after it has
// answered what it was given.
const SPEC_REFS = new Set([
  ...(spec.texts || []), ...(spec.textareas || []), ...(spec.selects || []),
  ...(spec.checks || []), ...(spec.radios || []), ...(spec.files || []),
].map(i => String(i.ref || "").replace(/^id:/, "")).filter(Boolean));

// ---- verification: which labelled fields are still blank?
// Scroll the whole page first: sections that mount lazily (the standard EEO block especially) are
// invisible to a DOM read on an unscrolled page, which would hide a blank required field.
{
  const height = await bounded.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height + 1500; y += 700) {
    await bounded.evaluate(py => window.scrollTo(0, py), y);
    await sleep(160);
  }
  await bounded.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(600);
  await bounded.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
}
const report = await bounded.evaluate((specRefs) => {
  const SPEC_REFS = new Set(specRefs);
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const out = { blanks: [], files: [], submit: [], invalid: 0, unaddressed: [] };
  for (const el of [...document.querySelectorAll("input,textarea,select,[role=combobox]")].filter(vis)) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "file" || type === "hidden") continue;
    const id = el.id || "";
    const wrap = el.closest("[class*=question], fieldset, div[class*=field]") || el.parentElement?.parentElement || el.parentElement;
    let label = "";
    if (id) { const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (lb) label = clean(lb.innerText); }
    if (!label) label = clean(el.getAttribute("aria-label"));
    let value = "";
    if (wrap) {
      const sv = wrap.querySelectorAll("[class*=singleValue], [class*=multiValue], [class*=single-value]");
      if (sv.length) value = [...sv].map(n => clean(n.textContent)).filter(Boolean).join(" | ");
    }
    if (!value) {
      if (type === "checkbox" || type === "radio") value = el.checked ? "[checked]" : "[unchecked]";
      else if (["email", "tel", "password"].includes(type)) value = el.value ? "[masked]" : "";
      else value = clean(el.value);
    }
    if (el.getAttribute("aria-invalid") === "true") out.invalid += 1;
    // A CONTROL THE SPEC NEVER MENTIONED. Set on the page by construction before this runs; see the loop below.
    if (id && !SPEC_REFS.has(id)) out.unaddressed = [...(out.unaddressed || []), { id, label: label.slice(0, 80) }];
    const placeholder = /^(select\.\.\.|select|choose|--)$/i.test(value);
    if (!value || placeholder) out.blanks.push({ id, label: label.slice(0, 80), required: el.required || el.getAttribute("aria-required") === "true" });
  }
  out.files = [...document.querySelectorAll("*")].filter(el => el.children.length === 0 && vis(el) && /\.(pdf|docx?)$/i.test(clean(el.textContent))).map(el => clean(el.textContent));
  out.submit = [...document.querySelectorAll("button,input[type=submit]")].filter(vis).map(b => clean(b.innerText || b.value)).filter(t => /submit/i.test(t));
  return out;
}, [...SPEC_REFS]);

console.log("\n=== fill log ===");
for (const l of log) console.log(`  ${l.ok ? "OK  " : "FAIL"} ${l.kind.padEnd(7)} ${l.ref.padEnd(34)} ${l.value ?? l.err ?? ""}${l.note ? `  [${l.note}]` : ""}`);
console.log("\n=== still blank ===", report.blanks.length);
for (const b of report.blanks) console.log(`  ${b.required ? "REQ" : "opt"} ${b.id.padEnd(26)} ${b.label}`);
if (report.unaddressed && report.unaddressed.length) {
  // These are NOT failures of the spec. They are questions that the fill itself brought onto the page - the EEO
  // cascade is the common one - and they need a second scan and a second draft, which is what the line below names.
  //
  // AND THE RUN STILL EXITS 0, which the comment here used to deny: it said the second scan and draft were "what the
  // exit line says", while the exit line was - and is - an unconditional `process.exit(0)`. That is deliberate rather
  // than an oversight, for two reasons. This tool is a FILLER: it reports what it wrote and what it left, and the
  // judgement belongs to `verify_and_submit.mjs`, where the expectations that refuse the submit click live. And an
  // exit code here would be read by a caller that cannot use it - `refill_until_stable.mjs` treats any non-zero exit
  // from this tool as "THE FILL FAILED ... Nothing on the page was changed" and stops the loop, which is the exact
  // opposite of a control the fill itself revealed. A `FAIL` line for a missing ref, a blank required field or an
  // unmentioned control is a reading for the person and the gate, not a status for `$?`.
  //
  // PINNED, NOT ASSUMED: `src/forms/test_fill_roundtrip.mjs` asserts exit 0 on a form whose fill revealed a control
  // the spec never mentioned ("the filler must still exit clean"), which is what makes the exit code a decision
  // rather than an unfinished edge.
  console.log("\n=== controls the spec never mentioned (re-scan and re-draft) ===",
              report.unaddressed.length);
  for (const u of report.unaddressed) console.log(`  ?   ${u.id.padEnd(26)} ${u.label}`);
}
console.log("=== attached ===", report.files);
console.log("=== aria-invalid ===", report.invalid);
console.log("=== submit control (never pressed) ===", report.submit);
process.exit(0);
