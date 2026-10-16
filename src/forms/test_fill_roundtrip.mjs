/**
 * test_fill_roundtrip.mjs — the fixtures, driven by the REAL filler, end to end.
 *
 * `test_widget_scan.mjs` proves a shape is recognised. That is only half of what the corpus promises:
 * every shape in it was filled to completion, so every shape must be FILLABLE, and nothing was
 * checking that. A recognised-but-undrivable shape used to reach the page and quietly do nothing.
 *
 * This runs `apply_form_spec.mjs` as a child process against a private headless chromium. The filler
 * only ever talks to a CDP endpoint, so pointing it at `--cdp http://127.0.0.1:<port>` is the whole
 * trick - the user's browser on 9223 is never involved, and no test can touch it by accident.
 *
 * Nothing here presses Submit: the filler refuses a spec that asks for one, and the fixtures ship no
 * submit button to begin with.
 */
import nodeTest, { after, before } from "node:test";

// EVERY WAIT IN THIS FILE IS BOUNDED, AND THE BOUND IS THE ONE THAT CAN ACTUALLY FIRE.
//
// WHAT WAS MEASURED. A round trip would intermittently not return for eight to fifteen minutes, on a different
// test each time, while burning 16 s of CPU across 15 minutes (`real 15m25s user 0m16s`) - a BLOCKED process,
// not a slow one. Two bounds that looked like they covered it did not:
//
//   * `timeout:` below is a timer on this file's event loop, so it CANNOT fire while a synchronous child
//     (`spawnSync`) holds that loop. Measured: a test declaring `{ timeout: 5000 }` whose body blocked for 40 s
//     ran the full 40 s and reported **pass**. The 120 s budget here never stopped the very hangs it was
//     written for.
//   * Playwright's protocol calls have no timeout of their own. With the renderer frozen, `page.evaluate()` and
//     `locator.count()` had still not returned after 45 s, and passing `{ timeout: 4000 }` did not make either
//     one give up. Only `locator.click()` honours a timeout (30 s by default) - which is why the covered-control
//     case waits one out on purpose and the others did not wait out anything.
//
// So the waits that can block are bounded where they are made: `spawnBounded` for a child (asynchronous, so
// this loop stays alive, with the child named and its whole process group killed), and `withDeadline` for a page
// read (`page.evaluate` and `locator.count`). Each failure names what it was waiting on. The budgets below are
// the OUTER limit and are deliberately looser than the inner waits: an inner wait that outlives its caller is
// what produced a 13-minute hang reporting `status: null` and nothing about why.
//
// A test that finishes in ~8 s and a test that fails fast at a NAMED wait are both signal; a test that runs for
// fifteen minutes and reports "exit null" is neither.
const ROUNDTRIP_TEST_TIMEOUT_MS = 120_000; // ~8x the idle cost of the slowest case
// One filler / picker run. Measured at 3-12 s on these fixtures, and ~3.5 s for the fastest cases even with
// four suites running at once, so this is several times the slowest healthy run - and a third of the test
// budget above, which is the property that matters: a child that hangs must be stopped by ITS OWN bound and
// have room left over for the test to report it.
const SPAWN_BUDGET_MS = 40_000;
const PAGE_WAIT_MS = 15_000;               // one page round trip; Playwright's own default where it has one
// SIZED FROM A MEASUREMENT, NOT FROM AN ORDERING. These were briefly 210/180/60 on the reasoning that each
// budget must be shorter than the one waiting on it. That reasoning is about the ORDER and says nothing about
// the SIZE, and the size was wrong: the loop runs about 125 s on a quiet developer machine, so an 180 s budget
// left 30% of headroom - and on a CI runner, slower per core, it exceeded the budget and failed with
// `TIMED OUT after 180000ms waiting on: the refill loop`. A budget tight enough to fail a slower machine is
// not a guard against a hang; it is a guard against slow hardware. The order still holds (120 < 360 < 420), so
// a genuine hang is still named rather than waited on.
const LOOP_TEST_TIMEOUT_MS = 420_000;      // the loop is three steps a round: slower, so it gets its own
const LOOP_SPAWN_BUDGET_MS = 360_000;      // ...still well inside the budget above
const LOOP_STEP_BUDGET_MS = 120_000;       // the loop's own per-step limit, passed down as --step-timeout

const test = (name, fnOrOpts, maybeFn) =>
  typeof fnOrOpts === "function"
    ? nodeTest(name, { timeout: ROUNDTRIP_TEST_TIMEOUT_MS }, fnOrOpts)
    : nodeTest(name, { timeout: ROUNDTRIP_TEST_TIMEOUT_MS, ...fnOrOpts }, maybeFn);
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { browserCandidates, fixtureUrl } from "./fixture_browser.mjs";
import { spawnBounded, withDeadline } from "./bounded_waits.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(process.env.HOME || "", "Library/Caches", "ms-playwright");
const EXE = browserCandidates(CACHE)[0] || null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let chrome = null;
let profileDir = null;
let childTmp = null;
let artifactsDir = null;
let cdpUrl = null;
let connection = null;
let page = null;

/**
 * `spawnBounded` with this run's own temporary directory in the child's environment.
 *
 * EVERY CHILD THIS FILE SPAWNS ENDS WITH `process.exit(...)`, and each of them opens its own
 * `chromium.connectOverCDP()` first. Playwright makes a `playwright-artifacts-XXXXXX` directory per connection
 * and removes it from an ASYNC cleanup that a `process.exit` never reaches - measured on this machine: a child
 * that connects and exits leaves exactly one behind, the same child with an awaited `close()` leaves none, and
 * one run of three round-trip tests left three. Pointing the child's `TMPDIR` at the directory this file owns
 * contains it: the child's directory lands there and is removed by the single `rmSync` in `after()`, on every
 * path - including a child killed by its own timeout, which is the case no child-side cleanup can cover.
 *
 * The environment is otherwise the parent's, so a child that reads `TMPDIR` for anything else is unaffected;
 * it is a real, writable directory, just not the machine-wide one.
 */
const spawnChild = (cmd, args, opts) => spawnBounded(cmd, args,
  { ...opts, env: { ...process.env, ...(childTmp ? { TMPDIR: childTmp } : {}) } });

before(async () => {
  if (!EXE) return;
  // THE ONE DIRECTORY THIS FILE OWNS, AND EVERYTHING THE RUN WRITES LIVES INSIDE IT. It is the browser's
  // `--user-data-dir`, and under it go two more things that used to be left in the machine-wide temp
  // directory: the `TMPDIR` handed to every child this file spawns, and the artifacts directory the file's
  // own CDP connection is given below. That is not tidiness for its own sake - `after()` removes this one
  // directory unconditionally, including when the browser had to be killed rather than closed, so a killed
  // child and a Playwright working directory that nothing else would remove are cleaned by the same
  // `rmSync` instead of by cleanup that has to run at the right moment.
  profileDir = mkdtempSync(join(tmpdir(), "jh-fillprofile-"));
  childTmp = join(profileDir, "child-tmp");
  mkdirSync(childTmp, { recursive: true });
  artifactsDir = join(profileDir, "connection-artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const portFile = join(profileDir, "DevToolsActivePort");
  // No URL on the command line: a page handed to the process at startup can be torn down before the
  // CDP client attaches, which shows up as "target has been closed" on the first navigation.
  //
  // `--no-sandbox` is required HERE and is not a general recommendation: launched from this file
  // sandbox the renderer dies with "sandbox initialization failed: Operation not permitted", which is
  // exactly why `chromium.launch()` passes it too. It is safe in this narrow case - the browser only
  // ever opens `file://` fixtures from this repository, never a live ATS page and never 9223.
  chrome = spawn(EXE, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: "ignore" });
  for (let i = 0; i < 120 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) return;
  const [port] = readFileSync(portFile, "utf8").split("\n");
  cdpUrl = `http://127.0.0.1:${port.trim()}`;
  await sleep(400);
  // The artifacts directory is named here rather than left to Playwright's default, which is
  // `mkdtemp(join(os.tmpdir(), "playwright-artifacts-"))`: a connection that is closed on the way out removes
  // it, and one whose `close()` never resolves - the timeout this file already bounds elsewhere - does not.
  // Inside `profileDir` it is removed either way, because the removal below does not depend on the connection.
  connection = await chromium.connectOverCDP(cdpUrl, { artifactsDir });
  page = await connection.contexts()[0].newPage();   // focus-ok: the browser this test spawned itself
  // Playwright's default for the actions that HAVE a timeout (a click, a navigation). It does not cover
  // `page.evaluate`/`locator.count`, which is why those go through `withDeadline` below as well.
  page.setDefaultTimeout(PAGE_WAIT_MS);
  await resetFixture();
}, { timeout: 60_000 });

