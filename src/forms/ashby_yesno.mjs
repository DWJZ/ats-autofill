/**
 * ashby_yesno.mjs — THE entry point for Ashby's Yes/No pair widget: enumerate it, answer it, and prove the answer stuck.
 *
 * This replaces eight scripts that each solved one facet of the same widget (scan_button_pairs, list_yesno_pairs,
 * press_all_pairs, answer_by_checkbox, answer_by_question_text, answer_ashby_pair, answer_pair_by_question,
 * ashby_yesno3). They were written one tenant-failure at a time, and the cost of that is on record in the platform
 * references: an agent that needs "answer one pair by its question" cannot tell which of the eight does it, so the
 * next failure produced a ninth. One tool with flags is cheaper than eight tools with names.
 *
 * WHAT THE WIDGET ACTUALLY IS, because three separate bugs came from getting this wrong.
 * A question renders as two `<button>Yes|No</button>` controls over a HIDDEN CHECKBOX whose `name` is the field id,
 * and the server reads the CHECKBOX. So `aria-pressed` on the buttons is NOT evidence (PressAllPairs reported pairs
 * as answered on that basis and was wrong); the checkbox is. Some tenants draw the same question as a RADIO pair
 * instead, which a checkbox-climbing scanner cannot see at all. And a checkbox that was never touched reads exactly
 * like one deliberately answered "No" — which is how the Prompt form cost four refused submits in a row.
 *
 * THE FIX FOR ALL THREE is the opposite-first press plus a read-back of the truth after each step: press the
 * opposite, confirm the state actually moved, press the wanted answer, confirm it moved again. A pair that cannot be
 * moved is reported instead of being silently recorded as done. `aria-pressed` is never consulted.
 *
 * USAGE
 *   node src/forms/ashby_yesno.mjs <url-substring> [mode] [options]
 *
 * MODES (default: answer every pair from the standing table)
 *   --list                     enumerate every pair with its true state; press nothing
 *   --only "<question text>"   answer only the pair whose question contains this text
 *   --checkbox "<name>"        answer only the pair that owns this hidden checkbox name
 *
 * WHERE THE ANSWER COMES FROM (default: the standing table)
 *   --answer yes|no            force one answer; use with --only or --checkbox
 *   --plan <file>              [{ "match": "...", "answer": "yes" }] or a text entry
 *                              [{ "match": "...", "type": "text", "value": "..." }]
 *   --table <path>             standing table (default data/form_specs/ashby_pairs_standing.json)
 *
 * OTHER
 *   --cdp <url>                default http://127.0.0.1:9223
 *   --dry-run                  decide and report, press nothing
 *   --json                     machine-readable result on stdout instead of the human report
 *
 * EXIT CODES
 *   0 = every targeted pair now holds its wanted answer (proved by a read-back)
 *   3 = at least one pair was unmatched, or was pressed and did NOT move  (nothing else was touched)
 *   2 = no tab matches, or usage error
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The default standing table is configuration: `src/paths.mjs` holds the one definition of where it lives, so
// `--table` omitted means the configured data directory rather than whatever the working directory happens to be.
import { DATA_DIR } from "../paths.mjs";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dryRun = argv.includes("--dry-run");
const asJson = argv.includes("--json");
const listOnly = argv.includes("--list");
const only = flag("only");
const onlyCheckbox = flag("checkbox");
const forced = flag("answer");
const planPath = flag("plan");
const cdp = flag("cdp", "http://127.0.0.1:9223");

if (!target) {
  console.error('usage: ashby_yesno.mjs <url-substring> [--list | --only "<q>" | --checkbox "<name>"] '
    + "[--answer yes|no | --plan file] [--table path] [--cdp url] [--dry-run] [--json]");
  process.exit(2);
}
if (forced && !["yes", "no"].includes(String(forced).toLowerCase())) {
  console.error(`--answer takes yes or no, not ${JSON.stringify(forced)}`);
  process.exit(2);
}
// Forcing one answer across every pair on the page would be a way to answer a form wrongly in a single command, so
// it is only accepted together with a selector for the one pair it applies to.
if (forced && !only && !onlyCheckbox) {
  console.error("--answer needs --only \"<question>\" or --checkbox \"<name>\" to say which pair it applies to.");
  process.exit(2);
}
if (listOnly && (forced || planPath)) {
  console.error("--list only enumerates; drop --answer / --plan.");
  process.exit(2);
}

/** The standing table answers yes/no pairs AND forty other control kinds; only the yes/no half belongs here. */
function loadRules(path) {
  if (!path) return { usable: [], malformed: [] };
  let table;
  try {
    table = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`cannot read the standing answer table ${path}: ${String(error).slice(0, 120)}`);
    process.exit(2);
  }
  const all = Array.isArray(table) ? table : table.rules || [];
  // A rule with no usable `questionRe` is NOT a harmless no-op. `new RegExp(undefined, "i")` matches EVERY string, so
  // such a rule absorbs every pair no earlier rule claimed and answers it with its own value. One such row is in the
  // shipped table (it uses `q` instead of `questionRe`) and it says "no" — so without this filter any unrecognised
  // question would be answered **No**, which on a work-authorisation pair is a false statement to an employer.
  // Malformed rules are dropped here and named in the report; they are never allowed to match anything.
  const usable = [];
  const malformed = [];
  for (const rule of all) {
    if (typeof rule.questionRe === "string" && rule.questionRe.length > 0) {
      usable.push({ ...rule, answer: String(rule.answer || "").toLowerCase() });
    } else {
      malformed.push(rule);
    }
  }
  return { usable, malformed };
}

