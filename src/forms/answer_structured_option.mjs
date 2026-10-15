#!/usr/bin/env node
/**
 * answer_structured_option.mjs — set a long-list / remote-list option control, deriving its filter from the answer.
 *
 * WHY THIS EXISTS. `answer_school.mjs` derives its own query and everything else took one from a person, so on the
 * Twitch form `candidate-location` reported `option not found` while the identical command with `--query "Springfield"`
 * succeeded. The difference was never the widget - it was that nobody had told the control what to filter on.
 *
 * It is a tool rather than a change inside `apply_form_spec.mjs` because the two do different things and the filler's
 * own comment says so: its recipe table gives `react_select` and `input_combobox` the tool `pick_option.mjs`, and
 * `option not found` for a remote list is not a filler bug - it is a missing ARGUMENT. The filler keeps working for the
 * 17 controls on that page it can already drive; this handles the ones whose list does not exist until something is
 * typed.
 *
 * HOW SUCCESS IS DECIDED: only `pick_option`'s exit 0 counts, and that code means the option was verified BY EQUALITY
 * against the control's own display node. A candidate query that filters to nothing costs one attempt, never a wrong
 * answer - which is why the candidates can be tried in turn at all.
 *
 * Usage:
 *   node src/forms/answer_structured_option.mjs <url-part> --ref candidate-location \
 *       --value "Springfield, Illinois, United States" [--query Q] [--cdp …] [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryCandidates } from "./structured_query.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PICK = join(HERE, "pick_option.mjs");
const argv = process.argv.slice(2);
const flag = (name, dflt = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const VALUED = new Set(["--ref", "--value", "--query", "--cdp", "--match", "--verify", "--expect-label"]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith("--")) continue;
  positional.push(argv[i]);
}
const target = positional[0];
const ref = flag("--ref");
const value = flag("--value");
if (!target || !ref || !value) {
  console.error('usage: answer_structured_option.mjs <url-part> --ref <control id> --value "<canonical value>" [--query Q]');
  process.exit(2);
}
const cdp = flag("--cdp", "http://127.0.0.1:9223");
const dryRun = has("--dry-run");
const explicit = flag("--query");

// A DRY RUN MAKES NO CLAIM AND THIS MUST NOT INVENT ONE. `pick_option --dry-run` prints "nothing was pressed and
// nothing was verified. No claim is being made about the form." and still exits 0, so a wrapper reading the exit code
// alone would print SET for a run that pressed nothing.
const VERB = dryRun ? "WOULD SET" : "SET";

const queries = explicit ? [explicit] : queryCandidates(value);
if (!queries.length) {
  console.error(`nothing to filter on: the value ${JSON.stringify(value)} has no usable segment`);
  process.exit(3);
}

function attempt(query) {
  const args = [PICK, target, "--id", ref, "--option", value, "--query", query, "--cdp", cdp];
  if (dryRun) args.push("--dry-run");
  console.log(`\n--- ${ref}: query=${JSON.stringify(query)} option=${JSON.stringify(value)} ---`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  return r.status === null ? 2 : r.status;
}

const tried = [];
for (const [i, query] of queries.entries()) {
  const code = attempt(query);
  tried.push({ query, code });
  if (code === 0) {
    console.log(`\n${VERB}: ${ref} = ${JSON.stringify(value)} (filter ${JSON.stringify(query)}, candidate ${i + 1}/${queries.length})`);
    process.exit(0);
  }
}

// NOTHING WORKED. The candidates seen are printed so the next attempt starts from what the list actually offered
// rather than from the same guess - which is how the school picker's `Other` fallback was found.
console.error(`\nNOT SET: ${JSON.stringify(value)} was not offered under any of ${queries.length} filter(s) ${JSON.stringify(queries)}`);
console.error(`exit codes: ${tried.map(t => `${JSON.stringify(t.query)}=${t.code}`).join(" ")}`);
console.error("1 = a row was set but the read-back disagreed · 2 = usage/tab error · 3 = nothing was committed");
process.exit(3);