after(async () => {
  // A CLOSE IS A WAIT TOO, and this one was the last unbounded thing in the file: a browser that has stopped
  // answering makes `connection.close()` never resolve, which holds the file open AFTER every test has already
  // reported - a run that looks hung while its results are on screen. Each step gets a deadline here, and the
  // directory is still removed when the browser will not close - which is the half that also covers the
  // children's temporary directories and the connection's own, since all of them were put inside it.
  await withDeadline(connection?.close() ?? Promise.resolve(), "closing the CDP connection", 15_000).catch(() => {});
  chrome?.kill();
  await sleep(600);   // the browser keeps writing its profile for a moment after the signal
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, { timeout: 40_000 });

function ready(t) {
  if (!EXE || !cdpUrl || !page) {
    t.skip("no usable headless chromium to host the filler");
    return false;
  }
  return true;
}

/**
 * Put the fixture page back to its initial state.
 *
 * BOUNDED, because a navigation is a page round trip like any other: with the renderer unable to answer it
 * never returns, and Playwright would not notice. `catch` keeps the existing tolerance for a navigation that
 * reports an abort while still having loaded the fixture.
 */
async function resetFixture(fixture = "ats_widgets.html") {
  await withDeadline(page.goto(fixtureUrl(fixture)), `page.goto(${fixture})`, PAGE_WAIT_MS).catch(() => {});
  await page.waitForLoadState("load", { timeout: PAGE_WAIT_MS }).catch(() => {});
}

/**
 * Reset the fixture page and run the real filler against it. Returns the filler's own streams.
 *
 * ASYNCHRONOUS ON PURPOSE. This used to be `spawnSync`, which blocks this file's event loop for as long as the
 * child runs - and while it is blocked, the test's own `timeout:` cannot fire, so the child's budget was the
 * ONLY bound and a child that outran it left the test waiting on grandchildren that still held the pipe. An
 * asynchronous child lets the test's budget be real, and `spawnBounded` makes the child's timeout a named
 * failure instead of `status: null`.
 */
async function fill(spec, fixture = "ats_widgets.html") {
  await resetFixture(fixture);
  // THE SPEC DIRECTORY IS REMOVED ON EVERY PATH, THE FAILING ONE INCLUDED, and that is the one judgement in
  // this file worth arguing rather than asserting. It is the biggest source by far - 27 call sites, one
  // directory each - and a `finally` is the shape because the file has to exist on disk while the child reads
  // it, so there is no `TemporaryDirectory` to hand the job to.
  //
  // NOTHING IS KEPT FOR A FAILED RUN. Keeping the spec of the run that failed looks like a kindness to the
  // reader and is not one: the spec is written from the object literal at the call site, so the exact bytes are
  // in this file, and what says WHICH control failed is the child's own stdout/stderr, which `expectClean`
  // already prints. Keeping it would also put the litter exactly where this suite spends its time - the node
  // half times out on a different test each run, so a directory kept on failure would be a leak on nearly every
  // run, which is the behaviour this change exists to end.
  const dir = mkdtempSync(join(tmpdir(), "jh-spec-"));
  try {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const run = await spawnChild("node", [join(HERE, "apply_form_spec.mjs"), specPath, "--cdp", cdpUrl], {
      what: `the filler (apply_form_spec.mjs) on ${fixture}`,
      timeoutMs: SPAWN_BUDGET_MS,
      cwd: HERE,
    });
    // `specPath` is deliberately NOT returned: it named a file that no longer exists, and no caller - all 27
    // of them - ever read it.
    return { stdout: run.stdout, stderr: run.stderr, status: run.status, timedOut: run.timedOut };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * Assert a filler run exited clean, and say WHICH WAIT ran out when it did not.
 *
 * Without this the failure of a timed-out child is `assert.equal(null, 0)` plus whatever the child printed -
 * and a child killed for exceeding its budget prints nothing of its own, so the reader learned "exit null" and
 * nothing about the wait. `spawnBounded` puts the reason in `stderr`; this is what carries it into the message.
 */
function expectClean(run, what) {
  assert.equal(run.status, 0,
    `${what} must exit clean${run.timedOut ? " - IT TIMED OUT" : ""}:\n${run.stdout}\n${run.stderr}`);
}

/**
 * One bounded read of the fixture page.
 *
 * `page.evaluate` is the read-back every assertion here is built on, and it is the call that was MEASURED to
 * ignore a timeout: with the renderer frozen it had not returned after 45 s and `{ timeout: 4000 }` never
 * fired. Every read in this file therefore goes through here, so the wait is bounded and the failure names
 * the read rather than surfacing as a suite that never ends.
 */
const readValue = (fn, what) =>
  withDeadline(page.evaluate(fn), `reading ${what} back from the fixture`, PAGE_WAIT_MS);

const values = () => withDeadline(page.evaluate(() => {
  const out = {};
  for (const id of ["_systemfield_name", "it_number", "it_url", "it_bare", "lt_summary", "lt_typed",
    "ns_country", "ns_offices", "sprinter_yes", "sprinter_no", "eeoc_vet_0", "eeoc_vet_1", "eeoc_vet_2",
    "fu_resume"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    out[id] = el.type === "checkbox" || el.type === "radio" ? el.checked
      : el.tagName === "SELECT" ? (el.multiple ? [...el.selectedOptions].map(o => o.textContent) : el.value)
        : el.value;
  }
  return out;
}), "reading every fixture control's value back", PAGE_WAIT_MS);

test("roundtrip: text inputs of every single-line type are filled and read back", async (t) => {
  if (!ready(t)) return;
  const { status } = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [
      { ref: "id:_systemfield_name", value: "Roundtrip Candidate" },
      { ref: "id:it_number", value: "2026" },
      { ref: "id:it_url", value: "https://example.test/portfolio" },
      { ref: "id:it_bare", value: "+1 555 0100" },
    ],
  });
  const read = await values();
  assert.equal(read._systemfield_name, "Roundtrip Candidate");
  assert.equal(read.it_number, "2026", "number input");
  assert.equal(read.it_url, "https://example.test/portfolio", "url input");
  assert.equal(read.it_bare, "+1 555 0100", "the input with no type attribute");
  assert.equal(status, 0, "the filler must exit clean");
});

test("roundtrip: a textarea is filled and read back", async (t) => {
  if (!ready(t)) return;
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    textareas: [{ ref: "id:lt_summary", value: "Filled by the round-trip test." }],
  });
  const read = await values();
  assert.equal(read.lt_summary, "Filled by the round-trip test.");
});

