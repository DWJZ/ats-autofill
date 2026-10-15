/**
 * verify_and_submit.mjs — a GENERIC verification gate that submits only if every expectation holds.
 *
 * Why this exists as a tool: on 2026-10-03 the ad-hoc gate written by hand for two applications stopped three separate bad
 * submissions - one where a shell pipeline had swallowed the gate's exit code, one where a suggestion row turned out to be a
 * container and committed "California, Pennsylvania, United States" instead of Springfield, and one where a required field was
 * missing. A gate that only exists in a one-off script protects one form. This makes it reusable, so "filled-looking" can never
 * again be mistaken for "correct".
 *
 * Usage:
 *   node src/forms/verify_and_submit.mjs <target> <slug> --company <Name> --expect '<json array>' [--cdp <url>] [--dry-run]
 *
 * <target>  a string that appears in the form tab URL (for example a posting token)
 * <slug>    the bundle/profile slug handed to the settle submit tool
 *
 * Supported expectations (each is an object with "kind"):
 *   {"kind":"valueIs","value":"Example Candidate"}                  some input/textarea has exactly this value
 *   {"kind":"valueMatch","re":"linkedin\\.com/in/"}          some input/textarea value matches this regex
 *   {"kind":"valueCount","re":"...","min":2}                at least min values match the regex
 *   {"kind":"noEmptyRequired","ids":["_systemfield_name"]}  listed ids exist and are non-empty (a react-select counts
 *                                                          as filled once its committed option is displayed)
 *   {"kind":"pairYes","questionRe":"legally authorized"}    a Yes/No pair whose question matches reads checked
 *   {"kind":"pairNo","questionRe":"current prompt"}         ... reads unchecked
 *   {"kind":"radioGroupsChecked","min":3}                   at least min radio groups have a selection
 *   {"kind":"essays","min":2,"chars":300}                   at least min textareas hold >= chars characters
 *
 * Exit codes: 0 = all expectations held AND the submit tool reported confirmed true; 7 = an expectation failed (nothing was
 * submitted); 8 = expectations held but the submit tool failed; 2 = the form tab was not found.
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// THE VALUE RULE IS IMPORTED, NOT RE-DERIVED. The audit (`audit_form_fields.mjs`) reads a control's displayed
// value with it; so does this gate. It used to have a rule of its own, and the two disagreed in the direction that
// reaches an employer - see the block that reads `byId` below.
import { CONTROL_VALUE_SOURCE } from "./control_value.mjs";
// The standing table is configuration, located through the one definition of `ATS_DATA_DIR` (`src/paths.mjs`)
// rather than by a path relative to the working directory.
import { DATA_DIR } from "../paths.mjs";
// Telemetry must never break a submission: see submit_with_verification_code.mjs.
const { recordLedger, BLOCKED } = await import("./_ledger.mjs")
  .catch(() => ({ recordLedger: () => null, BLOCKED: "blocked" }));

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const target = positional[0];
const slug = positional[1];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

if (!target || !slug) {
  console.error("usage: verify_and_submit.mjs <target> <slug> --company <Name> --expect '<json>' [--cdp url] [--dry-run]");
  process.exit(1);
}
const company = flag("company", "");
const cdp = flag("cdp", "http://127.0.0.1:9223");
const allowUnruled = argv.includes("--allow-unruled");
const dryRun = has("dry-run");

// Acknowledged standing-table exceptions. Repeatable: --ack-pair "regex". A mismatch whose question matches one of these is
// printed as a loud warning instead of failing the run, so the SERVER can arbitrate. Nothing is silently ignored.
const ackPairs = (() => {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--ack-pair" && argv[i + 1]) out.push(argv[i + 1]);
  return out;
})();
let expect = [];
try {
  expect = JSON.parse(flag("expect", "[]"));
} catch (e) {
  console.error("--expect must be a JSON array:", String(e).slice(0, 120));
  process.exit(1);
}
if (!Array.isArray(expect) || expect.length === 0) {
  console.error("refusing to run with no expectations: an empty gate is not a gate");
  process.exit(1);
}

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => (p.url() || "").includes(target));
if (!page) {
  console.error(`no form tab matching ${target}`);
  process.exit(2);
}

const snapshot = await page.evaluate((controlValueSource) => {
  // A FILE INPUT'S `.value` IS NOT THE FILE'S NAME. The browser never exposes a selected file through `input.value` -
  // it is "" or a `C:\fakepath\...` string - so an expectation of the form {"kind":"valueMatch","re":"Resume\\.pdf"}
  // CAN NEVER PASS, whatever is attached. This was asserted twice by mistake on 2026-10-05 before anyone noticed that
  // the failing expectation was unsatisfiable rather than the upload broken. Check an attachment by the FILENAME
  // VISIBLE ON THE PAGE (`ats-greenhouse.md` says the same for a silent upload), never through `values`.
  const values = [...document.querySelectorAll("input,textarea")].map((e) => e.value || "");
  // ══ WHAT EACH CONTROL DISPLAYS, BY THE ONE RULE THAT READS IT ═══════════════════════════════════════════════
  //
  // WHY THIS READS THE WAY IT DOES. This block used to walk up to five ancestors of every element that had an id,
  // looking for `[class*=single-value]`, and take the first value it found. That is "a container may answer for a
  // control inside it", which is exactly what a composite widget breaks (the rule and its cases are in
  // `control_value.mjs`; greenhouse's board, posting 8279799, 2026-10-14, is where they were observed):
  //
  //     <fieldset class="phone-input">                    <- ONE fieldset, TWO controls
  //       <div class="phone-input__country"> … <div class="select__single-value">+1</div> …   <- Country*, answered
  //       <div class="phone-input__phone"> … <input id="phone" type="tel" required> …          <- Phone*, EMPTY
  //
  // An empty required phone sits beside an answered country, and a read that climbs out of the phone finds the
  // COUNTRY's value node (`+1`) and reports the phone as answered - so `noEmptyRequired` passes a blank field the
  // employer required and the submission goes out without it. Reading each control's OWN display container is the
  // fix; the suspicion is not turned up, the wrong element is simply not read any more.
  //
  // The same walk invented ids that are not controls at all: a question's `label`, its `fieldset` and its wrapper
  // `div`s each acquired a `byId` entry holding a NEIGHBOUR's value, because the value was looked for in an
  // ancestor of an element that has no value of its own. `byId` is now built from controls and from nothing else.
  //
  // And it still reads a react-select, which is why it cannot simply take `input.value`: a committed option renders
  // in a `[class*=single-value]` node while the input holds the typed query or nothing at all. On 2026-10-07 that
  // made a completely filled Verse form read as "id candidate-location is empty" and the gate refused it; that
  // failure, the composite above and the fragment `+1` (the country's option is `Canada +1`, and the audit resolves
  // it out of the widget's own mounted country list) are ONE rule, and it is the audit's.
  const rule = eval(controlValueSource);
  const byId = {};
  // `select` belongs here because the audit scans it and reads a native select's own value; without it such an id
  // read "not present", which refuses a field that is filled.
  for (const el of document.querySelectorAll("input,textarea,select")) {
    if (!el.id) continue;
    byId[el.id] = rule.read(el).displayed;
  }
  // Yes/No pairs: Ashby draws these either as ONE checkbox whose question sits in an ancestor, or as a RADIO group with
  // exactly two options. Reading only checkboxes made this gate report false failures on the Virta form, where the
  // authorization and sponsorship pairs are radios - press_all_pairs had answered them correctly and the gate could not see
  // them. Anything wider than two options is an EEO or multi-choice question, not a pair.
  const pairs = [];
  const seen = new Set();
  const candidates = [
    ...[...document.querySelectorAll("input[type=checkbox]")].map((e) => ({ el: e, kind: "checkbox" })),
    ...[...document.querySelectorAll("input[type=radio]")].map((e) => ({ el: e, kind: "radio" })),
  ];
  for (const { el: e, kind } of candidates) {
    const name = e.name || "";
    if (seen.has(kind + name)) continue;
    seen.add(kind + name);
    if (kind === "radio" && document.querySelectorAll(`input[name="${CSS.escape(name)}"]`).length !== 2) continue;
    let w = e;
    let q = "";
    for (let i = 0; i < 12 && w; i++) {
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (t && t.length > 16 && !/^(Yes\s*No|Yes|No)$/i.test(t)) { q = t; break; }
      w = w.parentElement;
    }
    const checkedGroup = kind === "radio"
      ? [...document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)]
      : [];
    const selected = checkedGroup.find((x) => x.checked) || null;
    // For a radio pair, record WHICH option is selected. Knowing only that "some option is checked" cannot tell Yes from No,
    // and produced a false pairNo failure on the Virta familial question even though No was correctly selected.
    // LABEL LENGTH WAS THE REAL BLOCKER (fixed 2026-10-03). This walk required an ancestor's text to be UNDER 30
    // characters, so a tenant that words its options as sentences - ClickUp's "Yes, I will need sponsorship for a work visa." is 45 -
    // yielded no label at all and every such pair read as unanswered. The gate refused a complete ClickUp form for this reason alone.
    // Now the input's OWN label association is tried first (which is the browser's own answer), and the ancestor walk accepts a
    // sentence-length label up to 120 characters.
    let selectedLabel = "";
    if (selected) {
      if (selected.id) {
        const own = document.querySelector(`label[for="${CSS.escape(selected.id)}"]`);
        if (own) selectedLabel = (own.innerText || "").replace(/\s+/g, " ").trim();
      }
      if (!selectedLabel) {
        let p2 = selected.parentElement;
        for (let k = 0; k < 4 && p2; k++) {
          const t = (p2.innerText || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 120) { selectedLabel = t; break; }
          p2 = p2.parentElement;
        }
      }
      // the option's leading word is what classifies it, so trim a sentence label to its first clause for the yes/no test
      if (selectedLabel.length > 30) selectedLabel = selectedLabel.slice(0, 30);
    }
    // ACCEPT A SENTENCE-LENGTH OPTION LABEL (fixed 2026-10-03). Some tenants word the options as full sentences -
    // ClickUp asks "Yes, I will need sponsorship for a work visa." / "No, I will not need sponsorship for a work visa." - and a
    // strict /^yes$/ test then reported a correctly chosen Yes as unanswered. ClickUp's gate kept refusing a complete form for this
    // reason alone. Match the option's LEADING word instead, which is what the rendered label always starts with.
    const checked = kind === "radio"
      ? (selectedLabel ? /^yes\b/i.test(selectedLabel) : false)
      : e.checked;
    // Disclose the ids of the inputs that make up this pair. On Fieldguide the gate could READ a mismatched pair while every pressing
    // tool failed to LOCATE it - press_all_pairs reported success wrongly, scan_button_pairs looks only for checkboxes, set_radio
    // reported group not found, and a hand-written container walk returned null. The gate already enumerates these inputs, so it now
    // prints their ids and the next call can press exactly those ids with click_radio_plan.mjs instead of walking the DOM again.
    const ids = kind === "radio"
      ? checkedGroup.map((x) => x.id).filter(Boolean)
      : [e.id].filter(Boolean);
        // MULTI-SELECT GUARD (2026-10-03). A question rendered as a CHECKBOX LIST is not a yes/no pair: on Fluidstack the source
    // question "How did you hear about this job opportunity?" offers six checkboxes, and treating each as a pair made the standing
    // table rule for how-did-you-hear demand that all six read YES - six false failures on a form that was otherwise complete. A
    // checkbox whose name is shared by more than two inputs is a multi-select, so it is recorded (for visibility) but NOT enforced.
    // MULTI-SELECT GUARD (2026-10-03). A question rendered as a CHECKBOX LIST is not a yes/no pair: on Fluidstack the source
    // question "How did you hear about this job opportunity? You can select more than one option" offers six checkboxes with six
    // DIFFERENT name attributes, and treating each as a pair made the standing-table rule for how-did-you-hear demand that all six
    // read YES - six false failures on an otherwise complete form. Two wording-independent tests catch this class: the question
    // literally says it accepts more than one answer, or several distinct checkbox names share that same question text. Skip those,
    // because a table rule about a yes/no question cannot meaningfully apply to a multi-select.
    if (kind === "checkbox") {
      const sameName = [...document.querySelectorAll(`input[type=checkbox][name="${CSS.escape(name)}"]`)];
      if (sameName.length > 2) continue;
      if (/select (more than one|all that apply|multiple)|choose all|check all/i.test(q)) continue;
      const distinctNames = new Set(
        [...document.querySelectorAll("input[type=checkbox]")]
          .filter((x) => {
            let w = x, qt = "";
            for (let i = 0; i < 16 && w; i++) { const t = (w.innerText || "").replace(/\s+/g, " ").trim(); if (t && t.length > 14) { qt = t; break; } w = w.parentElement; }
            return qt === q;
          })
          .map((x) => x.name || x.id)
      );
      if (distinctNames.size > 2) continue;
    }
    pairs.push({ question: q, checked, selectedLabel, kind, ids });
  }
  // BUTTON-RENDERED YES/NO PAIRS (added 2026-10-03). Some tenants - Fluidstack among them - render a yes/no question as two BUTTON
  // elements whose state lives in aria-pressed / aria-checked rather than in any input. The enumeration above sees nothing for those
  // questions, so the gate could never confirm them and refused to submit a form that answer_by_question_text had already pressed
  // correctly. This second pass adds them to the same standing-table review. It only fires on a container holding exactly two buttons
  // whose own text is Yes and No, which is what a rendered pair looks like.
  const buttonPairsSeen = new Set();
  for (const btn of document.querySelectorAll("button, [role=radio], [role=checkbox]")) {
    const own = (btn.innerText || "").trim();
    if (!/^(Yes|No)$/i.test(own)) continue;
    let w = btn, q = "", container = null;
    for (let i = 0; i < 12 && w; i++) {
      const btns = [...(w.querySelectorAll ? w.querySelectorAll("button, [role=radio], [role=checkbox]") : [])]
        .filter((b) => /^(Yes|No)$/i.test((b.innerText || "").trim()));
      if (btns.length === 2) { container = w; break; }
      w = w.parentElement;
    }
    if (!container) continue;
    for (let i = 0; i < 12 && w; i++) {
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (t && t.length > 16 && !/^(Yes\s*No|Yes|No)$/i.test(t)) { q = t; break; }
      w = w.parentElement;
    }
    if (!q || buttonPairsSeen.has(q)) continue;
    buttonPairsSeen.add(q);
    const btns = [...container.querySelectorAll("button, [role=radio], [role=checkbox]")]
      .filter((b) => /^(Yes|No)$/i.test((b.innerText || "").trim()));
    const isOn = (b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true"
      || /(^|\s)(selected|active|checked)(\s|$)/i.test(b.className || "");
    const yesOn = btns.some((b) => /^Yes$/i.test((b.innerText || "").trim()) && isOn(b));
    const noOn = btns.some((b) => /^No$/i.test((b.innerText || "").trim()) && isOn(b));
    pairs.push({
      question: q, checked: yesOn, selectedLabel: yesOn ? "Yes" : (noOn ? "No" : ""), kind: "button",
      ids: btns.map((b) => b.getAttribute("aria-labelledby") || b.id || "").filter(Boolean),
      buttonRendered: true,
    });
  }
  // RADIO GROUPS BY OPTION LABEL (added 2026-10-03). Sierra renders "Are you able to work from a Sierra office?" as a radio pair whose
  // options are FULL SENTENCES and whose question text is not reachable by an ancestor walk, so the enumeration above never saw it and
  // the gate reported "no pair matched" instead of disclosing ids - the same blindness Fluidstack's button pairs caused. This pass finds
  // a radio group through the LABELS of its options: if two options' own labels share a long common tail, that tail is the question.
  const radioByName = {};
  for (const e of document.querySelectorAll("input[type=radio]")) {
    const nm = e.name || "";
    if (!nm) continue;
    (radioByName[nm] = radioByName[nm] || []).push(e);
  }
  for (const [nm, els] of Object.entries(radioByName)) {
    if (els.length !== 2) continue;
    const labelOf = (e) => {
      let lab = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
      if (!lab) lab = e.closest("label") || e.parentElement;
      return (lab && lab.innerText ? lab.innerText : "").replace(/\s+/g, " ").trim();
    };
    const labels = els.map(labelOf);
    if (labels.some((l) => !l)) continue;
    let q = "";
    for (let i = 0; i < 20; i++) {
      let w = els[0], found = "";
      for (let k = 0; k < i && w; k++) w = w.parentElement;
      if (!w) break;
      const txt = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (txt && txt.length > 12 && txt.length < 320 && !/^(Yes\s*No|Yes|No)$/i.test(txt)) { found = txt; }
      if (found && found.length > 20) { q = found; break; }
    }
    if (!q) q = labels[0].slice(0, 120);
    if (pairs.some((p) => p && p.question && p.question.slice(0, 40) === q.slice(0, 40))) continue;
    const selected = els.find((e) => e.checked) || null;
    const selLabel = selected ? labelOf(selected) : "";
    pairs.push({
      question: q, checked: /^yes\b/i.test(selLabel), selectedLabel: selLabel, kind: "radio",
      ids: els.map((e) => e.id).filter(Boolean), optionLabelled: true,
    });
  }
  // A QUESTION WHOSE YES SIDE IS A BUTTON (added 2026-10-03). Sierra renders "Are you able to work from a Sierra office?" with only ONE
  // radio - "No, I am not able to work from a Sierra office." - and the affirmative option is a BUTTON beside it. Every earlier pass
  // missed it: the input enumeration sees one radio with no pair, the option-label pass requires two same-named radios, and the
  // button-pair pass requires two buttons reading Yes and No. This pass handles the mixed case, and it reports the button's own TEXT as
  // well as its id, because these buttons often carry no id at all.
  for (const e of document.querySelectorAll("input[type=radio]")) {
    const labelOf = (x) => {
      let lab = x.id ? document.querySelector(`label[for="${CSS.escape(x.id)}"]`) : null;
      if (!lab) lab = x.closest("label") || x.parentElement;
      return (lab && lab.innerText ? lab.innerText : "").replace(/\s+/g, " ").trim();
    };
    const own = labelOf(e);
    if (!own || own.length < 12) continue;
    if (document.querySelectorAll(`input[name="${CSS.escape(e.name || "-")}"]`).length !== 1) continue;
    let box = e, yesBtn = null;
    for (let i = 0; i < 6 && box && !yesBtn; i++) {
      yesBtn = [...(box.querySelectorAll ? box.querySelectorAll("button") : [])]
        .find((b) => /^yes\b/i.test((b.innerText || "").trim()));
      box = box.parentElement;
    }
    if (!yesBtn) continue;
    let q = own;
    let w = e;
    for (let i = 0; i < 20 && w; i++) {
      const cand = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (cand.length > 20 && cand.length < 320 && !/^No, I am not able to/i.test(cand)) { q = cand; break; }
      w = w.parentElement;
    }
    // Sierra's option groups render the SELECTED option as a class token that is literally "true" - no aria attribute at all -
    // so the class test must accept that token too (added 2026-10-03 after dumping the real DOM).
    const yesOn = yesBtn.getAttribute("aria-pressed") === "true" || yesBtn.getAttribute("aria-checked") === "true"
      || /(^|\s)(selected|active|checked|true)(\s|$)/i.test(yesBtn.className || "");
    if (pairs.some((x) => x && x.question && x.question.slice(0, 40) === q.slice(0, 40))) continue;
    pairs.push({
      question: q, checked: yesOn || e.checked === false && yesOn, selectedLabel: yesOn ? "Yes" : (e.checked ? own : ""),
      kind: "radio", ids: [yesBtn.id, e.id].filter(Boolean), mixedButtonPair: true, yesButtonText: (yesBtn.innerText || "").trim().slice(0, 60),
    });
  }
  const radioGroups = {};
  for (const e of document.querySelectorAll("input[type=radio]")) {
    const nm = e.name || "-";
    radioGroups[nm] = radioGroups[nm] || false;
    if (e.checked) radioGroups[nm] = true;
  }
  // LONG-FORM ANSWERS MAY BE <input>, NOT <textarea> (2026-10-05). On Scale AI's Greenhouse embed the two prose
  // questions render as inputs holding 255 characters each, so a textarea-only reader reported "essays: 0" and refused
  // a form that was filled. Long answers are counted from BOTH elements; short inputs stay excluded by the caller's
  // character threshold.
  const essays = [...document.querySelectorAll("textarea, input[type=text], input:not([type])")]
    .filter((e) => e.offsetParent !== null && !(e.className || "").toString().includes("select__input"))
    .map((e) => (e.value || "").length);
  // react-select style controls commit into a DISPLAY element, not into input.value: on Kapitus every correctly chosen
  // custom field read as an empty input, which made a value-only verification report false failures. These are the values
  // the page actually shows for such fields.
  const displays = [...document.querySelectorAll("[class*=single-value], [class*=singleValue]")]
    .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // DROP MULTI-OPTION CHECKBOX GROUPS FROM THE PAIR LIST (2026-10-05). Commure's "How did you hear about us?" renders as
  // a CHECKBOX GROUP with nine options, and the pair passes below read the single ticked box as a yes/no answer - so the
  // standing table (which expects an OPTION for that question) reported a MISMATCH and the gate refused a form whose
  // answer was in fact correct. A question served by a group of checkboxes with more than two DISTINCT option labels is
  // a multiple-choice question, not a yes/no pair, and must not be enforced against the boolean table.
  const checkboxGroups = new Map();
  for (const e of document.querySelectorAll("input[type=checkbox]")) {
    let w = e, q = "";
    for (let k = 0; k < 9 && w; k++) {
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 25) { q = t; break; }
      w = w.parentElement;
    }
    if (!q) continue;
    const key = q.slice(0, 60);
    if (!checkboxGroups.has(key)) checkboxGroups.set(key, new Set());
    const lab = e.labels && e.labels[0] ? (e.labels[0].innerText || "").trim() : "";
    if (lab) checkboxGroups.get(key).add(lab);
  }
  const multiOptionQuestions = new Set(
    [...checkboxGroups.entries()].filter(([, labs]) => labs.size >= 3).map(([q]) => q.slice(0, 40))
  );
  // AN OPTION ROW IS NOT A QUESTION (2026-10-05). Mercor's office-preference checkboxes are reported with the OPTION
  // LABEL as their question ("San Francisco HQ - 181 Fremont Street", "New York City - 1 World Trade"), and the pair
  // review blocked on the unselected one - refusing a form whose answer was correct, because choosing one office out of
  // several IS the answer. The earlier multi-option filter keys a group on the question text and could not see this: each
  // control claims a different "question". A control whose question text equals its own visible label is an option row.
  const optionLabelTexts = new Set();
  for (const e of document.querySelectorAll("input[type=checkbox], input[type=radio]")) {
    const lab = e.labels && e.labels[0] ? (e.labels[0].innerText || "").replace(/\s+/g, " ").trim().toLowerCase() : "";
    if (lab) optionLabelTexts.add(lab);
  }
  const isOptionRow = (pr) => {
    if (!pr || !pr.question) return false;
    return optionLabelTexts.has(pr.question.replace(/\s+/g, " ").trim().toLowerCase());
  };
  const pairsKept = pairs.filter((pr) => !pr || !pr.question ||
    (!multiOptionQuestions.has(pr.question.slice(0, 40)) && !isOptionRow(pr)));
  const droppedOptionRows = pairs.length - pairsKept.length - (pairs.length - pairs.filter((pr) => !pr || !pr.question || !multiOptionQuestions.has(pr.question.slice(0, 40))).length);
  const droppedPairs = pairs.length - pairsKept.length;

  return { values, byId, pairs: pairsKept, droppedPairs, radioGroupsChecked: Object.values(radioGroups).filter(Boolean).length, essays, displays };
}, CONTROL_VALUE_SOURCE);

const failures = [];
const warnings = [];
for (const e of expect) {
  switch (e.kind) {
    case "valueIs":
      if (!snapshot.values.includes(e.value)) failures.push(`valueIs ${JSON.stringify(e.value)} not found`);
      break;
    case "valueMatch": {
      const re = new RegExp(e.re, "i");
      if (!snapshot.values.some((v) => re.test(v))) failures.push(`valueMatch ${e.re} matched nothing`);
      break;
    }
    case "valueCount": {
      const re = new RegExp(e.re, "i");
      const n = snapshot.values.filter((v) => re.test(v)).length;
      if (n < (e.min || 1)) failures.push(`valueCount ${e.re}: ${n} < ${e.min || 1}`);
      break;
    }
    case "noEmptyRequired":
      for (const id of e.ids || []) {
        if (!(id in snapshot.byId)) failures.push(`noEmptyRequired: id ${id} not present`);
        else if (!String(snapshot.byId[id]).trim()) failures.push(`noEmptyRequired: id ${id} is empty`);
      }
      break;
    case "pairYes":
    case "pairNo": {
      const re = new RegExp(e.questionRe, "i");
      const hit = snapshot.pairs.find((p) => re.test(p.question));
      if (!hit) failures.push(`${e.kind}: no pair matched ${e.questionRe}`);
      else if (hit.checked !== (e.kind === "pairYes")) {
        const line = `${e.kind}: ${JSON.stringify(hit.question.slice(0, 60))} reads ${hit.checked ? "YES" : "no"}`;
        const acked = ackPairs.some((p) => { try { return new RegExp(p, "i").test(hit.question); } catch { return false; } });
        if (acked) warnings.push(`ACKNOWLEDGED standing-table exception (the server will arbitrate): ${line}`);
        else failures.push(line);
      }
      break;
    }
    case "displayMatch": {
      // for react-select style fields, whose committed value lives in a display element rather than in input.value
      const re = new RegExp(e.re, "i");
      if (!snapshot.displays.some((d) => re.test(d))) failures.push(`displayMatch ${e.re} matched no displayed value`);
      break;
    }
    case "displayCount": {
      const re = new RegExp(e.re, "i");
      const n = snapshot.displays.filter((d) => re.test(d)).length;
      if (n < (e.min || 1)) failures.push(`displayCount ${e.re}: ${n} < ${e.min || 1}`);
      break;
    }
    case "radioGroupsChecked":
      if (snapshot.radioGroupsChecked < (e.min || 1)) failures.push(`radioGroupsChecked: ${snapshot.radioGroupsChecked} < ${e.min || 1}`);
      break;
    case "essays": {
      const n = snapshot.essays.filter((c) => c >= (e.chars || 1)).length;
      if (n < (e.min || 1)) failures.push(`essays: ${n} >= ${e.chars || 1} chars, wanted ${e.min || 1}`);
      break;
    }
    default:
      failures.push(`unknown expectation kind ${JSON.stringify(e.kind)}`);
  }
}

// THE PRE-SUBMIT REVIEW, ENFORCED. The user has twice asked for a check before submitting, and on 2026-10-03 the Prompt
// application went out with "Are you legally authorized to work in the US" reading NO because a forced press had toggled it and
// the submit ran anyway. Remembering to check is not a mechanism. So the standing answer table is now applied as hard
// expectations: for every rule in data/form_specs/ashby_pairs_standing.json whose question matches a pair on THIS page, the
// pair's state must equal the table's answer, or nothing is submitted. Every pair on the page is also printed with its state,
// rule or no rule, so the review happens in front of the operator rather than in their memory.
let tableRules = [];
try {
  tableRules = JSON.parse(readFileSync(join(DATA_DIR, "form_specs", "ashby_pairs_standing.json"), "utf8")).rules || [];
} catch (e) {
  console.log(`WARN could not read the standing answer table: ${String(e).slice(0, 90)}`);
}
console.log("PRE-SUBMIT PAIR REVIEW:");
if (snapshot.droppedPairs) console.log(`   (${snapshot.droppedPairs} multiple-choice question(s) skipped: a checkbox group with 3+ options is not a yes/no pair)`);
if (!snapshot.pairs.length) console.log("   (no yes/no pairs found on this page)");
let enforced = 0;
const unruledUnanswered = [];
for (const p of snapshot.pairs) {
  const rule = tableRules.find((r) => new RegExp(r.questionRe, "i").test(p.question));
  const state = p.checked ? "YES" : "no";
  if (!rule) {
    // AN UNRULED PAIR IS ONLY SAFE WHEN IT IS ALREADY YES. An unruled pair sitting at "no" is an UNDECIDED question,
    // and undecided questions are how four wrong answers reached Hello Patient on 2026-10-05 (relocation, in-office
    // days, startup experience, a 50-hour week - all defaulted to no). Such a pair now FAILS the gate unless
    // --allow-unruled is passed deliberately.
    console.log(`   ${state.padEnd(3)} | ${p.question.slice(0, 78)}   [no rule${p.checked ? "" : " - UNANSWERED, this blocks the gate"}]`);
    if (!p.checked) unruledUnanswered.push(p.question);
    continue;
  }
  enforced++;
  // CASE-INSENSITIVE: rules spell the answer both "yes" and "Yes" - a strict === made "Yes" mean false and the
  // gate refused correctly answered forms, reporting the self-contradictory "reads YES, the table says YES".
  const want = String(rule.answer || "").trim().toLowerCase() === "yes";
  const okMark = p.checked === want ? "ok" : "MISMATCH";
  console.log(`   ${state.padEnd(3)} | ${p.question.slice(0, 78)}   [table says ${rule.answer.toUpperCase()} -> ${okMark}]`);
  if (p.checked !== want) {
    {
        const _line = `standing-table: ${JSON.stringify(p.question.slice(0, 60))} reads ${state}, the table says ${rule.answer.toUpperCase()}`;
        const _acked = ackPairs.some((p) => { try { return new RegExp(p, "i").test(_line); } catch { return false; } });
        if (_acked) warnings.push(`ACKNOWLEDGED standing-table exception (the server will arbitrate): ${_line}`);
        else failures.push(_line);
      }
    // print the exact inputs so the next call can press them by id instead of re-walking the DOM
    console.log(`        PRESS THESE IDS (${p.kind}):`);
    for (const id of p.ids || []) console.log(`          ${id}`);
    if (p.yesButtonText) console.log(`        OR PRESS THE BUTTON READING: ${p.yesButtonText}`);
  }
}
console.log(`   (${enforced} pair(s) checked against the standing table)`);

// AN UNRULED PAIR LEFT AT "no" IS AN UNDECIDED QUESTION, AND UNDECIDED QUESTIONS SHIP WRONG ANSWERS.
// On 2026-10-05 a Hello Patient application went out with four of them (relocation, in-office days, startup experience,
// a 50-hour week) because the pair review printed "no rule - decide by hand" and passed. Deciding by hand is exactly
// what did not happen. The gate now refuses, and the remedy is either to set the pair correctly on the page or to add
// the question to the standing table - both of which make the answer deliberate. A pair already answered YES is fine:
// it is not an unanswered question, and the table exists to catch wrong answers rather than to require paperwork.
if (unruledUnanswered.length && !allowUnruled) {
  console.log(`GATE FAILED - ${unruledUnanswered.length} yes/no pair(s) have NO RULE and are UNANSWERED - NOT SUBMITTING`);
  for (const q of unruledUnanswered.slice(0, 6)) console.log(`   x undecided: ${q.slice(0, 76)}`);
  console.log("   remedy: answer the pair on the page, or add it to data/form_specs/ashby_pairs_standing.json");
  console.log("   override (only with a deliberate reason): --allow-unruled");
  recordLedger(BLOCKED, {
    slug, url: target, outcome: "gate_refused_unruled_pairs",
    detail: { questions: unruledUnanswered.slice(0, 6), expectations: expect.length },
  });
  process.exit(7);
}

if (failures.length) {
  console.log("GATE FAILED - NOT SUBMITTING");
  warnings.forEach((w) => console.log(`   ! ${w}`));
  failures.forEach((f) => console.log("   x " + f));
  // A refused gate is a BLOCKED attempt, not a handover: it stops a submit that has not happened yet, and
  // the agent normally corrects the form and retries. Five of the first six gate refusals went on to
  // submit successfully, which is why recording them as handovers was wrong.
  recordLedger(BLOCKED, {
    slug, url: target, outcome: "gate_refused",
    detail: { failures: failures.slice(0, 5), expectations: expect.length },
  });
  process.exit(7);
}
console.log(`GATE PASSED (${expect.length} expectation(s))`);
if (dryRun) { console.log("--dry-run: not submitting"); process.exit(0); }

// CHOOSE THE SUBMITTER BY ATS (2026-10-05). This used to hard-code the Greenhouse submitter, so an Ashby form could
// never be submitted through the gate. Because the gate is the ONLY thing that enforces the standing pair table, Ashby
// submissions therefore bypassed that enforcement completely: a Hello Patient application went out through the Ashby
// script with four pairs left at "no" that the table would have caught (relocation, in-office days, startup experience,
// and a 50-hour week). Dispatching correctly is what makes the gate the single door to submission.
const isAshbyTarget = /ashbyhq\.com/i.test(target);
const args = isAshbyTarget
  ? ["src/forms/submit_ashby_application.mjs", target, slug, "--cdp", cdp]
  : ["src/forms/submit_with_verification_code.mjs", target, slug];
if (!isAshbyTarget && company) args.push("--company", company);
if (!isAshbyTarget) args.push("--cdp", cdp);
console.log(`submitter: ${args[0].split("/").pop()} (${isAshbyTarget ? "Ashby" : "Greenhouse/other"})`);
console.log("--- submitting ---");
try {
  const out = execFileSync("node", args, { encoding: "utf8", timeout: 240000 });
  const lines = out.split("\n").filter((l) => /confirmed|finalUrl/.test(l)).join("\n");
  console.log(lines || out.slice(-300));
  if (!/"confirmed":\s*true/.test(out)) { console.log("submit did not confirm"); process.exit(8); }
} catch (e) {
  console.log("submit tool failed:", String(e).slice(0, 200));
  process.exit(8);
}
process.exit(0);