// `--list` still loads the table: its whole value is telling you which rule a pair WOULD get, so a listing that
// cannot say that is worse than useless. `--answer` deliberately does not - it overrides the table by definition.
const { usable: rules, malformed } = loadRules(
  forced ? null : flag("table", join(DATA_DIR, "form_specs", "ashby_pairs_standing.json")));
const plans = planPath ? JSON.parse(readFileSync(planPath, "utf8")) : [];
// A rule whose answer is `option` or `value` describes a select or a text field, NOT this widget. The eight-script
// version computed `rule.answer === "yes" ? "Yes" : "No"`, so all forty of those rules would have pressed **No** on
// whatever pair their pattern happened to match. They are skipped here and named in the report.
const YESNO_ONLY = rules.filter((rule) => rule.answer === "yes" || rule.answer === "no");

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => (p.url() || "").includes(target));
if (!page) { console.error(`no tab matching ${target}`); process.exit(2); }

/* ---------------------------------------------------------------- page-side helpers, as strings for evaluate */

/** Walk up from an input looking for the question text that owns it. */
const QUESTION_WALK = `
  function questionOf(el) {
    let w = el, q = "";
    for (let i = 0; i < 16 && w; i++) {
      const t = (w.innerText || "").replace(/\\s+/g, " ").trim();
      if (t && t.length > 16 && !/^(Yes\\s*No|Yes|No)$/i.test(t)) { q = t; break; }
      w = w.parentElement;
    }
    return q;
  }`;

/** Enumerate candidate pairs: checkbox- and radio-drawn, exactly two options, each with its question. */
async function enumerate() {
  return page.evaluate(`(() => {
    ${QUESTION_WALK}
    const pairs = [], seen = new Set();
    const all = [...document.querySelectorAll("input[type=checkbox], input[type=radio]")];
    for (const el of all) {
      if (el.type === "radio") {
        const group = document.querySelectorAll('input[name="' + CSS.escape(el.name || "-") + '"]');
        if (group.length > 2) continue;   // four options means EEO or multi-choice, not a yes/no pair
      }
      const q = questionOf(el);
      if (!q) continue;
      const key = el.type + "|" + q;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ kind: el.type, name: el.name || "", question: q, unnamed: !el.name });
    }
    return pairs;
  })()`);
}

/**
 * The truth about one pair: the hidden checkbox for a checkbox pair, the checked option for a radio pair.
 * `aria-pressed` is deliberately not read - the references record it staying correct while the server saw nothing.
 */
async function readState(pair) {
  return page.evaluate(`(() => {
    ${QUESTION_WALK}
    const want = ${JSON.stringify(pair.question)};
    const inputs = [...document.querySelectorAll("input[type=checkbox], input[type=radio]")];
    if (${JSON.stringify(pair.kind)} === "radio") {
      const group = inputs.filter((x) => x.type === "radio" && x.name === ${JSON.stringify(pair.name)});
      const on = group.find((x) => x.checked);
      if (!on) return { found: group.length > 0, value: null, label: null };
      let w = on.parentElement, label = "";
      for (let i = 0; i < 4 && w; i++) {
        const t = (w.innerText || "").trim();
        if (t && t.length < 40) { label = t; break; }
        w = w.parentElement;
      }
      return { found: true, value: label.trim().toLowerCase(), label: label.trim() };
    }
    const box = inputs.find((x) => x.type === "checkbox" && questionOf(x) === want);
    if (!box) return { found: false, value: null, label: null };
    return { found: true, value: box.checked ? "yes" : "no", label: box.checked ? "Yes" : "No", checkboxName: box.name || "" };
  })()`);
}

