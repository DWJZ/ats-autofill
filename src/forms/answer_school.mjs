#!/usr/bin/env node
/**
 * answer_school.mjs — THE entry point for an ATS's remote-search school control.
 *
 * WHY THIS EXISTS. The school picker was the project's largest recorded blocker - six rounds on Affirm alone, and it
 * was never blocked. `driving-widgets-tools-4.md` has the correction: the string being passed was wrong
 * (`Lakeside State University, Fairview` against a list holding `Lakeside State University - Fairview`), and
 * `pick_option` refusing to guess was read as a tool limitation. The procedure that recovers it was then written down
 * as prose - short query, wait for the remote list, read the ACTUAL row text, never assume it - and prose is not a
 * tool: the next agent facing the same control re-derives it.
 *
 * THE USER'S OWN PROCEDURE (user rule, 2026-10-10), which is what this encodes:
 *   type the SHORT distinctive word -> the remote list usually renders the school -> **if it does not, choose `Other`**.
 * The `Other` fallback is the part the old prose did not have: it said "only then treat it as a manual-finish case",
 * so a listing that would not render became a handover for what is one extra pick.
 *
 * WHAT IT DOES, in order, and never anything else:
 *   1. reads the school from data/application_profile.json (the most recent education entry, unless --query/--option
 *      override it) and derives the SHORT query - the part after the last comma, i.e. `Fairview`;
 *   2. runs `pick_option` on the school ref with that query (the settled tool: it waits for the remote list and
 *      verifies by EQUALITY against the control's own display node);
 *   3. if and only if that sets nothing, retries the SAME ref with the fallback option (`Other` by default);
 *   4. reports which path was taken, and on total failure prints the rows it actually saw.
 *
 * IT NEVER INVENTS A ROW. If neither attempt commits, it exits 3 - the same contract as `pick_option` - so the caller
 * records "school not set" rather than writing a plausible-looking name into the form. A wrong school is a false
 * statement about the candidate; a blank one is visible in the audit.
 *
 * USAGE
 *   node src/forms/answer_school.mjs <url-part> [--ref school--0] [--query fairview] [--option "…Fairview"]
 *                                              [--fallback Other] [--dry-run] [--cdp http://127.0.0.1:9223]
 *
 * EXIT  0 every attempt verified · 1 set but the read-back disagreed · 2 usage/tab error · 3 nothing was set
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nameTolerantRegex, shortQuery } from "./school_query.mjs";
// The profile is read through the one definition of the `ATS_DATA_DIR` setting rather than off a path
// computed here; `src/paths.mjs` names the setting, and this file already imports a sibling module.
import { DATA_DIR } from "../paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(DATA_DIR, "application_profile.json");
const PICK = join(HERE, "pick_option.mjs");

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help")) {
  console.error(
    "usage: answer_school.mjs <url-part> [--ref school--0] [--query fairview] [--option \"…\"] " +
    "[--fallback Other] [--dry-run] [--cdp http://127.0.0.1:9223]"
  );
  process.exit(2);
}

const flag = (name, dflt = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const target = positional[0];
if (!target) {
  console.error("usage: answer_school.mjs <url-part> …  (the url substring of the tab to use)");
  process.exit(2);
}

const ref = flag("--ref", "school--0");
const fallback = flag("--fallback", "Other");
const dryRun = has("--dry-run");
const cdp = flag("--cdp", "http://127.0.0.1:9223");

// The school text and its short query. Both overridable, because a tenant may word the row differently again.
function fromProfile() {
  const profile = JSON.parse(readFileSync(PROFILE, "utf8"));
  const edu = profile.education || [];
  const recent = edu[0] || {};
  return recent.school || "";
}
const school = flag("--option", "") || fromProfile();
if (!school) {
  console.error("no school found in data/application_profile.json and no --option given - nothing to set");
  process.exit(3);
}
// Both decisions live in school_query.mjs so `test_answer_school.mjs` can pin them WITHOUT a browser - they are the
// two that go wrong in silence: a query that does not filter, and a pattern that matches the wrong school.
const query = flag("--query", shortQuery(school));

function pick(option, label, { regex = false, withQuery = true } = {}) {
  const args = [
    PICK, target,
    "--id", ref,
    regex ? "--option-regex" : "--option", option,
    "--cdp", cdp,
  ];
  if (regex) args.push("--match", "regex");
  // THE FALLBACK IS CHOSEN WITH AN EMPTY QUERY, and that is a measured requirement rather than a preference: with
  // `Fairview` in the box the list is filtered to the one school row, so `Other` is NOT in it and the fallback
  // silently fails. Opening the control with no query shows the full list, where `Other` lives.
  if (withQuery) args.push("--query", query);
  if (dryRun) args.push("--dry-run");
  if (has("--rowsOnly")) args.push("--rowsOnly");
  const shown = withQuery ? `query=${JSON.stringify(query)}` : "query=(none)";
  console.log(`\n--- ${label}: id=${ref} ${shown} ${regex ? "regex" : "option"}=${JSON.stringify(option)} ---`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  return r.status === null ? 2 : r.status;
}

// A DRY RUN MAKES NO CLAIM, AND THIS TOOL MUST NOT INVENT ONE. `pick_option --dry-run` prints "nothing was pressed
// and nothing was verified. No claim is being made about the form." and STILL EXITS 0 - so a wrapper that reads the
// exit code alone would report "SET" for a run that pressed nothing, which is the same class of false-credential the
// school picker's own history is made of. In dry-run the wording says WOULD, never SET, and the exit is 0 by design.
const VERB = dryRun ? "WOULD PICK" : "SET";

const first = pick(school, "attempt 1: the profile's school name");
if (first === 0 && !dryRun) {
  console.log(`\nSET: ${ref} = ${JSON.stringify(school)} (query ${JSON.stringify(query)})`);
  process.exit(0);
}
if (first === 0 && dryRun) {
  console.log(`\nWOULD PICK: ${ref} = ${JSON.stringify(school)} (query ${JSON.stringify(query)}) - nothing was pressed`);
  process.exit(0);
}

// ATTEMPT 1.5: THE SAME NAME WITH THE LIST'S OWN SEPARATOR. Measured on 2026-10-10 against this very control: the
// profile holds `Lakeside State University, Fairview` and the list holds `Lakeside State University - Fairview`,
// so attempt 1 legitimately fails while the row is RIGHT THERE. This is the documented recovery step, mechanised -
// and `nameTolerantRegex` is where the "do not match a DIFFERENT school" guard is tested.
const tolerant = nameTolerantRegex(school);
const mid = pick(tolerant, `attempt 1b: the same name with the list's own separator (${tolerant})`, { regex: true });
if (mid === 0 && !dryRun) {
  console.log(`\nSET: ${ref} = the list's spelling of ${JSON.stringify(school)} (matched ${tolerant})`);
  process.exit(0);
}
if (mid === 0 && dryRun) {
  console.log(`\nWOULD PICK: ${ref} matched ${tolerant} - nothing was pressed`);
  process.exit(0);
}
if (mid === 1) {
  console.error(`\nSTOP: ${ref} was set but its read-back disagreed - not falling back`);
  process.exit(1);
}
if (mid === 2) {
  console.error(`\nSTOP: usage or tab error (exit 2) - nothing was pressed`);
  process.exit(2);
}
if (first === 1) {
  // It committed but the read-back disagreed. That is a real disagreement about what the control now holds - do NOT
  // paper over it with the fallback, because the fallback would hide a control that is showing the wrong school.
  console.error(`\nSTOP: ${ref} was set but its read-back disagreed with ${JSON.stringify(school)} - not falling back`);
  process.exit(1);
}
if (first === 2) {
  console.error(`\nSTOP: usage or tab error from pick_option (exit 2) - nothing was pressed`);
  process.exit(2);
}

console.log(`\nno row committed for ${JSON.stringify(school)}; falling back to ${JSON.stringify(fallback)} (empty query)`);
const second = pick(fallback, `attempt 3: the fallback option, with NO query so the full list is open`, { withQuery: false });
if (second === 0 && !dryRun) {
  console.log(`\nSET: ${ref} = ${JSON.stringify(fallback)} (fallback - the school row did not render for ${JSON.stringify(query)})`);
  process.exit(0);
}
if (second === 0 && dryRun) {
  console.log(`\nWOULD PICK (fallback): ${ref} = ${JSON.stringify(fallback)} - nothing was pressed`);
  process.exit(0);
}
console.error(
  `\nNOT SET: neither ${JSON.stringify(school)} nor ${JSON.stringify(fallback)} committed for ${ref}.\n` +
  `The rows the control actually showed are in the output above - read them before trying another string.`
);
process.exit(second === 1 ? 1 : 3);
