#!/usr/bin/env node
/**
 * refill_until_stable.mjs — run scan -> draft -> fill until the form STOPS REVEALING new controls.
 *
 * THE PROBLEM IT SOLVES, in the user's words on 2026-10-10: "让脚本自己去多跑几轮, 加个循环, 直到没有新的控件出现
 * 才停止".
 *
 * A scan taken before the fill cannot see a control the fill creates. Greenhouse's EEO block is a cascade - `Please
 * identify your race` does not exist until `Are you Hispanic/Latino?` has been answered `No` - so the drafter cannot
 * emit it, `needs_review` cannot list it, and one pass is structurally unable to finish the form. The filler already
 * detects the effect and reports the controls its spec never mentioned; until now that report was a DEAD END that only
 * a human could act on, and acting on it meant running the same three commands by hand.
 *
 * This is that loop, with three things it must not get wrong:
 *
 *   1. IT STOPS ON "NO NEW CONTROLS", NOT ON "NOTHING BLANK". A control can reveal nothing and stay impossible to fill
 *      (a react-select the filler cannot drive, a question only the candidate can answer). Waiting for zero blanks
 *      would spin forever on exactly the forms this project keeps meeting, so the exit condition is the NEW IDS.
 *   2. IT IS BOUNDED. Each round is two browser passes and a subprocess; a form that reveals one fresh control forever
 *      must end the run rather than hang it, and `--max-rounds` makes that a decision instead of an accident.
 *   3. A ROUND THAT CHANGES NOTHING IS THE LAST ONE. If a round reveals no new controls, a further round cannot do
 *      anything either, so the loop stops there rather than re-running to confirm.
 *
 * Usage:
 *   node src/forms/refill_until_stable.mjs <url-substring> [--job "Twitch — Software Engineer I"]
 *       [--resume <pdf>] [--cover-letter <pdf>] [--url <form url>] [--max-rounds 4] [--cdp http://127.0.0.1:9223]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const get = (name, dflt = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// Flags that TAKE a value, so the first bare argument can be told apart from a flag's argument.
const VALUED = new Set(["--job", "--resume", "--cover-letter", "--url", "--max-rounds", "--cdp",
                        "--step-timeout"]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith("--")) continue;
  positional.push(argv[i]);
}
const frag = positional[0];
if (!frag) {
  console.error("usage: refill_until_stable.mjs <url-substring> [--job ...] [--resume x.pdf] [--cover-letter y.pdf] [--max-rounds 4] [--step-timeout ms]");
  process.exit(2);
}
const job = get("--job", "");
const resume = get("--resume", "");
const cover = get("--cover-letter", "");
const formUrl = get("--url", "");
const cdp = get("--cdp", "http://127.0.0.1:9223");
const maxRounds = Number(get("--max-rounds", "4"));
// EACH STEP GETS ITS OWN BUDGET, AND A CALLER CAN SHORTEN IT. Ten minutes is right for a real form - a
// live ATS round-trips every control and the machine is the limit - but it was the ONLY budget, and it
// is longer than any caller's. A test that allowed the loop 270 s could not make a hung step stop:
// the loop sat in the step for the full ten minutes, its own caller killed IT, and the test then waited
// on the grandchildren that still held the pipe. That is a 13-minute hang reporting nothing. A caller
// that passes a shorter budget gets a step that fails inside it, and the failure names the timeout.
const stepTimeout = Number(get("--step-timeout", "600000"));
const outDir = join(ROOT, "tmp", "apply");
mkdirSync(outDir, { recursive: true });

const python = join(ROOT, ".venv", "bin", "python3");
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, timeout: stepTimeout });
  // THE SPAWN ERROR IS CARRIED, NOT DISCARDED. A child that never started reports `status: null` and empty
  // stdout/stderr, which is indistinguishable from a child that ran and crashed silently - so a checkout with
  // no `.venv/bin/python3` printed "the drafter failed" followed by nothing at all, and finding out why took
  // hours. `error` names the reason in the child's own terms: ENOENT carries the path it could not find,
  // ETIMEDOUT the timeout it hit.
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status, error: r.error };
};

/** Why a child failed: the spawn error first, then whatever it managed to write. */
const why = (r) => [
  r.error && `${r.error.code || r.error.name}: ${r.error.message}`,
  (r.stderr || "").trim(),
].filter(Boolean).join("\n").slice(0, 600) || "(the child produced no output and no spawn error)";