/** Press one option of a pair with a real mouse event, by its coordinates, measured at press time. */
async function press(pair, want) {
  const point = await page.evaluate(`(() => {
    ${QUESTION_WALK}
    const want = ${JSON.stringify(want)};
    const rx = new RegExp("^" + want + "$", "i");
    const inputs = [...document.querySelectorAll("input[type=checkbox], input[type=radio]")];
    for (const el of inputs) {
      if (questionOf(el) !== ${JSON.stringify(pair.question)}) continue;
      // THE PAIR'S OWN CONTAINER, and the button search is confined to it. Walking up and taking any button found
      // in ANY ancestor is the Affirm trap the base records: on a page holding two pairs, a high enough ancestor's
      // querySelectorAll("button") returns the OTHER pair's buttons too, so the press lands on a different question.
      // Found on src/forms/fixtures/ats_widgets.html, where the name-only pair press was hitting the hidden pair's
      // Yes button and the read-back (correctly) refused to call it a success. questionOf's own stopping rule
      // identifies the container, so reuse it rather than guessing a depth.
      let container = el;
      for (let i = 0; i < 16 && container; i++) {
        const t = (container.innerText || "").replace(/\\s+/g, " ").trim();
        if (t && t.length > 16 && !/^(Yes\\s*No|Yes|No)$/i.test(t)) break;
        container = container.parentElement;
      }
      // Buttons INSIDE that container, tightest first: a nested wrapper may hold its own copy.
      for (let n = el; n && n !== container.parentElement; n = n.parentElement) {
        const btn = [...n.querySelectorAll("button")].find((x) => rx.test((x.innerText || "").trim()));
        if (btn) {
          btn.scrollIntoView({ block: "center" });
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        if (n === container) break;
      }
      // The label that belongs to THIS input, in the three ways a form associates one:
      //   (a) the input is inside it             -> closest("label")
      //   (b) it is the input's own parent       -> parentElement, whose first line is the option text
      //   (c) it is a SIBLING, bound by for/id   -> the Sprinter Health shape: an input then a sibling label
      //       reading Yes. (a) and (b) both miss it: the parent is the pair container and reads "Yes No", which
      //       cannot match the anchored option text. Without (c) the press targeted nothing and the read-back
      //       said "reads no" -- an honest failure, but still a failure.
      //       Verified against src/forms/fixtures/ats_widgets.html.
      const own = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      const nxt = el.nextElementSibling && el.nextElementSibling.tagName === "LABEL" ? el.nextElementSibling : null;
      const prv = el.previousElementSibling && el.previousElementSibling.tagName === "LABEL" ? el.previousElementSibling : null;
      const lab = el.closest("label") || own || nxt || prv || el.parentElement;
      const first = lab ? (lab.innerText || "").trim().split("\\n")[0].trim() : "";
      if (lab && rx.test(first)) {
        lab.scrollIntoView({ block: "center" });
        const r = lab.getBoundingClientRect();
        return { x: Math.round(r.x + 12), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  })()`);
  if (!point) return false;
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(110);
  await page.mouse.up();
  await page.waitForTimeout(800);
  return true;
}

/* ---------------------------------------------------------------- decide */

const pairs = await enumerate();
const results = [];

function wantedFor(pair) {
  if (forced) return String(forced).toLowerCase();
  const byCheckbox = onlyCheckbox && (pair.name === onlyCheckbox || pair.question.includes(onlyCheckbox));
  const byText = only;
  if (byCheckbox || byText) {
    // A single targeted pair takes its answer from the plan or the table, in that order.
    const plan = plans.find((p) => (byText ? new RegExp(p.match, "i").test(pair.question) : pair.name === onlyCheckbox));
    if (plan) return String(plan.answer || "").toLowerCase() || null;
    const rule = YESNO_ONLY.find((r) => new RegExp(r.questionRe, "i").test(pair.question));
    return rule ? rule.answer : null;
  }
  const rule = YESNO_ONLY.find((r) => new RegExp(r.questionRe, "i").test(pair.question));
  return rule ? rule.answer : null;
}

function inScope(pair) {
  if (only) return new RegExp(only, "i").test(pair.question);
  if (onlyCheckbox) return pair.name === onlyCheckbox;
  return true;
}