test("roundtrip: a text answer into a type=number field is not reported as filled", async (t) => {
  if (!ready(t)) return;
  // Counsel, recorded in driving-widgets-cases-3: a compensation field is `type=number`, and a text answer
  // typed into one is dropped by the BROWSER - no error, no value. So the field stays empty while the line
  // for it reads OK, and the miss surfaces at Submit or not at all. The filler cannot make a number input
  // hold "negotiable"; what it must not do is report that the answer landed.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:it_number", value: "negotiable" }],
  });
  const landed = await readValue(() => document.getElementById("it_number").value, "#it_number");
  const line = run.stdout.split("\n").find(l => l.includes("it_number")) || "";
  assert.equal(landed, "", "a number input cannot hold text - that part is the browser, not the filler");
  assert.ok(line, `the step must appear in the log:\n${run.stdout}`);
  assert.match(line, /FAIL/, `an answer that did not land was reported as filled:\n${line}`);
});

test("roundtrip: a formatted number still lands, and the reformatting is in the log", async (t) => {
  if (!ready(t)) return;
  // The counterpart to the test above, and the reason the fix could not simply reject every number input it
  // has to clean: PermitFlow's spec wrote a compensation value as "$250,000" and Playwright throws "Cannot
  // type text into input[type=number]", aborting the whole run. Stripping symbols is the intended repair.
  // What changed is that the repair no longer reports success BEFORE the field is touched.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:it_number", value: "$250,000" }],
  });
  const landed = await readValue(() => document.getElementById("it_number").value, "#it_number");
  const line = run.stdout.split("\n").find(l => l.includes("it_number")) || "";
  assert.equal(landed, "250000", "the digits are the answer; the currency symbol is presentation");
  assert.match(line, /OK/, `a formatted number is a repair, not a failure:\n${line}`);
  assert.match(line, /250,000/, `the log should say what it did to the value:\n${line}`);
});

test("roundtrip: a react-select's inner input is blank even when the question is answered", async (t) => {
  if (!ready(t)) return;
  // driving-widgets-cases-3: "a react-select's inner input is ALWAYS blank - never use it to decide what is
  // answered". The trap cuts both ways, which is why it is worth a test rather than a sentence: the input is
  // empty when the widget is fully answered, and it holds filter text when nothing has been chosen at all.
  // Anything that reads it as the value gets a confident wrong answer in both directions, and the answer it
  // gets wrong is "this question is unanswered" on a page that has already been answered.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:school_input", option: "Fairview College" }],
  });
  const inner = await readValue(() => document.getElementById("school_input").value,
    "#school_input (the react-select inner input)");
  const shown = await readValue(
    () => document.querySelector("#school_control .select__single-value")?.textContent || "",
    "#school_control's committed display");
  assert.equal(shown, "Fairview College", "the display node is the value the widget committed");
  assert.equal(inner, "", "the inner input is not the evidence, and reading it would deny this answer");
});

test("roundtrip: a CREATABLE combobox ends up holding the option, not the filter that found it", async (t) => {
  if (!ready(t)) return;
  // Brex: the pronouns field was submitted reading `HeHeHeHeHe`. The filler's approach
  // to every react-select was "open it, type a filter, read the options, click the match" - right for a
  // pick-only select, wrong for a CREATABLE one, where the filter string does not narrow a list but BECOMES the
  // value. Five open attempts wrote `He` five times, and nothing in the pipeline caught it.
  //
  // The fixture writes the typed text into the value on every keystroke, which is the only thing that makes
  // this control distinguishable from a pick-only one: to a filler that only reads the DOM, they look identical.
  // The shape is `creatableCombobox`; the fieldset-coverage gate requires a test to name it.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:ccb_input", option: "he/him/his", search: "he" }],
  });
  const shown = await readValue(
    () => document.querySelector("#ccb_control .select__single-value")?.textContent || "",
    "#ccb_control's committed display");
  assert.equal(shown, "he/him/his",
    "the committed value is the option; the filter text that found it must not survive in the field");
});

test("roundtrip: a creatable combobox with no matching option is NOT reported as answered", async (t) => {
  if (!ready(t)) return;
  // The other half of the Brex case, and the half that actually went wrong: the list never painted
  // (`[]`, `[]`, `[]`, `[]`), so no option was ever clicked and the filter text the filler had typed stayed in
  // the field AS THE ANSWER - `He` x 5 = `HeHeHeHeHe`. Clicking an option overwrites the typed text, so the
  // test above passes on any working control; this one asks what happens when nothing is found.
  //
  // The rule driving-widgets-cases-4 states is "type once, or not at all", and its enforceable form is here: an
  // answer that did not land must be reported as failed, whatever the field happens to contain.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:ccb_input", option: "xe/xem/xyr", search: "xe" }],
  });
  const held = await readValue(
    () => document.querySelector("#ccb_control .select__single-value")?.textContent || "",
    "#ccb_control's committed display");
  const line = run.stdout.split("\n").find(l => l.includes("ccb_input")) || "";
  assert.ok(line, `the step must appear in the log:\n${run.stdout}`);
  assert.match(line, /FAIL/,
    `no option was found, so the field cannot have the answer - and what it holds is the filter text:\n${line}`);
});

test("roundtrip: a control with an id and an EMPTY name is filled, and nothing else is touched", async (t) => {
  if (!ready(t)) return;
  // DoorDash, driving-widgets-cases-3. The misdiagnosis was not "the field refused the value" - it was that the
  // click went somewhere else entirely, and the option list that appeared belonged to the phone field. So the
  // assertion is two-sided: the intended control receives the value, and a neighbour does not.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:ien_location", value: "Seattle, Washington, United States" }],
  });
  const read = await readValue(() => ({
    location: document.getElementById("ien_location").value,
    neighbour: document.getElementById("it_bare").value,
  }), "#ien_location and its neighbour #it_bare");
  assert.equal(read.location, "Seattle, Washington, United States",
    "the id is the handle, and it has to reach the control the name attribute could not");
  // The neighbour is never named in the spec, so it must still be empty. Filling it first and asserting the
  // value came back would prove nothing about spilling - the write would be mine, not the filler's.
  assert.equal(read.neighbour, "", "the fill must not have spilled into a neighbouring control");
});

test("roundtrip: an input_combobox with NO toggle is driven by pick_option", async (t) => {
  if (!ready(t)) return;
  // The last corpus shape without an end-to-end test, and the first one where the recipe and the tool
  // disagreed. `input_combobox` has two variants - with a sibling toggle and without - and only the toggled one
  // (`noRefInput`) had been driven. The corpus records `widget/v1/input_combobox/input` against `rce_country`,
  // a SPAN carrying `role=combobox` and `aria-controls` to a listbox, so the contract says it must be drivable.
  // It was not: pick_option's verdict required `tagName === "INPUT"`, fell through to the text branch, typed
  // into a span that holds no value, and then reported the container's whole text as a read-back that
  // "disagreed" with a value nothing had accepted.
  //
  // No `widget` key, deliberately: naming one sends pick_option down a branch the caller chose, and the claim
  // being tested is that it recognises this shape for itself.
  await resetFixture();
  const plan = planFile([{ id: "rce_country", option: "Canada" }]);
  const run = await spawnChild("node", [join(HERE, "pick_option.mjs"), "ats_widgets", "--file", plan, "--cdp", cdpUrl],
    { what: `pick_option on ${fixtureUrl("ats_widgets.html")}`, timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  const shown = await readValue(() => document.getElementById("rce_country").textContent.trim(), "#rce_country");
  expectClean(run, "pick_option");
  assert.equal(shown, "Canada", "the combobox's own text is the value this widget commits into");
});

test("roundtrip: a control revealed BY the fill is reported as one the spec never mentioned", async (t) => {
  // Fixture shape: `conditionalReveal` - `cr_revealed` exists in the DOM only after `cr_trigger` is answered.
  // The user's diagnosis, as an executable statement. `cr_revealed` is not in the DOM when the filler starts; filling
  // `cr_trigger` with `No` creates it. A verification that only compared against what it was asked to fill would call
  // this form clean, and the unanswered question would reach the employer as a blank required field.
  if (!ready(t)) return;
  const { stdout, status } = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:cr_trigger", value: "Roundtrip" }],
  });
  assert.equal(status, 0, "the filler must still exit clean");
  assert.match(stdout, /controls the spec never mentioned/,
    "a control that the fill brought onto the page must be reported, not passed over");
  assert.match(stdout, /cr_revealed/, "the revealed control must be named");
});

