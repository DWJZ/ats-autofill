#!/usr/bin/env node
/**
 * dump_form_answers.mjs — the review pass for a filled ATS form.
 *
 * WHY THIS EXISTS (2026-10-08). Three separate mistakes reached the user before this tool did its job, and each one
 * defined one of the three checks below:
 *
 *   1. A value under the wrong label. Asana's long OPT/work-authorization paragraph was written into two OPTIONAL
 *      fields - "[Optional] Preferred Full Name" and "[Optional, if "other" is selected above] My pronouns are" -
 *      because the review swept `read_form_map | grep REQ` and never looked at anything optional.  -> CHECK 1
 *   2. A required field left empty. CoreWeave's "Please identify your race" sat on "Select..." while the review
 *      reported zero blanks: the dump printed only controls CARRYING a value, and `read_form_map` cannot see every
 *      react-select, so its count was 0 while the field was empty.                                    -> CHECK 2
 *   3. A follow-up left empty. Blend answered "How did you hear about us?" with Other and left "If you selected
 *      Other, please specify:" blank. That box is NOT required, so check 2 was silent and the word "Other" shipped
 *      with no explanation.                                                                          -> CHECK 3
 *
 * Usage:
 *   node src/forms/dump_form_answers.mjs <url-substring> [--cdp http://127.0.0.1:9223] [--json]
 *
 * Exit codes: 0 = printed, 1 = no matching tab.
 */
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
const cdpIdx = argv.indexOf("--cdp");
const cdp = cdpIdx >= 0 ? argv[cdpIdx + 1] : "http://127.0.0.1:9223";
const asJson = argv.includes("--json");
if (!target) {
  console.error("usage: dump_form_answers.mjs <url-substring> [--cdp http://127.0.0.1:9223] [--json]");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes(target));
if (!page) {
  console.error(`no open tab whose URL contains: ${target}`);
  process.exit(1);
}

const { answered, requiredButEmpty, emptyFollowUps, knownButEmpty, userWork } = await page.evaluate(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const items = [];

  /**
   * ONE MEASUREMENT PER CONTROL, so the three lists can never disagree about whether something holds a value.
   * A first version measured the answered list and the blank list in two passes with two notions of "has a value"
   * and reported plainly-filled fields ("Gender Male", "Country +1") as missing. A detector that cries wolf is worse
   * than no detector.
   */
  const push = (el, block, value, empty) => {
    if (!block) return;
    // THE LABEL IS THE BLOCK MINUS THE ANSWER. Greenhouse renders "<question> <answer>" as one text block, so taking
    // innerText whole prints the value twice and hides which question it belonged to.
    let label = clean(block.innerText);
    if (value) {
      const i = label.lastIndexOf(clean(value));
      if (i > 0) label = label.slice(0, i).trim();
    }
    label = label.slice(0, 120);
    if (!label) return;
    // AN EXPLICIT aria-required="false" BEATS THE ASTERISK. Greenhouse puts several controls in one labelled block, so
    // an optional "Website" input inherits the "*" from the "LinkedIn Profile*" label above it.
    const ariaReq = el.getAttribute && el.getAttribute("aria-required");
    const required = ariaReq === "false" ? false
      : ariaReq === "true" || el.required === true || /\*/.test(label);
    items.push({ id: el.id || el.name || "-", label, value, empty, required });
  };

  const labelOf = (el) => {
    let p = el;
    for (let i = 0; i < 7 && p; i++) {
      if (clean(p.innerText).length > 8) return p;
      p = p.parentElement;
    }
    return null;
  };

  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.type === "hidden" || el.type === "file") return;
    // SKIP THE INPUT INSIDE A REACT-SELECT. Its value is always empty - the selection lives in a sibling display node -
    // so measuring it here reports a filled select as blank and poisons the required-but-empty list.
    if (el.closest && el.closest('[class*="select__control"], [class*="select-shell"]')) return;
    if (el.type === "checkbox") {
      const block = labelOf(el);
      if (block) push(el, block, el.checked ? "CHECKED" : "", !el.checked);
      return;
    }
    const v = clean(el.value);
    const empty = !v || /^select\.{0,3}$/i.test(v);
    const block = labelOf(el);
    if (block) push(el, block, empty ? "" : v.slice(0, 200), empty);
  });

  document.querySelectorAll('[class*="select__control"], [class*="select-shell"]').forEach((ctl) => {
    const single = ctl.querySelector('[class*="single-value"], [class*="singleValue"]');
    const v = clean(single && single.innerText);
    // A react-select's own text IS its value, so the block is walked from ABOVE the control.
    let p = ctl.parentElement, block = null;
    for (let i = 0; i < 6 && p; i++) {
      const t = clean(p.innerText);
      if (t.length > 8 && (!v || t.indexOf(v) < 0)) { block = p; break; }
      p = p.parentElement;
    }
    if (!block && ctl.parentElement) block = ctl.parentElement;
    if (block) push(ctl, block, v.slice(0, 200), !v);
  });

  // The same control can be reached twice; keep the first, richest record.
  const byId = new Map();
  for (const it of items) {
    const key = it.id !== "-" ? it.id : it.label.slice(0, 60);
    const prev = byId.get(key);
    if (!prev || (prev.empty && !it.empty)) byId.set(key, it);
  }
  const all = [...byId.values()];

  /**
   * CHECK 3 - CONDITIONAL FOLLOW-UPS. A box that exists only because an earlier answer was given. It is not required,
   * so check 2 is silent about it, and that is exactly how "Other" shipped with an empty specification on Blend.
   *
   * IT FIRES ONLY ON THE FOLLOW-UP WHOSE TRIGGER ACTUALLY FIRED. Blend shows three specification boxes - Referral,
   * Event and Other - and only one of them should ever be filled; flagging all three would be crying wolf again. The
   * point is to name the box the given answer makes relevant and stay quiet about the rest.
   */
  const FOLLOWUP_RE = /^(if\b|if you|if so|in that case|please (specify|give|explain|describe|list|provide)|additional context|my pronouns are)/i;
  const values = all.filter((x) => !x.empty).map((x) => x.value.trim().toLowerCase());
  const hasValue = (v) => values.some((x) => x === v || x.startsWith(v) || x.includes(v));
  const emptyFollowUps = [];
  for (const it of all) {
    if (!it.empty) continue;
    const label = it.label.trim();
    if (!FOLLOWUP_RE.test(label)) continue;
    const m = label.match(/selected\s+([A-Za-z][A-Za-z /-]{1,24}?)(?:,|\s+please|:|$)/i)
      || label.match(/responded\s+(yes|no)/i)
      || label.match(/answered\s+(yes|no)/i);
    if (m && !hasValue(m[1].trim().toLowerCase())) continue;
    emptyFollowUps.push({ id: it.id, label: it.label, trigger: m ? m[1].trim() : null });
  }

  /**
   * CHECK 4 - EMPTY, BUT THE ANSWER IS KNOWN. Cloudflare's "Please identify your race" is NOT required (no asterisk),
   * so check 2 stayed silent while it sat on "Select..." - and the standing answers already say East Asian. The
   * project rule is to fill every field whose answer is reliably known, required or not, so a known-answer field left
   * empty is a defect even when the form does not demand it.
   */
  const KNOWN_ANSWER_RE = /gender|hispanic|latino|race|ethnicit|veteran|disabilit|pronoun|how did you hear|how'?d you hear|linkedin|github|current company|current title|preferred (first )?name/i;
  const knownButEmpty = all.filter((x) => x.empty && KNOWN_ANSWER_RE.test(x.label)).map((x) => ({ id: x.id, label: x.label }));

  /**
   * CHECK 5 - A FIELD THAT ASKS FOR THE USER'S OWN WORK, NOT FOR A FACT. Cloudflare's "Optional Assignment: Please
   * share GitHub repo URL for the project here" wants a repository for an assignment the candidate has to BUILD. It
   * was filled with the profile GitHub URL, which is a profile link and not a submission - the same class of mistake
   * as the OPT paragraph in a name field: a value that is real but answers a different question. These fields are
   * reported whether filled or empty, because either way a human has to decide.
   */
  const USER_WORK_RE = /assignment|take[- ]?home|exercise|prompt history|code sample|portfolio|writing sample|please (build|complete|submit)/i;
  const userWork = all.filter((x) => USER_WORK_RE.test(x.label)).map((x) => ({ id: x.id, label: x.label, value: x.value }));

  return {
    answered: all.filter((x) => !x.empty).map((x) => ({ id: x.id, label: x.label, value: x.value })),
    knownButEmpty,
    userWork,
    requiredButEmpty: all.filter((x) => x.empty && x.required).map((x) => ({ id: x.id, label: x.label })),
    emptyFollowUps,
  };
});