for (const pair of pairs) {
  if (!inScope(pair)) continue;
  const before = await readState(pair);
  const wanted = wantedFor(pair);
  if (listOnly) {
    // A listing presses nothing, so nothing here is a failure: it reports what a run WOULD do.
    results.push({ ...pair, wanted, before: before.value, after: before.value, verdict: wanted ? "would-press" : "no-rule" });
    continue;
  }
  if (!wanted) {
    results.push({ ...pair, wanted: null, before: before.value, after: before.value, verdict: "unmatched" });
    continue;
  }
  if (dryRun) {
    results.push({ ...pair, wanted, before: before.value, after: before.value, verdict: "dry-run" });
    continue;
  }
  // Opposite first: it proves the press lands, and it is the documented cure for a desynced control. Then the wanted
  // answer. Each step is confirmed against the checkbox/radio, never against the button's aria-pressed.
  const opposite = wanted === "yes" ? "no" : "yes";
  await press(pair, opposite);
  const mid = await readState(pair);
  await press(pair, wanted);
  const after = await readState(pair);
  let verdict = "ok";
  if (!mid.found || mid.value !== opposite) verdict = "did-not-move";
  else if (after.value !== wanted) verdict = "wrong-final-state";
  results.push({ ...pair, wanted, before: before.value, mid: mid.value, after: after.value, verdict });
}

/* ---------------------------------------------------------------- report */

const bad = results.filter((r) => r.verdict === "unmatched" || r.verdict === "did-not-move" || r.verdict === "wrong-final-state");
const skipped = rules.filter((rule) => rule.answer !== "yes" && rule.answer !== "no");

if (asJson) {
  console.log(JSON.stringify({
    target, pairs: pairs.length, examined: results.length, results,
    unmatched: results.filter((r) => r.verdict === "unmatched").map((r) => r.question.slice(0, 120)),
    not_moved: bad.filter((r) => r.verdict !== "unmatched").map((r) => ({ question: r.question.slice(0, 120), verdict: r.verdict, before: r.before, after: r.after })),
    non_yesno_rules_skipped: skipped.length,
  }, null, 1));
} else {
  console.log(`${listOnly ? "listing" : dryRun ? "dry-run" : "answering"} ${resultLength()} of ${pairs.length} pair(s) on ${target}`);
  console.log();
  for (const r of results) {
    const mark = r.verdict === "ok" ? "OK  " : r.verdict === "dry-run" || r.verdict === "would-press" ? "DRY "
      : r.verdict === "no-rule" ? "--  " : "!!  ";
    const want = r.wanted ? r.wanted.toUpperCase().padEnd(3) : "???";
    const went = r.verdict === "ok" || r.verdict === "dry-run" || r.verdict === "would-press" || r.verdict === "no-rule"
      ? `${r.before}${r.verdict === "would-press" ? " -> " + r.wanted : r.verdict === "no-rule" ? " (no rule)" : ""}`
      : `${r.before} -> ${r.mid ?? "-"} -> ${r.after ?? "-"}`;
    console.log(`  ${mark}${want} | ${String(r.question).slice(0, 62).padEnd(62)} | ${went}`);
    if (r.verdict === "unmatched") console.log(`        no yes/no rule matches this question - decide it by hand`);
    if (r.verdict === "did-not-move") console.log(`        the press did not move the control; it is desynced or not a pair`);
    if (r.verdict === "wrong-final-state") console.log(`        pressed ${r.wanted} but the control reads ${r.after}`);
    if (r.unnamed) console.log(`        (this control has no name attribute - addressed by its question text)`);
  }
  if (skipped.length) {
    console.log(`\n${skipped.length} standing rule(s) describe a select or text field, not a yes/no pair, and were skipped:`);
    for (const rule of skipped.slice(0, 5)) console.log(`  ${String(rule.answer).padEnd(7)} ${String(rule.questionRe).slice(0, 70)}`);
    if (skipped.length > 5) console.log(`  … and ${skipped.length - 5} more`);
  }
  if (malformed.length) {
    console.log(`\n${malformed.length} malformed rule(s) have no usable \`questionRe\` and were refused a match entirely.`);
    console.log("A rule like this matches EVERY question (RegExp(undefined) matches anything), so it would answer");
    console.log("every unrecognised pair with its own value. Fix the table:");
    for (const rule of malformed.slice(0, 5)) console.log(`  ${JSON.stringify(rule).slice(0, 120)}`);
  }
  if (bad.length) {
    console.log(`\n${bad.length} pair(s) need a decision - nothing else was touched.`);
  }
}

function resultLength() {
  return results.filter((r) => r.verdict !== "unmatched").length;
}

process.exit(!listOnly && bad.length ? 3 : 0);