test("roundtrip: a control revealed by the fill is NOT reported once the spec covers it", async (t) => {
  // The other direction. The report must be about what the spec MISSED, not about every control the page happens to
  // have - a check that fired on a fully-specified form would be noise, and noise gets ignored.
  if (!ready(t)) return;
  const { stdout, status } = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:cr_trigger", value: "Roundtrip" }],
    selects: [{ ref: "id:cr_revealed", value: "Asian" }],
  });
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /cr_revealed\s+Please identify your race/,
    "a control the spec DID ask for must not be reported as unmentioned");
});

test("loop: refill_until_stable notices a control the fill created, then stops on its own", { timeout: 300_000 }, async (t) => {
  // THE LOOP, against the conditional-reveal fixture. `cr_revealed` is not in the DOM at the first scan; answering
  // `cr_trigger` creates it; the loop must see it appear and then decide, by itself, that it is done.
  //
  // THE TIMEOUT IS GENEROUS ON PURPOSE, BUT IT IS NOW THE OUTER OF TWO. A round is two browser passes plus a
  // subprocess, so this test is bounded by the machine rather than by the property it asserts: at ~35 s a round,
  // three rounds overran the original 110 s limit and the run was killed mid-loop, which reports a bug the code
  // does not have. The assertion is about reaching a conclusion at all - `rounds.length >= 2` and the new control
  // being seen from the second scan onward - so the budget is set to stop measuring CI speed.
  //
  // `--step-timeout` IS WHY THIS ONE CAN FAIL USEFULLY. The loop's own per-step budget used to be a literal 600 s,
  // and a step that hung sat inside it for the full ten minutes: this test's 270 s spawn limit killed the LOOP, not
  // the step, and then waited on the grandchildren that still held the pipe - a 13-minute run that reported "exit
  // null" and nothing about why. Sixty seconds is well above a step here (about 12 s) and well below the budget
  // above, so a hung step now ends inside this test's own limit and the report names the timeout it hit.
  if (!ready(t)) return;
  await resetFixture();
  const run = await spawnChild("node", [
    join(HERE, "refill_until_stable.mjs"), "ats_widgets",
    "--cdp", cdpUrl, "--max-rounds", "4", "--job", "fixture",
    "--step-timeout", String(LOOP_STEP_BUDGET_MS),
  ], { what: "the refill loop (refill_until_stable.mjs)", timeoutMs: LOOP_SPAWN_BUDGET_MS, cwd: HERE });
  const out = `${run.stdout}${run.stderr}`;

  assert.equal(run.status, 0,
    `the loop must exit clean once stable, not keep going${run.timedOut ? " - IT TIMED OUT" : ""}:\n${out}`);
  assert.match(out, /stable after/, "the loop must say it reached a stable point");
  assert.match(out, /cr_revealed/, "the control the fill created must be named by the round that saw it");
  // And the new one must be reported in a round AFTER the first, which is the whole point - a first scan cannot see it.
  const rounds = out.split(/--- round \d+:/).slice(1);
  assert.ok(rounds.length >= 2, "reaching a conclusion needs at least two scans");
  const revealedRound = rounds.findIndex(r => r.includes("cr_revealed"));
  assert.ok(revealedRound >= 1, "cr_revealed can only be seen from the second scan onward");
});