/** The ids the filler reported as present-but-never-mentioned. Empty on a clean, fully specified round. */
/**
 * The ids the SCAN found. The loop's stop condition is built on these, NOT on the filler's "controls the spec never
 * mentioned" report - and the first version of this file got that wrong in a way worth recording, because it looked
 * right and reported 22 unaddressed controls on a form that was already complete.
 *
 * The spec only ever contains fields that are BLANK at draft time. So on an already-filled form the spec is nearly
 * empty, and comparing the page against it classifies every answered field as "never mentioned". That is a fine signal
 * for a human reading one round ("the drafter did not cover this"), and a useless one for a loop.
 *
 * "A NEW CONTROL APPEARED" means: present in this scan, absent from the previous one. That is what a cascade does -
 * `race` was not in the 59-control blank scan and is in the 41-control answered one - and it is what the user asked the
 * loop to wait for.
 */
function idsFrom(inventoryPath) {
  const inv = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const fields = inv.fields || inv;
  return new Set(fields.map(f => String(f.ref || f.key || "").replace(/^id:/, "")).filter(Boolean));
}

console.log(`refill_until_stable: ${frag}`);
console.log(`  rounds: at most ${maxRounds}; stops when a round reveals no NEW control\n`);

let previous = null;
let stable = false;
const fillFailures = new Map();  // ref -> the option text the filler could not find
for (let round = 1; round <= maxRounds; round++) {
  const fields = join(outDir, `refill_r${round}_fields.json`);
  const specPath = join(outDir, `refill_r${round}.spec.json`);

  const scan = run("node", [join(HERE, "inspect_ats_form.mjs"), frag, "--options", "--out", fields, "--cdp", cdp]);
  if (scan.status !== 0) {
    console.error(`round ${round}: the scan failed\n${why(scan)}`);
    process.exit(1);
  }
  const now = idsFrom(fields);
  const fresh = previous ? [...now].filter(id => !previous.has(id)) : [...now];
  const gone = previous ? [...previous].filter(id => !now.has(id)) : [];
  console.log(`--- round ${round}: ${now.size} controls (${fresh.length} new, ${gone.length} gone)`);
  for (const id of fresh.slice(0, 12)) console.log(`      + ${id}`);
  if (fresh.length > 12) console.log(`      + ... and ${fresh.length - 12} more`);

  // NO `--url`. The drafter derives `spec.target` from the URL and defaults to the one the SCANNER recorded -
  // `page.url()`, the form the browser is actually on. Passing a canonical URL here overrode it: on Esri's embed form
  // the target became `/jobs/5190253007`, the tab's URL is `?for=esri&token=5190253007`, no substring matched, and the
  // filler could not find the tab. `formUrl` is still accepted so an old command line does not break, and it is
  // deliberately ignored - the scan is the authority on where the form lives.
  const draftArgs = [join(ROOT, "src", "forms", "draft_form_spec.py"), fields, "--out", specPath,
    "--job", job || frag];
  if (resume) draftArgs.push("--resume", resume);
  if (cover) draftArgs.push("--cover-letter", cover);
  const draft = run(python, draftArgs);
  if (draft.status !== 0) {
    console.error(`round ${round}: the drafter failed\n${why(draft)}`);
    process.exit(1);
  }
  const answered = (draft.stdout.match(/"auto_answered":\s*(\d+)/) || [])[1] || "?";
  const review = (draft.stdout.match(/"needs_review":\s*(\d+)/) || [])[1] || "?";

  // THE FILL IS WHAT MAKES THE NEXT SCAN DIFFERENT. A round that fills nothing reveals nothing, which is exactly why
  // the loop must still run it: the reveal is a consequence of answering, not of scanning.
  const fill = run("node", [join(HERE, "apply_form_spec.mjs"), specPath, "--cdp", cdp]);
  // THE CHECK THAT WAS MISSING. "drafter answered N" describes the SPEC; only this says whether anything reached the
  // page. Without it a filler that could not find the tab reported success on a blank form, twice, and the loop called
  // it stable - which is how the Esri run "succeeded" with every required field empty.
  if (fill.status !== 0) {
    console.error(`\nTHE FILL FAILED IN ROUND ${round} (exit ${fill.status}). Nothing on the page was changed.`);
    // `why()` BEFORE the captured streams: a step killed for exceeding its budget exits with status null and
    // prints nothing of its own, so without the spawn error the report was "exit null" and the reason - the
    // timeout it hit - was the one thing missing.
    console.error(why(fill));
    console.error((fill.stdout || "").split("\n").slice(0, 6).join("\n"));
    console.error((fill.stderr || "").split("\n").slice(0, 6).join("\n"));
    console.error("A round that could not fill is not a round that found nothing to fill. Stopping.");
    process.exit(4);
  }
  // A FIELD THE DRAFTER ANSWERED AND THE FILLER COULD NOT SET. This is a different failure from "needs_review": the
  // value reached the spec, and the fill failed, so nothing files the field anywhere - the only record of what was
  // wanted is this line, and until now the loop discarded it. Kept per round and used after the loop stabilises.
  for (const m of (fill.stdout || "").matchAll(/FAIL\s+\S+\s+(\S+)\s+option not found:\s*(.+)/g)) {
    fillFailures.set(String(m[1]).replace(/^id:/, ""), m[2].trim());
  }
  const unmentioned = (fill.stdout.match(/never mentioned[^\n]*?(\d+)/) || [])[1];
  // Answered is the spec's size; filled is what the log says actually landed. Printing only the first is how a blank
  // form looked like progress.
  const filled = ((fill.stdout || "").match(/^\s+OK\s+/gm) || []).length;
  const failed = ((fill.stdout || "").match(/^\s+FAIL\s+/gm) || []).length;
  console.log(`    spec: ${answered} answered, ${review} needs_review | fill: ${filled} landed, ${failed} failed`
    + ` | ${unmentioned ?? "0"} unmentioned control(s)`);

  if (previous && fresh.length === 0) {
    if (gone.length === 0) {
      console.log(`\nstable after ${round} round(s): the fill revealed no control that was not already there.`);
      stable = true;
      break;
    }
    // Controls DISAPPEARING is not stability - an earlier answer can hide a branch. Keep going and re-check.
    console.log("    (controls disappeared this round; not stable yet)");
  }
  previous = now;
}