await browser.close().catch(() => {});

if (asJson) {
  console.log(JSON.stringify({ answered, requiredButEmpty, emptyFollowUps, knownButEmpty, userWork }, null, 1));
  process.exit(0);
}

console.log(`CHECK 1 - ${answered.length} answered control(s) on ${target}\n`);
for (const r of answered) {
  console.log(`  ${r.label.slice(0, 58).padEnd(60)} | ${r.value}`);
}
console.log("\n  Every value above must be sensible FOR ITS OWN LABEL.");

if (requiredButEmpty.length) {
  console.log(`\nCHECK 2 - ${requiredButEmpty.length} REQUIRED FIELD(S) WITH NO VALUE:`);
  for (const b of requiredButEmpty) console.log(`  !! ${b.label.slice(0, 92)}`);
} else {
  console.log("\nCHECK 2 - no required field is empty.");
}

if (emptyFollowUps.length) {
  console.log(`\nCHECK 3 - ${emptyFollowUps.length} EMPTY FOLLOW-UP FIELD(S), not required and therefore invisible to check 2:`);
  for (const f of emptyFollowUps) {
    console.log(`  ?? ${f.label.slice(0, 88)}${f.trigger ? `   [trigger: ${f.trigger}]` : ""}`);
  }
} else {
  console.log("CHECK 3 - no relevant follow-up is left empty.");
}

if (knownButEmpty.length) {
  console.log(`\nCHECK 4 - ${knownButEmpty.length} EMPTY FIELD(S) WHOSE ANSWER IS ALREADY KNOWN (not required, so check 2 is silent):`);
  for (const k of knownButEmpty) console.log(`  ** ${k.label.slice(0, 92)}`);
} else {
  console.log("CHECK 4 - no known-answer field is left empty.");
}

if (userWork.length) {
  console.log(`\nCHECK 5 - ${userWork.length} FIELD(S) ASKING FOR THE USER'S OWN WORK. A profile link is NOT a submission;`);
  console.log("these need a human decision whatever they currently hold:");
  for (const w of userWork) console.log(`  ~~ ${w.label.slice(0, 80)}${w.value ? `   [currently: ${w.value.slice(0, 40)}]` : "   [empty]"}`);
}