test("loop: --spec seeds every round, so the loop can start on a form it did not fill", { timeout: 300_000 }, async (t) => {
  // THE GAP THIS CLOSES, measured on a live greenhouse form. The drafter emits only the
  // controls that are BLANK at draft time, so from round 2 of the loop - and on any form an earlier run already
  // filled - an unseeded draft comes back nearly empty: on that form it returned ONE answer (the attached resume)
  // while 27 filled controls sat on the page, and the loop then declared "stable" over a spec that could not name a
  // single question. In practice that meant a human had to fill the form by hand before the loop could discover
  // anything, which is not a tool anyone can use on the application they are actually working on.
  //
  // BOTH DIRECTIONS ARE ASSERTED. Without `--spec` almost nothing lands; with it, the seeded control reaches the
  // page. A test that checked only the second would pass on a loop that ignored the flag and happened to derive the
  // field anyway.
  if (!ready(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "jh-seed-"));
  try {
    const seedPath = join(dir, "seed.spec.json");
    // `id:it_search` IS CHOSEN BECAUSE NOTHING CAN DERIVE IT. Its name is `keywords`, and no matcher in
    // `draft_form_spec.py`'s table recognises it, so the field is blank in every draft and the only thing that can
    // put a value in it is this seed. The first version of this test used `cr_trigger`, whose label reads "Name" -
    // the drafter answered it from the profile's own full name, which is the precedence working correctly, and the
    // assertion then blamed the seeding for a correct answer. A seed entry is only evidence when nothing else
    // could have produced the value.
    writeFileSync(seedPath, JSON.stringify({
      job: "fixture",
      texts: [{ ref: "id:it_search", value: "Seeded" }],
      textareas: [], selects: [], checks: [], radios: [],
    }, null, 2));

    const run = async (extra, lastSpec) => {
      await resetFixture();
      const r = await spawnChild("node", [
        join(HERE, "refill_until_stable.mjs"), "ats_widgets",
        "--cdp", cdpUrl, "--max-rounds", "1", "--job", "fixture",
        "--step-timeout", String(LOOP_STEP_BUDGET_MS),
        ...extra,
      ], { what: "the refill loop (refill_until_stable.mjs)", timeoutMs: LOOP_SPAWN_BUDGET_MS, cwd: HERE });
      // THE SPEC THE ROUND WROTE, because the loop does NOT forward the filler's log - it counts its `OK` lines and
      // prints the totals. Asserting on `OK ... id:it_search` here was asserting on a line this program never prints;
      // the filler does produce it (verified by running apply_form_spec.mjs on the same spec by hand), and what the
      // loop's own artefact shows is whether the entry was in the spec it asked the filler to run.
      let refs = [];
      try {
        const spec = JSON.parse(readFileSync(join(HERE, "..", "..", "tmp", "apply", lastSpec), "utf8"));
        refs = (spec.texts || []).map(e => e.ref);
      } catch { /* the assertion below reports the absence */ }
      return { out: `${r.stdout}${r.stderr}`, refs };
    };

    const seeded = await run(["--spec", seedPath], "refill_r1.spec.json");
    assert.ok(seeded.refs.includes("id:it_search"),
      `--spec must put the caller's answer into the round's spec; it holds ${JSON.stringify(seeded.refs)}:\n${seeded.out}`);
    assert.match(seeded.out, /\+1 from the seed \(/,
      `the loop must say the caller's spec reached the drafter, in the round it happened:\n${seeded.out}`);

    const unseeded = await run([], "refill_r1.spec.json");
    assert.ok(!unseeded.refs.includes("id:it_search"),
      `nothing can derive this control, which is the gap --spec exists to close; the unseeded spec holds `
      + `${JSON.stringify(unseeded.refs)}:\n${unseeded.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("roundtrip: a covered control reports WHAT IS ON TOP of it", { timeout: 120_000 }, async (t) => {
  if (!ready(t)) return;
  // A CLICK TIMEOUT WITH A HEALTHY BOUNDING BOX MEANS AN OVERLAY, and the check to reach for first - before any
  // theory about the form - is `document.elementFromPoint` at the control's centre. This is the
  // `coveredField` shape: a text input with a consent banner over it. Without the diagnostic the filler swallowed
  // the failure and the page read as "this widget refuses input", which is how a covered field gets diagnosed as a
  // widget bug. The note is REPORTING only - the filler still types, because a covered field is often reachable by
  // keyboard - so the assertion is on what the log says, not on whether the value landed.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "id:cvd_input", value: "Seattle" }],
  });
  const line = run.stdout.split("\n").find(l => l.includes("cvd_input")) || "";
  assert.ok(line, `the step must appear in the log:\n${run.stdout}`);
  assert.match(line, /cvd_banner|consentBanner/,
    `the note must name what is covering the field, not just that the click failed:\n${line}`);
});

test("roundtrip: an EMPTY ref aborts the run instead of typing into another field", async (t) => {
  if (!ready(t)) return;
  // Oneleet/Ashby, 2026-10-05. The drafter emitted an id-less, name-less city input as `{ref: ""}`; `locator()`
  // tried every prefix branch, found none, and fell through to `[id=""]`. Before React had hydrated that form the
  // NAME input still carried an empty id attribute, so it matched - and the acknowledgement came back "We got your
  // application, Springfield," with the candidate's CITY where his name belongs. The tool throws on an empty ref now;
  // `emptyIdField` renders the element the old fallback would have hit, so the throw has something to protect.
  //
  // Both halves matter. A non-zero exit says the run stopped; the field assertion says it stopped BEFORE typing,
  // which is the part that reached an employer.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    texts: [{ ref: "", value: "Springfield, Illinois, United States" }],
  });
  const landed = await readValue(
    () => document.querySelector('input[name="eif_name_field"]').value, 'input[name="eif_name_field"]');
  assert.notEqual(run.status, 0, `an empty ref must stop the run:\n${run.stdout}`);
  assert.equal(landed, "", "and nothing may have been typed into the field the old fallback matched");
});

test("roundtrip: set_radio PRESSES a radio that already looks checked", async (t) => {
  if (!ready(t)) return;
  // Tetsuwan/Ashby. Ashby refused the submission with "Missing entry for required
  // field: Are you legally authorized to work in the United States?" while the DOM showed that radio checked - and
  // every settled tool reported success, because they all agreed with the DOM while the framework's own state was
  // empty. `set_radio.mjs` did nothing at all there: its press was guarded by `if (!hit.r.checked)`, so a desync
  // became PERMANENT.
  //
  // The unit is the CLICK, not a change event: an already-checked radio fires none when clicked, so a
  // change-event counter would read zero for the broken tool and the fixed one alike. Two clicks is the fixed
  // behaviour - a different option first, then the wanted one - and one is the old skip's neighbour.
  // The shape is `desyncedRadioGroup`; the fieldset-coverage gate requires a test to name it.
  await resetFixture();
  const run = await spawnChild("node",
    [join(HERE, "set_radio.mjs"), cdpUrl, "ats_widgets", JSON.stringify([["desynced", "Yes"]])],
    { what: "set_radio on the desynced radio group", timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  const clicks = await readValue(() => window.__dsgClicks || 0, "the fixture's own click counter");
  expectClean(run, "set_radio");
  assert.ok(clicks >= 2,
    `a radio that already looks checked must still be pressed, twice, so the framework sees change events; got ${clicks} click(s)`);
});

test("roundtrip: an id starting with a DIGIT is addressed, not thrown on", async (t) => {
  if (!ready(t)) return;
  // Solace/Ashby: `#2067782e-...` threw `SyntaxError: not a valid selector`, because an
  // element id beginning with a digit cannot be written as a CSS id selector. ATS field ids are UUIDs and roughly
  // HALF start with a digit - the corpus's own example for the radio shape is `id:299f4d61-cec4-...` - so a tool
  // building `#${id}` breaks on half of a real form while working perfectly on a fixture that has no such id.
  //
  // This is the `digitInitialId` shape, a textarea because that is what the case's own three fields were. The
  // assertion is two-sided: the value lands, and the run exits 0 - a thrown selector is reported as a failure, not
  // as silence.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    textareas: [{ ref: "id:299f4d61-cec4-497b-8710-fc68dbcf36b4", value: "An essay answer." }],
  });
  const landed = await readValue(
    () => document.getElementById("299f4d61-cec4-497b-8710-fc68dbcf36b4").value, "the digit-initial-id textarea");
  assert.equal(landed, "An essay answer.", `the id must be addressed as [id="..."], never as #${"{"}id${"}"}\n${run.stdout}`);
});

test("roundtrip: a native select is set to the named option", async (t) => {
  if (!ready(t)) return;
  // 65 of these live in the corpus. The fixture only ever proved the fingerprint could NAME one.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:ns_country", option: "Canada" }],
  });
  const read = await values();
  assert.equal(read.ns_country, "Canada");
});

test("roundtrip: a radio group is answered by option text", async (t) => {
  if (!ready(t)) return;
  // The ref points at one row; chooseRadio walks up to the fieldset and picks the label by text.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    radios: [{ ref: "id:eeoc_vet_1", option: "I am not a protected veteran" }],
  });
  const read = await values();
  assert.equal(read.eeoc_vet_1, true);
  assert.equal(read.eeoc_vet_0, false, "and it must not select a second option in the same group");
});

test("roundtrip: a checkbox is checked, and only that one", async (t) => {
  if (!ready(t)) return;
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    checks: [{ ref: "id:sprinter_yes", checked: true }],
  });
  const read = await values();
  assert.equal(read.sprinter_yes, true);
  assert.equal(read.sprinter_no, false, "the sibling of a Yes/No pair must stay untouched");
});

test("roundtrip: a file input receives the file", async (t) => {
  if (!ready(t)) return;
  // Inside the run's own directory rather than at the top level of `$TMPDIR`, which is where this used to
  // write: the upload has to exist for as long as the filler runs, and the test hands nothing back that a
  // `finally` could remove, so the bound is the `after()` that removes the whole directory on every path.
  const dir = mkdtempSync(join(profileDir, "jh-file-"));
  const pdf = join(dir, "Resume.pdf");
  writeFileSync(pdf, "%PDF-1.4\n% fixture placeholder\n");
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    files: [{ ref: "id:fu_resume", path: pdf }],
  });
  const attached = await readValue(() => document.getElementById("fu_resume").files[0]?.name || "", "#fu_resume");
  assert.equal(attached, "Resume.pdf", "1,600 corpus fields are file inputs; the handle must accept one");
});

test("roundtrip: a resume path that does not exist is NOT reported as uploaded", async (t) => {
  if (!ready(t)) return;
  // Fieldguide, recorded in the 2026-10-01 archive: the spec pointed at a resume filename that `prepare`
  // had not written - the role slug carried `All_Levels` and the guess did not - the driver's file step
  // reported success, and only the server's "Missing entry for required field: Resume" at Submit exposed
  // it. The step decided `ok` from what the PAGE showed (files attached, the name somewhere in the text,
  // or no file input left at all) and never from whether `setInputFiles` threw, so a nonexistent path on
  // a page whose input had already been consumed reports OK.
  //
  // The assertion is on the DRIVER'S OWN VERDICT, not on the page: the page was never the thing that
  // lied. `apply_form_spec.mjs` exits 0 whatever the log says, so the line is the only evidence.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    files: [{ ref: "id:fu_resume", path: "/nonexistent/Example_Candidate_Fieldguide_Software_Engineer_Resume.pdf" }],
  });
  const line = run.stdout.split("\n").find(l => l.includes("fu_resume")) || "";
  assert.ok(line, `the file step must appear in the log:\n${run.stdout}`);
  // Both halves, because either alone can pass for the wrong reason: a log line saying FAIL would also
  // appear if the step had been skipped altogether, and an empty input says nothing about the verdict.
  const attached = await readValue(() => document.getElementById("fu_resume").files.length, "#fu_resume");
  assert.equal(attached, 0, "the path does not exist, so nothing can have been attached");
  assert.match(line, /FAIL/, `a path that does not exist was reported as uploaded:\n${line}`);
});