// ---- the remote lists, which the loop cannot reach by design ------------------------------------------------
//
// A react-select that fetches its options shows NOTHING until something is typed, so the filler waits for rows that do
// not exist and reports `option not found`. The drafter cannot help either: it sees no options to match its answer
// against, and files the field under "profile answer 'X' has no matching option" - which is where the VALUE for the
// tool comes from. `answer_structured_option.mjs` derives a filter from that value and verifies by equality.
const inventoryPath = join(outDir, `refill_r${Math.min(maxRounds, 99)}_fields.json`);
const reviewPath = join(outDir, "refill_r1.spec.needs_review.json");
{
  // Use the LAST round's own artefacts rather than r1's, so the values come from the most recent scan.
  let reviewFile = reviewPath;
  for (let r = maxRounds; r >= 1; r--) {
    const p = join(outDir, `refill_r${r}.spec.needs_review.json`);
    if (existsSync(p)) { reviewFile = p; break; }
  }
  let fieldsFile = null;
  for (let r = maxRounds; r >= 1; r--) {
    const p = join(outDir, `refill_r${r}_fields.json`);
    if (existsSync(p)) { fieldsFile = p; break; }
  }
  const entries = existsSync(reviewFile)
    ? (JSON.parse(readFileSync(reviewFile, "utf8")).needs_review || [])
    : [];
  const byRef = new Map();
  if (fieldsFile) {
    for (const f of (JSON.parse(readFileSync(fieldsFile, "utf8")).fields || [])) {
      byRef.set(String(f.ref || "").replace(/^id:/, ""), f);
    }
  }
  const ANSWERED = /profile answer '(.+?)' has no matching option/;
  const remote = [];
  for (const e of entries) {
    const m = ANSWERED.exec(String(e.reason || ""));
    if (!m) continue;                                   // not a value the drafter named: leave it for a person
    const bare = String(e.ref || "").replace(/^id:/, "");
    const f = byRef.get(bare);
    const recipe = (f && f.widget && f.widget.recipe) || {};
    const kind = (f && f.widget && f.widget.kind) || "";
    const options = (f && f.options) || [];
    // A REMOTE LIST: the scanner says the options come from a listbox that only exists once the control is opened or
    // typed into. Length is deliberately not the test - a 244-option native list is driven fine by the filler.
    const isRemote = recipe.open === "click control" || recipe.open === "click input or toggle"
      || (kind === "react_select" || kind === "input_combobox") && options.length === 0;
    if (isRemote) remote.push({ ref: e.ref, value: m[1], kind, n: options.length });
  }
  // ...AND THE FIELDS THE DRAFTER ANSWERED BUT THE FILL COULD NOT SET. Their value is the one the filler tried, which
  // is the value the drafter chose - so for a remote list it is exactly what the tool needs.
  for (const [bare, value] of fillFailures) {
    if (remote.some(r => String(r.ref).replace(/^id:/, "") === bare)) continue;
    const f = byRef.get(bare);
    if (!f) continue;
    const recipe = (f.widget && f.widget.recipe) || {};
    const kind = (f.widget && f.widget.kind) || "";
    const options = f.options || [];
    const isRemote = recipe.open === "click control" || recipe.open === "click input or toggle"
      || ((kind === "react_select" || kind === "input_combobox") && options.length === 0);
    if (isRemote) remote.push({ ref: bare, value, kind, n: options.length, from: "the fill log" });
  }

  if (remote.length) {
    console.log(`\n--- ${remote.length} remote list(s) the loop cannot reach; driving them with their own tool ---`);
    for (const item of remote) {
      console.log(`  ${item.ref}  (${item.kind}, ${item.n} option(s) visible)  value=${JSON.stringify(item.value)}`);
      const tool = /school/i.test(String(item.ref)) ? "answer_school.mjs" : "answer_structured_option.mjs";
      const args = tool === "answer_school.mjs"
        ? [join(HERE, tool), frag, "--id", String(item.ref).replace(/^id:/, ""), "--option", item.value, "--cdp", cdp]
        : [join(HERE, tool), frag, "--ref", item.ref, "--value", item.value, "--cdp", cdp];
      const r = run("node", args);
      if (r.status === 0) console.log(`     ok - ${tool} verified it against the control's own display`);
      else console.log(`     NOT SET by ${tool} (exit ${r.status}) - left for a person, not guessed`);
    }
  }
}

if (!stable) {
  console.log(`\nSTOPPED AT --max-rounds ${maxRounds} with controls still appearing for the first time.`);
  console.log("That is a decision this loop is not allowed to make: raise --max-rounds deliberately, or look at why");
  console.log("the form keeps creating controls. No value here was guessed, and nothing was submitted.");
  process.exit(3);
}
const final = join(outDir, "refill_final_fields.json");
console.log(`\nthe last scan is at tmp/apply/refill_r*_fields.json; the form itself was never submitted.`);
process.exit(0);