test("roundtrip: a react-select is set by option text", async (t) => {
  if (!ready(t)) return;
  // The menu is rendered on demand, so this only works if the filler opens the control before it
  // looks for the option - the failure mode that reads as "option not found" on a live form.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:school_input", option: "Fairview College" }],
  });
  const shown = await readValue(
    () => document.querySelector("#school_control .select__single-value")?.textContent || "",
    "#school_control's committed display");
  assert.equal(shown, "Fairview College");
});

test("roundtrip: a radio group scoped by data-field-path rather than a fieldset", async (t) => {
  if (!ready(t)) return;
  // chooseRadio resolves its scope with `ancestor::*[self::fieldset or @data-field-path][1]`. Only the
  // fieldset half was ever exercised. The fixture's group deliberately sits OUTSIDE any fieldset, so
  // the filler cannot take the fieldset branch by accident and leave this one untested.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    radios: [{ ref: "id:dfp_yes", option: "No" }],
  });
  const read = await readValue(() => ({
    yes: document.getElementById("dfp_yes").checked,
    no: document.getElementById("dfp_no").checked,
  }), "the data-field-path radio group");
  assert.equal(read.no, true, "the option named by text must be the one selected");
  assert.equal(read.yes, false, "and its sibling must not be");
});
test("roundtrip: an Ashby-style combobox with a sibling toggle is set by option text", async (t) => {
  if (!ready(t)) return;
  // The shape from TRM Labs (2026-10-02): no select__control, no <select>, just an input with
  // role=combobox and a button beside it that opens the list. Its recipe names pick_option.mjs, so if
  // the plain `selects` path drives it too, that is worth knowing rather than assuming.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:office_input", option: "Seattle", search: "Seattle" }],
  });
  const typed = await readValue(() => document.getElementById("office_input").value, "#office_input");
  assert.equal(typed, "Seattle");
});

/**
 * Write a JSON plan into a throwaway directory and return its path.
 *
 * INSIDE THE RUN'S OWN DIRECTORY, because this function cannot bound a directory of its own: it hands the path
 * to its caller and cannot know when the caller has finished with it, so there is no `finally` to write here
 * the way `fill()` can write one around its own child. At the top level of `$TMPDIR` it left a directory per
 * call - five call sites, and 290 of them had collected on this machine.
 */
function planFile(contents) {
  const dir = mkdtempSync(join(profileDir, "jh-plan-"));
  const path = join(dir, "plan.json");
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

test("roundtrip: a bare div reading SELECT... is driven by pick_option", async (t) => {
  if (!ready(t)) return;
  // This shape's recipe names pick_option.mjs, not the fill-spec path, so nothing before this proved
  // the div-dropdown widget was drivable at all. Its read-back is the control's own display node, which
  // is what the tool verifies by equality - not by `includes`, and not by a prefix slice.
  await resetFixture();
  const plan = planFile([{ id: "state_trigger", option: "Washington", widget: "div-dropdown" }]);
  const run = await spawnChild("node", [join(HERE, "pick_option.mjs"), "ats_widgets", "--file", plan, "--cdp", cdpUrl],
    { what: `pick_option on ${fixtureUrl("ats_widgets.html")}`, timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  const shown = await readValue(() => document.getElementById("state_trigger").textContent.trim(), "#state_trigger");
  expectClean(run, "pick_option");
  assert.equal(shown, "Washington", "the trigger's own text is the value this widget commits into");
});

test("roundtrip: an Ashby button pair is driven by answer_by_question_text", async (t) => {
  if (!ready(t)) return;
  // The pair has no field the spec format can hold - `extra_widgets` reports it and no filler reads
  // that - so its recipe names answer_by_question_text.mjs and the question is the only handle. This
  // is the first proof the shape is drivable, and it is what makes the `suggested_answer` the drafter
  // attaches to those rows worth anything.
  await resetFixture();
  const plan = planFile([{ match: "require visa sponsorship", answer: "yes" }]);
  const run = await spawnChild("node",
    [join(HERE, "answer_by_question_text.mjs"), "ats_widgets", "--file", plan, "--cdp", cdpUrl],
    { what: "answer_by_question_text on the Ashby button pair", timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  const checked = await readValue(() => document.getElementById("hp_box").checked, "#hp_box");
  expectClean(run, "answer_by_question_text");
  assert.equal(checked, true, "the hidden companion input carries the answer the buttons committed");
});

test("roundtrip: a native multi-select accumulates instead of overwriting", async (t) => {
  if (!ready(t)) return;
  // The corpus's last undriven shape, and it was undriven for a reason worth keeping: `selectOption` SETS the
  // selection, so two spec entries naming one `multiple` select left only the second. The old test asserted
  // that overwrite and told the next reader what to do about it - "if both options survive, give
  // native_multi_select a recipe and rewrite this test" - which is exactly what happened: the driver now adds
  // to what is already chosen, which is what the widget means. 3 fields in the corpus use this shape.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [
      { ref: "id:ns_offices", option: "Seattle" },
      { ref: "id:ns_offices", option: "New York" },
    ],
  });
  const chosen = await readValue(
    () => [...document.getElementById("ns_offices").selectedOptions].map(o => o.textContent),
    "#ns_offices' selected options");
  assert.deepEqual(chosen, ["Seattle", "New York"],
    "a multiple select keeps every option the spec asked for");
});

/**
 * Run the REAL audit against the fixture page and return its stdout, split into lines.
 *
 * The audit chooses its tab by a URL substring, and the fixture's own file name is that substring - so this is the
 * tool the smoke run used (`step7_audit.log`), not a re-implementation of it. A read-back rule is only worth
 * anything if the thing that prints the report is the thing under test.
 */
async function audit(fixture = "ats_widgets.html") {
  const run = await spawnChild("node", [join(HERE, "audit_form_fields.mjs"), fixture, "--cdp", cdpUrl],
    { what: `the audit (audit_form_fields.mjs) on ${fixture}`, timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  return { ...run, lines: String(run.stdout || "").split("\n") };
}

/** The audit's own line for one control id, or "" when it printed none. */
function auditRow(run, id) {
  return run.lines.find(l => new RegExp(`^(ok|EMPTY|INVALID)\\s+(REQ|opt)\\s+${id}\\s`).test(l)) || "";
}

/**
 * Run the REAL submission gate against the fixture page and return its own streams.
 *
 * `--dry-run` is what makes this safe to run as a test: the gate decides, prints, and stops before the submitter -
 * and it is the deciding half that is under test, so nothing is weakened by not submitting. The fixture is a page of
 * widgets, not an application, so it has no submit button to press either.
 *
 * `--allow-unruled` IS PASSED BECAUSE THE STANDING-TABLE GATE IS A DIFFERENT ASSERTION. The fixture renders six
 * yes/no pairs (splash of the shapes this project has met) and none of them is in the standing table, so the gate
 * refuses the page for that reason before `noEmptyRequired` is ever consulted - "6 yes/no pair(s) have NO RULE and
 * are UNANSWERED". That refusal is real and is tested where the table is; here it would only hide the read this file
 * is about.
 */
async function gate(expect, fixture = "ats_widgets") {
  const run = await spawnChild("node", [
    join(HERE, "verify_and_submit.mjs"), fixture, "fixture-slug",
    "--expect", JSON.stringify(expect),
    "--cdp", cdpUrl, "--dry-run", "--allow-unruled",
  ], { what: `the gate (verify_and_submit.mjs) on ${fixture}`, timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  return { ...run, stdout: String(run.stdout || "") };
}

test("roundtrip: a place typeahead is typed into, picked from its rows, and read back", async (t) => {
  if (!ready(t)) return;
  // THE CASE THAT PAID FOR THIS (greenhouse board, posting 8279799 `Technical Support Specialist`, 2026-10-14,
  // headless Chrome on port 9333). `Location (City)*` is `input#candidate-location`: a react-select combobox
  // (`class="select__input"`, `role="combobox"`, `aria-autocomplete="list"`) whose LISTBOX IS NOT IN THE DOM until
  // a query is typed into it. The drafter described it as an option list and the filler asked it for an option:
  //
  //     step7_fill.log:10  FAIL select id:candidate-location  option not found: Toronto, Ontario, Canada
  //
  // The shape is `locationTypeahead` in the fixture, whose rows are the live list's own rows for the query
  // `Toronto`, in its order - the second of which is `Toronto, Ohio, United States`, a different city in a
  // different country. The entry carries the address PARTS and the filler derives both the query to type and the
  // acceptance test from them, so a commit is only accepted when the control reads back a place naming Ontario or
  // Canada.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:candidate-location", option: "Toronto, Ontario, Canada",
                typeahead: { city: "Toronto", state: "Ontario", country: "Canada" } }],
  });
  const shown = await readValue(
    () => document.querySelector("#candidate-location-control .select__single-value")?.textContent || "",
    "#candidate-location's committed display");
  assert.equal(shown, "Toronto, Ontario, Canada", "the field must hold the place the profile names");
});

test("roundtrip: a typeahead whose list offers only namesakes commits nothing and says why", async (t) => {
  if (!ready(t)) return;
  // The half that makes the read-back worth having. The same control, the same rows, an address the list has no
  // row for: `Toronto, Newfoundland and Labrador, Nowhere`. Every row offered namesakes of the CITY (`Toronto,
  // Ohio, United States`, `Toronto, England, United Kingdom`, ...) and none names the state or country the profile
  // asked for, so the picker must commit NOTHING rather than whichever row it happened to reach first - a wrong
  // city committed silently is worse than an honest FAIL, because nothing downstream can tell the two apart.
  //
  // This is the Luma AI shape (2026-10-01) with the failure on the other side of the wire: there the bare city
  // query committed `Springfield, Newfoundland and Labrador` and the picker called it COMMITTED, because the only
  // thing it checked was the city name - which the wrong row contains too.
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:candidate-location", option: "Toronto, Newfoundland and Labrador, Nowhere",
                typeahead: { city: "Toronto", state: "Newfoundland and Labrador", country: "Nowhere" } }],
  });
  const shown = await readValue(
    () => document.querySelector("#candidate-location-control .select__single-value")?.textContent || "",
    "#candidate-location's committed display");
  const typed = await readValue(() => document.getElementById("candidate-location").value, "#candidate-location's input");
  const line = run.stdout.split("\n").find(l => l.includes("candidate-location")) || "";
  assert.ok(line, `the step must appear in the log:\n${run.stdout}`);
  assert.match(line, /FAIL/, `no row named the place, so the field cannot have been filled:\n${line}`);
  assert.match(line, /did not commit a place naming newfoundland and labrador/,
    `the failure must state the acceptance test it refused on:\n${line}`);
  assert.match(line, /The list offered: .*Toronto, Ohio, United States/,
    `and it must name the rows it was actually offered, so the next reader does not re-derive them:\n${line}`);
  assert.equal(shown, "", "nothing was committed - a namesake row must not be clicked just because it is there");
  assert.equal(typed, "", "the query text must not be left in the field looking like an answer (Brex's `He` x5)");
});

test("roundtrip: the audit reads a composite's two controls apart, and resolves a fragmented value", async (t) => {
  if (!ready(t)) return;
  // THE AUDIT'S OWN REPORT, from the same live page and the same run as the case above:
  //
  //     step7_audit.log:6  ok  REQ country  text  Country*  = +1
  //     step7_audit.log:7  ok  REQ phone    tel   Phone*    = +1
  //
  // `Country*` and `Phone*` are TWO controls inside ONE `fieldset.phone-input` (the shape is `phoneComposite`):
  // a react-select dial-code selector and the tel input beside it. Both rows reported `+1`; the phone's real value
  // (`+1 416-555-0182`) was never read. Two rules were wrong, and each had a witness here:
  //
  //   * the phone read the COUNTRY's value node, because the read fell back to the fieldset when the tel input had
  //     no `[class*=control]` ancestor of its own - a wrapper may not answer for a control inside it;
  //   * the country's value was a FRAGMENT of the option it committed. The option row says `Canada +1`
  //     (`<div class="iti__flag iti__ca"></div>Canada +1`) and the committed value node renders
  //     `<div class="iti__flag iti__ca"></div><span>+1</span>`, i.e. textContent `+1` - shared by the United
  //     States, Canada and twenty Caribbean nations. The country NAME survives in the widget's own mounted country
  //     list (`[data-country-code="ca"]` -> `Canada` + `+1`), which is what the audit resolves it from, and the
  //     element it read is recorded beside the value so the resolution is checkable.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:country", option: "Canada +1", search: "Canada" }],
    texts: [{ ref: "id:phone", value: "+1 416 555 0182" }],
  });
  const committed = await readValue(
    () => document.querySelector("#country_control .select__single-value")?.textContent || "",
    "#country's committed display");
  assert.equal(committed, "+1", "the fixture renders the fragment the live control renders - the reason this test exists");
  const run = await audit();
  const country = auditRow(run, "country");
  const phone = auditRow(run, "phone");
  assert.ok(country, `the audit must report the country control:\n${run.stdout}`);
  assert.ok(phone, `the audit must report the phone control:\n${run.stdout}`);
  assert.match(country, /=\s*Canada \+1\s/,
    `the country's committed OPTION must be reported, not the dial code alone:\n${country}`);
  assert.match(country, /\[.*iti__ca.*\]/,
    `the row must say which element the value came from, and that a fragment was resolved:\n${country}`);
  assert.match(phone, /=\s*\+1 416 555 0182\s*$/,
    `the phone must report its OWN value, not the neighbouring country control's:\n${phone}`);
});

test("roundtrip: an answer that did not land is not read back out of the wrapper beside it", async (t) => {
  if (!ready(t)) return;
  // The same rule from the other side, and the direction that costs a submission: the PHONE is empty and the
  // COUNTRY is answered. A read that falls back to the shared fieldset finds the country's value node and reports
  // the phone as answered - "every check that ran asked 'is there a value here' and answered yes" (rule 5). The
  // audit must call it EMPTY, because the employer will, and the phone number is the one thing on this widget the
  // candidate has to supply himself.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:country", option: "Canada +1", search: "Canada" }],
  });
  const run = await audit();
  const phone = auditRow(run, "phone");
  assert.ok(phone, `the audit must report the phone control:\n${run.stdout}`);
  assert.match(phone, /^EMPTY\s+REQ\s+phone\s/,
    `an empty phone whose neighbour is answered must be reported EMPTY, not borrowed:\n${phone}`);
});

test("gate: an empty Phone beside an answered Country is REFUSED, not read as +1", async (t) => {
  if (!ready(t)) return;
  // THE SUBMISSION GATE READS THE SAME WAY THE AUDIT DOES, on the widget that proved it matters. `Country*` and
  // `Phone*` are two controls inside one `fieldset.phone-input` (the shape is `phoneComposite`, read off
  // greenhouse's board 8279799 on 2026-10-14); the country's committed node renders the FRAGMENT `+1`, so a read
  // that lets a container answer for a control inside it hands an EMPTY required phone a value and the submission
  // goes out with a question the employer required left empty. That is hard rule 5 of this project's contract -
  // read the RENDERED value, not the presence of one - and it is in the path that cannot be undone.
  //
  // MEASURED, RATHER THAN ASSUMED, AND THE MEASUREMENT IS THE POINT. Before the fix this assertion PASSED: the
  // gate's own read walked five levels (`input#phone`, `div.iti`, `div.input-wrapper`, `div.text-input-wrapper`,
  // `div.phone-input__phone`) and the `fieldset.phone-input` is the SIXTH, so this shape sat exactly one hop
  // outside the defect. What the walk did read was `+1` for the phone's own `label` (the fieldset is four hops from
  // it, so the phantom was real and measurable) and `+1` for the fieldset itself - which is why the assertion below
  // is here to stay even though it passed: it is the direction a fix that reads a SHARED container, or that lifts
  // the hop bound, breaks first.
  //
  // The last two thirds assert the other direction, so that a gate which simply stopped reading display nodes could
  // not pass this file: the answered Country in the same fieldset is still seen as filled, and an element that is
  // not a control never acquires a value from its own contents.
  await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    selects: [{ ref: "id:country", option: "Canada +1", search: "Canada" }],
  });
  const committed = await readValue(
    () => document.querySelector("#country_control .select__single-value")?.textContent || "",
    "#country's committed display");
  assert.equal(committed, "+1", "the fixture renders the fragment the live control renders - the reason this test exists");

  const refused = await gate([{ kind: "noEmptyRequired", ids: ["phone"] }]);
  assert.equal(refused.status, 7,
    `the gate must refuse a form whose required phone is blank${refused.timedOut ? " - IT TIMED OUT" : ""}\n${refused.stdout}`);
  assert.match(refused.stdout, /noEmptyRequired: id phone is empty/,
    `and it must name the field it refused on:\n${refused.stdout}`);

  const neighbour = await gate([{ kind: "noEmptyRequired", ids: ["country"] }]);
  assert.equal(neighbour.status, 0,
    `the ANSWERED control of the same composite is genuinely filled and must pass, or the fix has only turned the suspicion up:\n${neighbour.stdout}`);

  // NOT A USE CASE - A MEASUREMENT. `#phoneComposite` is the fieldset, and before the fix the gate's walk gave it
  // the country's `+1` (an id that is not a control acquiring its CONTENTS as its own value); `noEmptyRequired` was
  // then satisfied for an element that has no value at all. No caller names a fieldset here, and none should: what
  // this pins is that `byId` is built from controls, which is the half of the defect that has no other witness.
  const notAControl = await gate([{ kind: "noEmptyRequired", ids: ["phoneComposite"] }]);
  assert.equal(notAControl.status, 7,
    `a fieldset holding an answered control must not read as filled itself:\n${notAControl.stdout}`);
  assert.match(notAControl.stdout, /noEmptyRequired: id phoneComposite not present/,
    `and the refusal must say the id is not a control this gate reads:\n${notAControl.stdout}`);
});

test("gate: an empty control beside an answered sibling in one wrapper is REFUSED", async (t) => {
  if (!ready(t)) return;
  // THE SAME RULE, ON THE SHAPE WHERE IT ACTUALLY BIT THE GATE - and the failing-before case for the shared rule.
  // `siblingValueLeak` is TWO react-selects inside ONE question wrapper: Greenhouse's EEO block, where `race` read
  // `No` - `hispanic_ethnicity`'s answer - on the Twitch form, 2026-10-10.
  //
  // BEFORE THE FIX, VERBATIM, against this fixture (`--expect '[{"kind":"noEmptyRequired","ids":["svl_second"]}]'`):
  //
  //     GATE PASSED (1 expectation(s))
  //     exit 0
  //
  // `#svl_second` is EMPTY (`#svl_control_b` carries no value node at all) and its wrapper carries `#svl_first`'s
  // `No` two levels up, so the gate reported a blank required field as answered - and a submission is the one step
  // this project cannot take back. With the rule shared with the audit it reads:
  //
  //     x noEmptyRequired: id svl_second is empty
  //     exit 7
  await resetFixture();
  const answered = await readValue(
    () => document.querySelector("#svl_control_a .select__single-value")?.textContent || "",
    "#svl_first's committed display");
  assert.equal(answered, "No", "the fixture's first react-select is answered and the second is not - that IS the shape");

  const refused = await gate([{ kind: "noEmptyRequired", ids: ["svl_second"] }]);
  assert.equal(refused.status, 7,
    `a blank control must not be answered by its neighbour in one question wrapper${refused.timedOut ? " - IT TIMED OUT" : ""}\n${refused.stdout}`);
  assert.match(refused.stdout, /noEmptyRequired: id svl_second is empty/,
    `and the refusal must name it:\n${refused.stdout}`);

  // The other side of the same wrapper, so a gate that stopped reading display nodes altogether cannot pass by
  // refusing both: `#svl_first` IS answered, and answering from a display node is what makes a react-select visible
  // to this gate at all (Verse, 2026-10-07: a filled form was refused as "id candidate-location is empty").
  const neighbour = await gate([{ kind: "noEmptyRequired", ids: ["svl_first"] }]);
  assert.equal(neighbour.status, 0,
    `the ANSWERED control in that wrapper must still count as filled:\n${neighbour.stdout}`);
});

test("roundtrip: pick_option refuses an option the control does not offer", async (t) => {
  if (!ready(t)) return;
  // Exit 3 is the contract that matters most: "nothing was set, record it - do not invent a value".
  // A tool that returned 0 here would let a wrong-but-plausible answer be recorded as done.
  await resetFixture();
  const plan = planFile([{ id: "state_trigger", option: "Atlantis", widget: "div-dropdown" }]);
  const run = await spawnChild("node", [join(HERE, "pick_option.mjs"), "ats_widgets", "--file", plan, "--cdp", cdpUrl],
    { what: `pick_option on ${fixtureUrl("ats_widgets.html")}`, timeoutMs: SPAWN_BUDGET_MS, cwd: HERE });
  const shown = await readValue(() => document.getElementById("state_trigger").textContent.trim(), "#state_trigger");
  assert.equal(run.status, 3,
    `an offer the control never made must not be reported as set${run.timedOut ? " - IT TIMED OUT" : ""}\n${run.stdout}\n${run.stderr}`);
  assert.notEqual(shown, "Atlantis");
});

/**
 * Every entry in `$TMPDIR` whose name starts with one of `prefixes`.
 *
 * The same measurement `scripts/run-contract-tests.sh` makes over a whole run, narrowed to the families one
 * `fill()` can reach: the spec directory it writes, and the Playwright working directory the child it spawns
 * makes for its own CDP connection.
 */
function tempEntries(prefixes) {
  return new Set(readdirSync(tmpdir()).filter(name => prefixes.some(prefix => name.startsWith(prefix))));
}

test("roundtrip: a fill leaves no directory behind in the temporary directory", async (t) => {
  if (!ready(t)) return;
  // THE ASSERTION THIS CHANGE WAS MEASURED AGAINST, in the shape the leak was found in: count the directories
  // before, run one fill, count again. On the tree this was written for it failed TWICE OVER - one `jh-spec-`
  // directory from `fill()` itself, and one `playwright-artifacts-` from the child it spawns, which ends with
  // `process.exit` and so never reaches Playwright's own cleanup. It is deliberately not the whole guard: the
  // 27 call sites and every prefix the suite touches belong to `scripts/run-contract-tests.sh`, and this is the
  // cheap proof, on the path where the fill succeeds, that the two directories a fill makes are gone.
  const WATCHED = ["jh-spec-", "playwright-artifacts-"];
  const before = tempEntries(WATCHED);
  const run = await fill({
    target: "ats_widgets",
    url: fixtureUrl("ats_widgets.html"),
    textareas: [{ ref: "id:lt_summary", value: "Filled by the round-trip test." }],
  });
  // A clean exit is what says the check is not vacuous: the spec was written, read by the child and filled
  // from, so the directory it lived in existed.
  expectClean(run, "the filler");
  const left = [...tempEntries(WATCHED)].filter(name => !before.has(name));
  assert.deepEqual(left, [], `a fill must leave nothing behind in ${tmpdir()}; it left ${left.join(", ")}`);
});

