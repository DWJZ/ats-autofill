#!/usr/bin/env node
/**
 * pick_option.mjs — THE one tool for choosing an option in a dropdown-shaped control.
 *
 * WHY THIS EXISTS. Seven scripts under src/forms/ each drive one flavour of the same interaction — pick_select_option
 * (116 uses), pick_ashby_combobox (35), answer_div_dropdown (7), ashby_combobox_by_index (3), pick_by_typing (3),
 * fill_big_autocomplete (2), pick_select_arrow (1). They were written one tenant-failure at a time and overlap almost
 * completely, so an agent facing a control that will not commit cannot tell which of the seven to reach for, and every
 * new failure produced an eighth. The field-by-field analysis behind this merge is NOT written down in this
 * repository: this line used to cite `docs/PICK_OPTION_MERGE.md`, and `docs/` holds only `CONFIGURATION.md` and
 * `RULES.md`. What that comparison concluded is this file, and what can be checked is checked here -
 * `src/forms/test_fill_roundtrip.mjs` drives this tool against the fixture shapes, and each carried-over mechanism
 * names the tenant that taught it.
 *
 * This tool is the BASE (pick_select_option.mjs) with its mechanisms CARRIED OVER rather than rewritten, plus the four
 * mechanisms that only the other scripts had, plus the one mechanism none of them had. Each carried mechanism is
 * marked at its implementation site with the tenant that taught it.
 *
 * THE TWO RULES THAT ARE THE POINT OF THE WHOLE EXERCISE:
 *
 *   1. VERIFICATION IS EQUALITY AGAINST THE INTENT, NEVER `includes` AND NEVER A PREFIX SLICE. The base compared
 *      `readBack.includes(intent.slice(0, 12))`, which is too weak. A loose `/fairview/` read-back called
 *      "Fairview College" a success for a "Lakeside State University - Fairview" answer — a FALSE CREDENTIAL on a
 *      school picker, reported as OK. Equality is the default here; a looseness is available ONLY behind the explicit
 *      --expect-decorated flag, because some Ashby rows really do render as
 *      "Lakeside State University - Fairview United States fairview.edu".
 *   2. AN EXIT CODE IS A CLAIM ABOUT THE FORM. `aria-pressed` and "the click succeeded" are never evidence — only the
 *      control's own display node is. 0 = every requested item verified · 1 = set but the read-back disagrees ·
 *      2 = usage or tab error · 3 = nothing was set, WHICH THE CALLER MUST RECORD RATHER THAN INVENT A VALUE FOR.
 *      A run that cannot verify must never exit 0.
 *
 * ORDERING CONTRACT — worth stating because it is a rule about WHEN this tool is run, not how:
 *   choose options BEFORE typing free text, and set autocompletes LAST. Committing a combobox re-renders the field set
 *   and EMPTIES TEXT ALREADY TYPED (GameChanger, Virta). A form filled in the other order silently loses answers that
 *   this tool has just verified.
 *
 * USAGE
 *   node src/forms/pick_option.mjs <url-part> --file <plan.json> [--cdp http://127.0.0.1:9223]
 *
 *   node src/forms/pick_option.mjs <url-part>
 *     ( --id X | --label "Prefix" | --label-regex "re" | --question "^re" | --index 3 | --index empty )
 *     --option "Exact text" [--option-regex "re"]
 *     [--widget auto|react-select|ashby-combobox|div-dropdown|input]
 *     [--expect-label "<regex>"] [--query Q --query Q2 …] [--rowsOnly] [--dry-run] [--json]
 *     [--open auto|click|arrowdown|type|toggle] [--open-at control|input]
 *     [--match exact|regex] [--commit mouse|enter|tab|keyboard] [--scroll-rows]
 *     [--verify auto|display|container|input|combobox] [--expect-decorated]
 *
 * EXACTLY ONE addressing flag, and --file may not be combined with any of them (the plan carries its own addressing
 * per item). Everything contradictory exits 2 with a message rather than guessing.
 *
 * plan.json — one object per control, the pick_select_option shape plus the flags above:
 *   [
 *     { "label": "School", "option": "Lakeside State University - Fairview", "query": "fairview" },
 *     { "id": "start-year--0", "option": "2025", "kind": "input" },
 *     { "question": "^Are you willing to work from the office", "option": "Yes", "widget": "div-dropdown" }
 *   ]
 *
 * EXIT CODES
 *   0  every requested item was verified, by equality, against the control's own display node
 *   1  at least one item was set but its read-back disagrees (the dangerous case: a value went in and is wrong),
 *      or a regex chose among several equally matching rows — the tool will not call an ambiguous pick a success
 *   3  at least one item was NOT set — no row was ever committed, or no query rendered one, or the addressed control
 *      did not exist / was not the widget that was asked for. Record it; do not invent a value
 *   2  usage error, no tab matches <url-part>, or the --expect-label guard failed (the control under that address is
 *      not the question the caller meant — nothing was pressed, and nothing before it needs re-running by hand)
 */
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { DEFAULT_WAIT_MS, boundedPage } from "./bounded_waits.mjs";

// ---------------------------------------------------------------------------------------------------------------
// 1. Arguments. Unknown flags and contradictory combinations must exit 2 with a message — a picker that silently
//    ignores a flag is a picker that picks the wrong thing while reporting success (the TRM Labs / Rula failure was
//    exactly a mis-keyed plan entry, not a broken page).
// ---------------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const BOOL_FLAGS = new Set(["rowsOnly", "dry-run", "json", "scroll-rows", "expect-decorated", "help"]);
const VALUE_FLAGS = new Set([
  "id", "label", "label-regex", "question", "index", "option", "option-regex", "widget", "expect-label",
  "query", "open", "open-at", "match", "commit", "verify", "cdp", "file",
]);
const REPEATABLE = new Set(["query"]);
const USAGE = `usage: pick_option.mjs <url-part> --file <plan.json> [--cdp <url>]
       pick_option.mjs <url-part> (--id X | --label "Prefix" | --label-regex "re" | --question "^re" | --index 3 | --index empty)
         --option "Exact text" [--option-regex "re"]
         [--widget auto|react-select|ashby-combobox|div-dropdown|input]
         [--expect-label "<regex>"] [--query Q --query Q2 …] [--rowsOnly] [--dry-run] [--json]
         [--open auto|click|arrowdown|type|toggle] [--open-at control|input]
         [--match exact|regex] [--commit mouse|enter|tab|keyboard] [--scroll-rows]
         [--verify auto|display|container|input|combobox] [--expect-decorated]`;
const die = (msg) => { console.error(msg); console.error(`\n${USAGE}`); process.exit(2); };

const flags = new Map();
const bools = new Set();
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(2); }
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) { bools.add(name); continue; }
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${JSON.stringify(a)} — refusing to guess what it meant.`);
    const val = argv[i + 1];
    // A value flag whose value is missing, empty, or another flag is a typo, and a typo here picks the wrong control.
    if (val === undefined || val === "" || val.startsWith("--")) die(`--${name} needs a value.`);
    if (!flags.has(name) || REPEATABLE.has(name)) flags.set(name, REPEATABLE.has(name) ? [...(flags.get(name) || []), val] : val);
    i++;
    continue;
  }
  positionals.push(a);
}
const opt = (name, dflt = undefined) => (flags.has(name) ? flags.get(name) : dflt);
const urlPart = positionals[0];
if (positionals.length > 1) die(`expected one <url-part>, got ${positionals.length}: ${JSON.stringify(positionals)}`);
if (!urlPart) die("no <url-part> — this tool drives an existing tab and will not open one (opening a tab steals focus).");
const cdp = opt("cdp", "http://127.0.0.1:9223");
const planPath = opt("file");
const rowsOnly = bools.has("rowsOnly");
const dryRun = bools.has("dry-run");
const asJson = bools.has("json");
const scrollRows = bools.has("scroll-rows");
const expectDecorated = bools.has("expect-decorated");

const ADDRESSING = ["id", "label", "label-regex", "question", "index"];
const given = ADDRESSING.filter((f) => flags.has(f));
if (planPath && given.length) die(`--file carries its own addressing key per item; drop ${given.map((f) => `--${f}`).join(" / ")}.`);
if (!planPath && given.length === 0) die("no addressing flag — say which control with --id, --label, --label-regex, --question or --index.");
if (!planPath && given.length > 1) die(`more than one addressing flag (${given.map((f) => `--${f}`).join(", ")}) — they disagree; pass exactly one.`);
if (dryRun && rowsOnly) die("--dry-run and --rowsOnly contradict each other: --dry-run does not open a control at all.");
// --rowsOnly with a plan reads every control in the plan and commits nothing: allowed, and the usual way an unnamed or
// non-obvious question's options get read (the honest row among look-alikes is usually the longer, more specific one).

const enums = {
  widget: ["auto", "react-select", "ashby-combobox", "div-dropdown", "input"],
  open: ["auto", "click", "arrowdown", "type", "toggle"],
  match: ["exact", "regex"],
  commit: ["mouse", "enter", "tab", "keyboard"],
  verify: ["auto", "display", "container", "input", "combobox"],
};
for (const [flagName, allowed] of Object.entries(enums)) {
  const v = opt(flagName);
  if (v !== undefined && !allowed.includes(v)) die(`--${flagName} takes ${allowed.join("|")}, not ${JSON.stringify(v)}.`);
}
const openAt = opt("open-at", "control");
if (!["control", "input"].includes(openAt)) die(`--open-at takes control|input, not ${JSON.stringify(openAt)}.`);
if (opt("index") !== undefined && !/^\d+$/.test(String(opt("index"))) && opt("index") !== "empty") {
  die(`--index takes a number or "empty", not ${JSON.stringify(opt("index"))}.`);
}
if (!planPath && !opt("option") && !opt("option-regex")) die(`no --option (or --option-regex) — nothing to choose for this control.`);
// With --file the options live on the plan items, and each missing one is reported per item below (with the item's
// index) rather than as one anonymous usage line.

// ---------------------------------------------------------------------------------------------------------------
// 2. Connect to the ALREADY-RUNNING project browser and find the tab. This never opens, activates or focuses a tab:
//    the project's rule is that a driver must not steal the user's focus, and a control on a background tab is driven
//    through its own CDP session. No page.bringToFront(), no page.focus(), no context.newPage() — ever.
// ---------------------------------------------------------------------------------------------------------------
const browser = await chromium.connectOverCDP(cdp);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => (p.url() || "").includes(urlPart));
// `page` is the tab this run found; `bounded` is the same page with the two calls that have no working
// timeout of their own wrapped (see bounded_waits.mjs). This tool reads the page with `evaluate` a dozen times
// per item, so a renderer that stops answering must end the run with a named reason rather than blocking its
// caller until the caller's own budget expires - which is what a caller sees as `status: null`.
const bounded = boundedPage(page, "pick_option", Number(process.env.ATS_FORM_TIMEOUT_MS || DEFAULT_WAIT_MS));
if (!page) {
  const seen = pages.map((p) => (p.url() || "(blank)").slice(0, 90));
  console.error(`no tab matching ${JSON.stringify(urlPart)}. ${pages.length} tab(s) open:`);
  for (const u of seen) console.error(`  ${u}`);
  console.error("this tool never opens a tab; open one with src/forms/cdp_tabs.mjs if it is genuinely missing.");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Plan items. The single-item CLI is turned into a one-item plan so both paths share every mechanism below.
// ---------------------------------------------------------------------------------------------------------------
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").normalize("NFC").trim();
const low = (s) => norm(s).toLowerCase();
const PLACEHOLDER = /^(select\.{2,}|select \.\.\.|select an option|select one|choose|choose\.{3}|-+ ?select ?-+)$/i;

/**
 * THE COMPARISON. Equality against the intent, by default. The ONLY looseness is --expect-decorated, which allows the
 * read-back to CONTAIN the intent because some Ashby rows append location and domain to the option text
 * ("Lakeside State University - Fairview United States fairview.edu"). `includes` and `startsWith` are otherwise
 * not offered: the base's `readBack.includes(intent.slice(0, 12))` reported success for "Fairview College" when the
 * answer was "Lakeside State University - Fairview" — a false credential read back as OK.
 */
function compareIntent(readBack, intent, decorated) {
  const a = low(readBack), b = low(intent);
  if (!b) return false;
  if (PLACEHOLDER.test(a)) return false;          // "Select..." is the absence of a value, not a value
  if (a === b) return true;
  if (decorated && a.includes(b)) return true;
  return false;
}
const compare = compareIntent;

let plan;
if (planPath) {
  let raw;
  try { raw = await readFile(planPath, "utf8"); } catch (e) { die(`cannot read --file ${planPath}: ${e.message}`); }
  try { plan = JSON.parse(raw); } catch (e) { die(`--file ${planPath} is not JSON: ${e.message}`); }
  if (!Array.isArray(plan)) die(`--file ${planPath} must hold a JSON array of items, one per control.`);
  if (!plan.length) die(`--file ${planPath} is an empty array — there is nothing to pick, and exiting 0 would claim otherwise.`);
  plan = plan.map((item, n) => ({ ...item, _n: n }));
} else {
  const indexRaw = opt("index");
  plan = [{
    ...(opt("id") !== undefined ? { id: opt("id") } : {}),
    ...(opt("label") !== undefined ? { label: opt("label") } : {}),
    ...(opt("label-regex") !== undefined ? { labelRegex: opt("label-regex") } : {}),
    ...(opt("question") !== undefined ? { question: opt("question") } : {}),
    ...(indexRaw !== undefined ? { index: indexRaw } : {}),
    option: opt("option"),
    ...(opt("option-regex") !== undefined ? { optionRegex: opt("option-regex") } : {}),
    ...(opt("widget") !== undefined ? { widget: opt("widget") } : {}),
    ...(opt("expect-label") !== undefined ? { expectLabel: opt("expect-label") } : {}),
    ...(flags.has("query") ? { query: flags.get("query") } : {}),
    ...(opt("open") !== undefined ? { open: opt("open") } : {}),
    ...(opt("commit") !== undefined ? { commit: opt("commit") } : {}),
    ...(opt("verify") !== undefined ? { verify: opt("verify") } : {}),
    _n: 0,
  }];
}
// Per-item defaults that are global flags on the CLI. --rowsOnly / --dry-run / --json are CLI-only on purpose: a
// plan item may not decide for itself to skip committing, because that is the kind of key a mis-keyed plan hides in.
for (const item of plan) {
  // VALIDATE EVERY ITEM BEFORE THE FIRST ONE IS TOUCHED. A missing option used to be discovered in the middle of a
  // run, after earlier items had already been committed — a half-answered form plus a confused report. Worse, an item
  // with `option: undefined` reached the input path, which typed the STRING "undefined" into a live field. A form this
  // tool writes to is a real application; a bad item must stop the run before anything is pressed.
  if (item.option === undefined && item.optionRegex === undefined && !rowsOnly && !dryRun) {
    console.error(`plan item ${item._n} (${item.label || item.id || item.question || "?"}): no "option" `
      + `(or "option_regex") — nothing to choose.`);
    process.exit(2);
  }
  if (item.rowsOnly) {
    console.error(`plan item ${item._n} carries "rowsOnly": that is a global CLI flag now (--rowsOnly), never a plan key, `
      + "so that a plan cannot quietly skip committing. Remove the key and pass --rowsOnly.");
    process.exit(2);
  }
  if (item.query !== undefined && !Array.isArray(item.query)) item.query = [item.query];
  // ACCEPT THE OLD KEY NAMES AND SAY SO. pick_ashby_combobox anchored on `match` and crashed with
  // "Cannot read properties of undefined (reading 'slice')" when handed a plan keyed with `q`, which reads as a broken
  // tool rather than a mis-keyed plan.
  if (!item.id && !item.label && !item.question && !item.labelRegex && item.index === undefined) {
    const alias = item.match ?? item.q ?? item.selector;
    if (typeof alias === "string" && alias) {
      item.question = alias;
      console.error(`plan item ${item._n}: no addressing key; reading the legacy key ${JSON.stringify(alias)} as --question.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Locate / measure / open / read — carried over from pick_select_option.mjs, with the four ported mechanisms.
// ---------------------------------------------------------------------------------------------------------------

/**
 * MARK AND SCROLL ONLY — NEVER MEASURE HERE.
 * scrollIntoView is asynchronous, so a getBoundingClientRect() in the same evaluate returns the PRE-scroll position.
 * Discord's three authorisation questions sat at top = -673 (above the viewport), the stale measurement was handed to
 * page.mouse.click(), and a click at a negative y does nothing at all — which is why those three never opened while
 * the EEO questions, already on screen, worked by luck. Every measurement in this file is a separate evaluate after a
 * settle delay. Do not merge them back.
 *
 * The address probes run in this order and the FIRST one that finds anything wins, so a plan cannot silently match by
 * a weaker rule than the addressing flag it passed.
 */
const locate = (item) =>
  bounded.evaluate(({ id, label, labelRegex, question, index, widget }) => {
    const normTxt = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? el : null;
    };
    for (const old of document.querySelectorAll("[data-ats-pick], [data-ats-trigger], [data-ats-toggle], [data-ats-rowbox]"))
      old.removeAttribute(old.hasAttribute("data-ats-pick") ? "data-ats-pick"
        : old.hasAttribute("data-ats-trigger") ? "data-ats-trigger"
        : old.hasAttribute("data-ats-toggle") ? "data-ats-toggle" : "data-ats-rowbox");

    // ---- addressing ---------------------------------------------------------------------------------------
    let probe = null;
    let addressed = "";
    if (id) {
      probe = vis(document.getElementById(id));
      addressed = `id=${id}`;
    } else if (index !== undefined) {
      // PORTED from ashby_combobox_by_index: address by the Nth VISIBLE combobox, because an id-less Ashby
      // combobox (Benchling "U.S. Work Authorization Status") cannot be reached by its question text at all.
      const all = [...document.querySelectorAll('input[role="combobox"], input[aria-autocomplete="list"]')].filter(vis);
      const want = index === "empty" ? all.filter((e) => !(e.value || "").trim()) : all;
      const n = index === "empty" ? 0 : Number(index);
      probe = want[n] || null;
      addressed = index === "empty"
        ? `index=empty -> #${probe ? all.indexOf(probe) : "-"} of ${all.length}`
        : `index=${n} -> ${probe ? "found" : `missing (${all.length} visible combobox${all.length === 1 ? "" : "es"})`}`;
    } else if (label || labelRegex || question) {
      const rx = labelRegex ? new RegExp(labelRegex, "i") : null;
      const prefixes = label ? label.toLowerCase() : null;
      const startsRx = question ? new RegExp(question, "i") : null;
      const cap = widget === "ashby-combobox" ? 400 : widget === "div-dropdown" ? 300 : 900;
      // PICK THE TIGHTEST MATCHING CONTAINER, NOT THE FIRST. querySelectorAll returns document order, which is
      // pre-order, so an ANCESTOR always comes before its descendants. A wrapper div whose text happens to begin with
      // the question therefore matched first, and the control was then taken with querySelector() from inside that
      // wrapper — which can be a DIFFERENT question's select. That is the Affirm failure: the sponsorship question's
      // list never opened because the click went to the wrong control.
      let best = null;
      for (const el of document.querySelectorAll("label, div, span, p, legend, fieldset, section, li")) {
        const t = normTxt(el.innerText);
        if (!t) continue;
        const hit = prefixes ? t.toLowerCase().startsWith(prefixes)
          : rx ? rx.test(t)
          : startsRx ? startsRx.test(t) : false;
        if (!hit || t.length > cap) continue;
      // THREE CONTAINER SHAPES, IN THE ORDER THE WIDGETS ARE ENCOUNTERED IN THE WILD. An Ashby combobox renders as
      // this label line, then `div._fieldEntry_…` holding the `input[role=combobox]` AND its sibling toggle button, so
      // probing for the input by CSS alone finds the input and the toggle is then invisible to the climb below — which
      // is how the [class*="toggleButton"] opener silently degrades back to "click the input and hope".
      const ctl = el.querySelector('[class*="select__control"]');
      const combo = el.querySelector('input[role="combobox"], input[aria-autocomplete="list"]');
      // ASHBY'S REAL MARKUP, WHICH NO ROLE OR CLASS SELECTOR FINDS. Measured live on Spur's form (2026-10-05): the
      // option dropdown is a plain `input.ashby-application-form-input` inside `div._fieldEntry_…`, with a sibling
      // `[class*="toggleButton"]` that opens the list — the input itself carries NO role=combobox and NO
      // aria-autocomplete, so pick_ashby_combobox's own selector (`input[role="combobox"]`) would not have matched it
      // either. What marks the widget is the BUTTON BESIDE IT, so a container that holds a toggleButton is addressed
      // as its combobox input. Without this, `--label`/`--question` cannot reach an Ashby option field at all and the
      // only way in is the id — which is what the index script existed to work around.
      const toggleHost = el.querySelector('[class*="toggleButton"]');
      const comboBesideToggle = toggleHost && el.querySelector("input");
      // WALK UP FROM THE MATCH TO THE FIELD THAT HOLDS IT — the base's own shape, and the only one that reaches Ashby's
      // real markup. A `div._fieldEntry_…` reports an EMPTY innerText on the live page (measured on Spur), so its text
      // never contains the label and the container query can never return it; what does contain the label is the label
      // line and the section AROUND it. Taking the input inside the tightest such container is what makes --label and
      // --question reach a plain Ashby field. The 400-char cap keeps a section holding several fields out: a container
      // that aggregates other controls is the form, not a question.
      const ownInputs = [...el.querySelectorAll("input")];
      const tightInput = ownInputs.length === 1 && t.length <= 400 ? ownInputs[0] : null;
      const fieldEntry = el.className && typeof el.className === "string" && /fieldEntry|field-entry/.test(el.className)
        ? ownInputs : [];
      const singleInput = fieldEntry.length === 1 ? fieldEntry[0] : tightInput;
      // THE BARE `SELECT...` DIV TRIGGER IS ALWAYS A CANDIDATE. It used to be probed only when `--widget div-dropdown`
      // was passed, so `--question "Are you willing to work from the office"` — the exact invocation
      // answer_div_dropdown.mjs took — found nothing at all, and the widget could only be reached by a flag the caller
      // had no way to know was needed. Detection belongs in detection, not in the address.
      const selectTrigger = [...el.querySelectorAll("div,button,span")]
        .find((x) => /^select\.{3}$/i.test(normTxt(x.textContent)) && !x.children.length);
      const node = ctl || combo || comboBesideToggle || singleInput || selectTrigger;
      if (!node) continue;
      // The tightest container is the one with the shortest text that still contains the question. For a nested
      // container (label line outside, field entry inside) the SHORTEST text is the field entry itself, which is where
      // the combobox and its toggle live — so the raw node, not a container that also holds other questions.
      if (!best || t.length < best.len) best = { el: node, container: el, len: t.length, text: t.slice(0, 120) };
      }
      const how = labelRegex ? "label-regex" : label ? "label" : "question";
      const what = String(labelRegex || label || question);
      if (best) probe = vis(best.el);
      addressed = `${how}=${JSON.stringify(what.slice(0, 44))}`;
    }

    if (!probe) return { found: false, addressed };

    // ---- widget detection ---------------------------------------------------------------------------------
    // Figma: the id sits on a THREE-PIXEL-WIDE hidden input; the thing a human clicks is the enclosing
    // select__control, and only that element opens anything.
    const ctl = probe.closest && probe.closest('[class*="select__control"]');
    const inSelect = Boolean(ctl) || Boolean(probe.querySelector && probe.querySelector('[class*="select__control"]'));
    // PORTED from pick_ashby_combobox: the toggle is a SIBLING of the input. Its reach is what the old detection relied
    // on without saying so; here the climb stops at the first ancestor that already holds one — AND THAT ANCESTOR MUST
    // HOLD ONLY THIS FIELD. A bare `closest("div,section,form")` climbs to whatever section wraps the control, and a
    // form with two dropdown fields then lends one field's toggle BUTTON to the other: on the fixture that turned the
    // `SELECT...` div dropdown into an "ashby-combobox" and it was reported as a widget mismatch instead of being
    // driven. One input inside the root is what makes a toggle belong to the control in hand.
    const isToggle = (el) => el && el.className && typeof el.className === "string" && el.className.includes("toggleButton");
    const ownsOneField = (el) => el && el.querySelectorAll("input, textarea, select").length <= 1;
    let probeRoot = (ctl && ctl.parentElement) || probe.parentElement || probe;
    for (let i = 0; i < 4 && probeRoot && !isToggle(probeRoot)
      && !(probeRoot.querySelector('[class*="toggleButton"]') && ownsOneField(probeRoot)); i++) probeRoot = probeRoot.parentElement;
    if (!probeRoot) probeRoot = probe;
    const toggleBtn = isToggle(probe) ? probe
      : (probeRoot && ownsOneField(probeRoot) ? probeRoot.querySelector('[class*="toggleButton"]') : null);
    // A wrapper that already holds a control is never marked: leaving a stale mark on an ancestor is what made the read
    // report a container's whole text instead of the control's own value.
    const noClobber = [
      "input", "textarea", "select", "button", "[role='combobox']", "[role='listbox']", "[role='option']",
      '[class*="select__control"]', '[class*="toggleButton"]',
    ].join(", ");
    const leave = (node) => { for (const m of node.querySelectorAll("[data-ats-pick], [data-ats-trigger], [data-ats-toggle]")) if (!m.matches(noClobber)) m.removeAttribute("data-ats-pick"); };
    const isComboInput = (el) => el && el.tagName === "INPUT"
      && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list");
    // ASHBY'S BLANK TEXT FIELDS SHARE THE COMBOPOPUP ROLE AND PLACEHOLDER WITH ITS OPTION PICKERS — on this very form
    // "LinkedIn" and "Desired work location" render identically until the toggle button gives one of them away. That is
    // why the discriminating test is the SIBLING BUTTON and the empty value, never the role on its own.
    let kind;
    if (probe.tagName === "INPUT" && probe.getAttribute("role") === "combobox" && !(probe.value || "").trim()) kind = "combobox";
    // A `[role="combobox"]` THAT IS NOT AN INPUT IS STILL A COMBOBOX. `ats_widgets.html`'s `rce_country` is a span
    // carrying the role with `aria-controls` to a listbox, and the corpus records `widget/v1/input_combobox/input`
    // against exactly that fixture - so the recipe named this tool for a shape the tool could not drive. Without
    // this branch it fell through to the text verdict below and TYPED into a span: a span holds no value, nothing
    // changed, and the read-back reported the container's whole text ("Country United States United States") as
    // though a value had gone in and disagreed. Only `role`, never a tag, is what the scanner uses either.
    else if (probe.tagName !== "INPUT" && probe.getAttribute("role") === "combobox") kind = "combobox";
    else if (isComboInput(probe)) kind = "input";                                 // a filled combo input is typed into, not picked
    else if (inSelect) kind = "react-select";
    else {
      // A `SELECT...` leaf that IS the probe is trigger enough: `.closest("div,fieldset,section,li")` on the probe
      // returns the probe itself, which holds no descendants, so the container test alone reported the div dropdown as
      // a plain input and the tool refused to drive the one widget class answer_div_dropdown.mjs existed for.
      const selfTriggers = probe.children.length === 0 && /^select\.{3}$/i.test(normTxt(probe.textContent));
      const cont = probe.closest("div,fieldset,section,li") || probe.parentElement;
      if (selfTriggers || (cont && [...cont.querySelectorAll("div,button,span")].some((x) => /^select\.{3}$/i.test(normTxt(x.textContent)) && !x.children.length))) kind = "div-dropdown";
      else kind = "input";
    }
    // A react-select's own input also carries role=combobox, so the wrapper wins over the input's own role.
    if (kind === "input" && inSelect) kind = "react-select";
    // Ashby's toggle is the discriminator: without it a widget is a bare combobox, with it, it is Ashby's own. It also
    // outranks the plain-input verdict, because a field that ships a dropdown BUTTON is a field whose answer must be
    // chosen from the list — typing the text in and calling it verified is how "Fairview College" gets recorded for a
    // "Lakeside State University - Fairview" answer.
    if (toggleBtn && (kind === "combobox" || kind === "ashby-combobox" || kind === "input")) kind = "ashby-combobox";

    if (widget && widget !== "auto" && widget !== "input" && widget !== kind) {
      return { found: false, addressed, mismatch: `addressed control is a "${kind}", not a "${widget}"` };
    }

    // ---- the element that gets clicked (data-ats-pick) ------------------------------------------------------
    const pickTarget = kind === "react-select" ? (ctl || probe) : probe;
    if (pickTarget.querySelector("input")) leave(pickTarget);
    pickTarget.setAttribute("data-ats-pick", "1");
    // --open-at input needs a real input: the marked element for react-select is the wrapper, and clicking the wrapper
    // can focus an outer div instead of the field (observed on Discord: focus landed on a different question's input).
    const inputTarget = probe.tagName === "INPUT" ? probe
      : (pickTarget.querySelector("input") || (probe.querySelector && probe.querySelector("input")));
    if (inputTarget) inputTarget.setAttribute("data-ats-trigger", "1");
    if (toggleBtn) toggleBtn.setAttribute("data-ats-toggle", "1");

    // Ashby rows hang under the combobox's own container, so that is the row scope (ported from pick_ashby_combobox).
    if (kind === "ashby-combobox" || kind === "combobox") {
      const cont = probe.closest('div,fieldset,section') || probe.parentElement;
      if (cont && !cont.querySelector("input:not([data-ats-trigger])")) cont.setAttribute("data-ats-rowbox", "1");
    }
    pickTarget.scrollIntoView({ block: "center" });
    return { found: true, kind, addressed, text: normTxt(probe.innerText).slice(0, 90) };
  }, {
    id: item.id, label: item.label, labelRegex: item.labelRegex, question: item.question,
    index: item.index, widget: item.widget,
  });

/** Measure the marked control AFTER its scroll has settled. Separate evaluate — see locate()'s comment. */
const measure = (which = "pick") =>
  bounded.evaluate((sel) => {
    const el = document.querySelector(`[data-ats-${sel}]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { x: 0, y: 0, onScreen: false, zero: true };
    return {
      x: Math.round(r.x + Math.min(r.width, 200) / 2),
      y: Math.round(r.y + r.height / 2),
      onScreen: r.top >= -4 && r.top <= window.innerHeight - 4 && r.width > 0 && r.height > 0,
    };
  }, which);

/**
 * Read the --expect-label guard: the control's nearest understandable ancestor label must match the regex.
 * PORTED from fill_big_autocomplete's `--label-fragment` guard, which exists because an id can point at a control that
 * IS NOT the question you think it is; committing there is a wrong answer with a success report.
 */
const labelGuard = (re) =>
  bounded.evaluate((pattern) => {
    const el = document.querySelector('[data-ats-pick], [data-ats-trigger]');
    if (!el) return { ok: false, label: "(no marked control)" };
    let w = el, label = "";
    for (let k = 0; k < 8 && w; k++) {
      const l = w.querySelector ? w.querySelector("label,legend,[class*='label']") : null;
      const t = l ? (l.innerText || "").replace(/\s+/g, " ").trim() : "";
      if (t) { label = t; break; }
      const own = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (own.length > 15) { label = own; break; }
      w = w.parentElement;
    }
    return { ok: new RegExp(pattern, "i").test(label), label: label.slice(0, 140) };
  }, re);

/**
 * SCOPE THE ROW READ TO THE CONTROL'S OWN LISTBOX.
 * Every react-select on a page can share ONE listbox element, so a page-wide read returns whatever list was opened
 * last: on Discord that made four different questions all report the same ["Yes","No"] pair and made
 * "How did you hear about this job" report the 200-entry university list belonging to School. Worse, on Duolingo a
 * page-wide search for a row reading "Yes" clicked ANOTHER question's committed "YES".
 *
 * Resolution order, and the fallback is the LAST listbox on the page, not the first: aria-controls/aria-owns →
 * nearest [role=listbox] → page-wide last. Never a page-wide [role=option] read.
 */
const rowsScoped = () =>
  bounded.evaluate(() => {
    // SHADOW-AWARE. The mark this tool sets and the popup it opens can both live inside shadow roots
    // (SmartRecruiters' One-Click UI), where document.querySelector and getElementById see nothing at all - which is how
    // the tool reported "0 option(s)" on a popup that visibly held "Springfield, IL, US".
    const deepQuery = (sel, root = document) => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        const found = deepQuery(sel, el.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    const deepById = (id, root = document) => {
      const hit = root.getElementById ? root.getElementById(id) : null;
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        const found = deepById(id, el.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    const marked = deepQuery("[data-ats-pick]");
    const normTxt = (s) => (s || "").replace(/\s+/g, " ").trim();
    const shape = (o) => {
      const r = o.getBoundingClientRect();
      const box = o.closest && o.closest('[role="listbox"]');
      const br = box ? box.getBoundingClientRect() : null;
      return {
        t: normTxt(o.innerText), x: Math.round(r.x + Math.min(r.width, 200) / 2),
        y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
        top: r.top, listTop: br ? br.top : null, listBottom: br ? br.bottom : null,
      };
    };
    const onScreen = (o) => {
      if (!(o.t && o.w > 40 && o.h > 8 && o.h < 120 && o.y > 0 && o.y < window.innerHeight)) return false;
      // AND INSIDE ITS OWN SCROLLING LIST. A 40-row menu whose height is 120px renders all 40 rows in the DOM; 34 of
      // them passed the page-viewport test, were reported as the control's offer, and would have been "pressed" at
      // coordinates that are outside the menu — a click on whatever sits under the menu instead. A row is readable and
      // pressable only when the list itself is showing it.
      if (o.listTop !== null && o.listTop !== undefined) {
        if (o.top < o.listTop - 2 || o.top + o.h > o.listBottom + 2) return false;
      }
      return true;
    };

    let scope = null;
    if (marked) {
      const ref = marked.getAttribute("aria-controls") || marked.getAttribute("aria-owns")
        || (marked.querySelector && marked.querySelector("[aria-controls]") && marked.querySelector("[aria-controls]").getAttribute("aria-controls"));
      if (ref) scope = deepById(ref);
      if (!scope && marked.querySelector) {
        // A descendant listbox can belong to a DIFFERENT control that happens to be nested; only accept a visible one.
        scope = [...marked.querySelectorAll('[role="listbox"]')].find((b) => b.getBoundingClientRect().height > 0) || null;
        if (!scope) scope = marked.closest('[class*="select__menu"], [class*="menu"]');
      }
      if (!scope) {
        let w = marked;
        for (let i = 0; i < 5 && w && !scope; i++) { scope = w.querySelector ? w.querySelector('[role="listbox"]') : null; if (!scope) w = w.parentElement; }
      }
    }

    // The bare `SELECT...` div dropdown (Duolingo) has neither id nor role: its rows are plain divs inside the
    // container the trigger sits in. PORTED from answer_div_dropdown, which is the only script that drives that class.
    //
    // THIS BRANCH MUST NOT TOUCH A RICH WIDGET. It used to run whenever a container held a node reading "SELECT...",
    // and a react-select's committed value reads exactly "Select..." — so on the fixture this branch hijacked the
    // School control and returned its own placeholder as the single available row, while the control's real list sat
    // in the menu beside it. Only the widget that OWNS this shape may enter: no react-select, no listbox, no toggle.
    const rowbox = document.querySelector("[data-ats-rowbox]");
    const isRichWidget = Boolean(
      (marked && (marked.closest('[class*="select__"]') || marked.querySelector('[class*="select__"]'))) || scope,
    );
    // The trigger's OWN container is the field wrapper one level up; `closest("div,fieldset,section,li")` on the marked
    // trigger stops AT the trigger when the trigger is itself a div, and the reader then searched that node's
    // descendants and picked up a neighbouring react-select's option rows. The trigger must live INSIDE the scope that
    // is read, and the scope must be the nearest container that is not the trigger itself.
    const trigSelf = marked && marked.children.length === 0 && /^select\.{3}$/i.test(normTxt(marked.textContent));
    const divScope = rowbox
      || (trigSelf ? marked.parentElement : (marked && !isRichWidget ? marked.closest("div,fieldset,section,li") : null));
    if (divScope && (!marked || divScope === marked || divScope.contains(marked))) {
      // An EXACT leaf text match. `/^select\.{3}$/i` on innerText also matches every ANCESTOR whose text happens to be
      // "Select..." — including the react-select single-value div, which is a display node, not a trigger.
      const trig = [...divScope.querySelectorAll("div,button,span")].find((x) =>
        /^select\.{3}$/i.test(normTxt(x.textContent)) && !x.children.length);
      if (trig) {
        const rows = [...divScope.querySelectorAll("div,li,button,span")]
          .filter((o) => o !== trig && !o.contains(trig))
          // A CONTAINER IS NOT A ROW. The rowbox itself renders as "Yes No" and passed every other test — text, size,
          // on screen — so it was reported as one of the options and would have been clickable as one. A node whose own
          // children hold two or more option-like candidates is the wrapper around the rows.
          .filter((o) => [...o.children].filter((k) => /^(yes|no|true|false)$/i.test(normTxt(k.textContent))).length < 2)
          .map(shape)
          // ON-SCREEN ONLY, inside the dropdown's own container, and short. Without the viewport test this matched the
          // job header and every other long page element; without the container scope it matched another question's
          // committed "YES". The 40-char cap keeps a menu CONTAINER from being returned as if it were a row.
          .filter((o) => onScreen(o) && o.t.length < 40);
        if (rows.length) {
          const dedup = [];
          for (const r of rows) if (!dedup.length || dedup[dedup.length - 1].t !== r.t) dedup.push(r);
          return dedup;
        }
      }
    }

    // `[class*="option"]` is there for the widgets whose rows carry no role — but `select__value-container` contains
    // the substring "option" too, and it is the control's COMMITTED VALUE, not a row. Reading it as a row made the
    // fixture report the school picker as offering one row called "Select...". A value node is never a row.
    const NOT_A_ROW = /value-container|valueContainer|single-value|singleValue|multi-value|multiValue|__value|indicator/i;
    const collect = (root) => [...root.querySelectorAll('[class*="select__option"], [role="option"], [class*="option"]')]
      .filter((o) => !NOT_A_ROW.test(typeof o.className === "string" ? o.className : "") && !o.closest('[class*="value-container"], [class*="valueContainer"]'))
      .map(shape).filter(onScreen);
    if (scope && scope !== marked) {
      const scoped = collect(scope);
      if (scoped.length) return scoped;
    }
    if (marked) {
      // A self-contained combobox whose rows ARE its own container's children (some Ashby and div widgets).
      const own = [...marked.querySelectorAll('[role="option"], li')].map(shape).filter(onScreen);
      if (own.length) return own;
    }
    // THE LAST-VISIBLE-LISTBOX FALLBACK MUST NOT LEND ANOTHER CONTROL'S MENU. Only one list is open at a time in a
    // real page, but this tool cannot rely on that: a react-select whose menu is still open keeps a visible listbox in
    // the DOM, and on the fixture that is exactly what the Ashby field read back — it reported the SCHOOL picker's
    // three options as its own. A listbox that lives inside a react-select container belongs to that container's
    // control and to no other, so a container whose control is not the marked element is skipped.
    const mine = (box) => {
      const container = box.closest('[class*="select__container"], [class*="select__control"]');
      if (!container) return true;                        // a portal listbox (Ashby) is linked by nothing but visibility
      const ctrl = container.querySelector('[class*="select__control"]') || container;
      return Boolean(marked && (ctrl === marked || ctrl.contains(marked) || marked.contains(ctrl)));
    };
    const boxes = [...document.querySelectorAll('[role="listbox"]')]
      .filter((b) => b.getBoundingClientRect().height > 0 && mine(b));
    for (let i = boxes.length - 1; i >= 0; i--) { const l = collect(boxes[i]); if (l.length) return l; }
    return [];
  });

/**
 * Read the control's own committed value back. Carried over verbatim in spirit from the base's verify(), including the
 * climb and the honest "(no value exposed)".
 */
const readValue = (item, mode) =>
  bounded.evaluate(({ verify, label, id, question, labelRegex }) => {
    const normTxt = (s) => (s || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("[data-ats-pick]") || document.querySelector("[data-ats-trigger]");
    if (!root) return { value: "(control not found)", how: "none" };
    void label; void id; void question; void labelRegex;   // addressing is resolved by locate(); the marks are the handle

    // CLIMB FROM AN INPUT TO ITS CONTROL FIRST. When a control is addressed by id that id belongs to the hidden
    // <input>, not to the wrapper — querying inside `root` found nothing, the code fell through to `root.value`
    // (which react-select never sets) and this function returned "" for values that WERE committed. That produced
    // three lying WARNs in one round, on answers the submit then proved correct — and a WARN that lies is dangerous:
    // a later session could re-answer a question that was already right.
    const scope = (root.closest && root.closest('[class*="select__control"], [class*="select__container"], [class*="valueContainer"]')) || root;
    const display = scope.querySelector && scope.querySelector('[class*="select__single-value"], [class*="singleValue"], [class*="single-value"]');
    const multi = scope.querySelector && scope.querySelector('[class*="select__multi-value"], [class*="multiValue"]');
    const inputEl = (root.matches && root.matches("input") ? root : root.querySelector && root.querySelector("input")) || null;
    const inputVal = inputEl && inputEl.value !== undefined && inputEl.value !== null ? String(inputEl.value) : null;
    const displayVal = display ? normTxt(display.innerText || display.textContent) : "";
    const multiVal = multi ? normTxt(multi.innerText || multi.textContent) : "";
    const containerVal = (() => {
      const cont = (root.closest && root.closest("div,fieldset,section,li")) || root.parentElement;
      if (!cont) return "";
      // STRIP THE WIDGET'S OWN CHROME. Ashby's field wrapper holds the input AND the `toggleButton` that opens it, so a
      // plain innerText read of that wrapper returned "open" as the field's committed value on a test run — the widget
      // reporting its own button text as an answer is exactly the kind of read-back that must never be trusted.
      let text;
      if (cont.cloneNode) {
        const copy = cont.cloneNode(true);
        for (const junk of copy.querySelectorAll('[class*="toggleButton"], button, [role="button"], svg')) junk.remove();
        text = copy.innerText || copy.textContent || "";
      } else text = cont.innerText || "";
      let t = normTxt(text);
      t = t.replace(/^select\.{3}/i, "").trim();     // the div dropdown's own placeholder is not a value
      return t.slice(0, 200);
    })();

    const pick = (verify || "auto");
    if (pick === "display") return displayVal ? { value: displayVal, how: "display" } : { value: "(no display node)", how: "display" };
    if (pick === "combobox") {
      // PORTED from pick_ashby_combobox: Ashby renders the committed value in a singleValue node AND leaves it visible in
      // the input, and which of the two survives a re-render varies, so the read joins both rather than guessing.
      const joined = `${displayVal || multiVal} | ${inputVal === null ? "(no input)" : inputVal}`.replace(/\s+/g, " ").trim();
      return { value: joined, how: "combobox" };
    }
    if (pick === "input") return inputVal === null ? { value: "(no input value exposed)", how: "input" } : { value: inputVal, how: "input" };
    if (pick === "container") return containerVal ? { value: containerVal, how: "container" } : { value: "(container empty)", how: "container" };
    // auto: the control's own display node, then the multi-value chip, then the input, then the container. A claimed value in input.value with NO display node is reported as how:"input" so the caller can see it is the
    // weaker evidence (Kapitus / Delinea: text in input.value is not proof the form received it).
    if (displayVal) return { value: displayVal, how: "display" };
    if (multiVal) return { value: multiVal, how: "display" };
    if (inputVal) return { value: inputVal, how: "input" };
    if (containerVal && !/^select\.{3}/i.test(containerVal)) return { value: containerVal, how: "container" };
    return { value: inputVal === null ? "(no value exposed)" : inputVal, how: "input" };
  }, { verify: mode, label: item.label, id: item.id, question: item.question, labelRegex: item.labelRegex });

// ---- mouse helpers -------------------------------------------------------------------------------------------
const press = async (pt, settle = 1000) => {
  if (!pt || pt.zero) return false;
  await page.mouse.move(pt.x, pt.y).catch(() => {});
  await page.mouse.down().catch(() => {});
  await page.waitForTimeout(70);
  await page.mouse.up().catch(() => {});
  await page.waitForTimeout(settle);
  return true;
};
/** The Playwright fallback for a point that is not on screen. A locator click scrolls the element into view itself,
 *  which is what a human does by scrolling until the thing is visible — a coordinate press at a negative y does
 *  nothing at all (Notion, Benchling: the control sat at y=2962 and hand-computed coordinates hit empty space). */
const locatorClick = async (sel, nth = 0) => {
  await page.locator(sel).nth(nth).click({ timeout: 8000 }).catch(() => {});
};

/** PORTED from pick_ashby_combobox: Ashby's combobox is not a react-select and has a sibling [class*="toggleButton"]
 *  that opens it when a click on the input does not. */
const toggleClick = async () => {
  const pt = await measure("toggle");
  if (pt && pt.onScreen) { await press(pt, 900); return true; }
  if (pt) { await locatorClick("[data-ats-toggle]"); await page.waitForTimeout(900); return true; }
  return false;
};

// ---------------------------------------------------------------------------------------------------------------
// 5. Per-item run.
// ---------------------------------------------------------------------------------------------------------------
const report = { items: [], ok: 0, disagree: 0, notSet: 0, dry: 0, problems: [] };
let exitCode = 0;
const raise = (code) => { exitCode = Math.max(exitCode, code); };
const say = (s) => { if (!asJson) console.log(s); };

for (const raw of plan) {
  const item = { ...raw };
  const name = item.label || item.id || item.question || item.labelRegex || (item.index !== undefined ? `index=${item.index}` : `item ${item._n}`);
  const itemRec = { name, addressed: null, widget: null, action: "none", verified: null, how: null, row: null, status: "UNSET" };

  const found = await locate(item);
  if (!found || !found.found) {
    const why = found && found.mismatch ? found.mismatch : "control not found";
    // A WIDGET MISMATCH IS A USAGE ERROR, NOT A FORM FINDING: the caller said which widget this is and the address
    // disagrees, so the wrong control was addressed. Nothing was pressed. An address that simply matched nothing is a
    // form finding — the caller must record that the field is still unset — hence the two different codes.
    const code = found && found.mismatch ? 2 : 3;
    say(`  FAIL ${name}: ${why}${found && found.addressed ? ` (${found.addressed})` : ""}`);
    report.problems.push(`${name}: ${why}`);
    if (!found || !found.mismatch) report.notSet++;
    raise(code);
    itemRec.status = found && found.mismatch ? "WIDGET_MISMATCH" : "NOT_FOUND";
    report.items.push(itemRec);
    continue;
  }
  itemRec.addressed = found.addressed;
  itemRec.widget = found.kind;

  // THE QUERY ESCALATION'S GUARD, AND THE ONE PLACE A WRONG CONTROL IS STILL CHEAP TO CATCH. An id or an index can
  // point at a control that is not the question you think it is (fill_big_autocomplete was written for exactly that).
  // A guard failure is a usage-shaped error, not a form finding: nothing was touched.
  if (item.expectLabel) {
    const g = await labelGuard(item.expectLabel);
    if (!g.ok) {
      console.error(`  ABORT ${name}: --expect-label ${JSON.stringify(item.expectLabel)} does not match the control's label `
        + `${JSON.stringify(g.label)} — the control under that address is NOT the expected question. Nothing was pressed.`);
      report.problems.push(`${name}: label guard failed`); raise(2);
      itemRec.status = "LABEL_GUARD"; report.items.push(itemRec);
      break;
    }
    say(`  guard ${name}: label ${JSON.stringify(g.label.slice(0, 80))} matches --expect-label`);
  }

  const queries = item.query ? [...item.query] : [];
  const before = (await readValue(item, item.verify)).value;

  if (dryRun) {
    // A DRY RUN DOES NOT CLAIM SUCCESS. It reports what it resolved and what it would do, and whose exit code stays out
    // of the way of the caller's decision: 0 is a claim about the FORM, and a dry run made no claim about the form.
    say(`  DRY  ${name}: ${found.kind} located (${found.addressed}); would open with ${item.open || "auto"}, `
      + `pick ${JSON.stringify(item.option ?? item.optionRegex)}, commit ${item.commit || "mouse"}; reads now ${JSON.stringify(String(before).slice(0, 60))}`);
    itemRec.status = "DRY_RUN"; report.items.push(itemRec);
    report.dry++;
    continue;
  }

  // ---- open, with the Escape-then-reopen retry -------------------------------------------------------------
  // OPENING IS NOT IDEMPOTENT: a click on an already-open control CLOSES it, so a second pick attempt can find zero
  // rows and report "no row for …; saw []" even though the list is fine. That happened on Enveritas, where three of
  // six picks failed this way in one run after an earlier read had opened them. An empty list is therefore retried —
  // Escape to reset, then open again — rather than believed. Escape FIRST is deliberate: a dropdown left open by a
  // previous item renders an overlay that swallows the next click.
  const openMode = item.open || "auto";
  if (found.kind === "input" && openMode !== "auto") {
    say(`  note ${name}: the control is a plain input; --open ${openMode} does not apply.`);
  }

  const openOnce = async (mode) => {
    if (found.kind === "input") {
      // A plain input is not opened at all: it is cleared and typed, with real keystrokes — never DOM value setting.
      const pt = await measure("trigger") || await measure("pick");
      if (pt && pt.onScreen) await press(pt, 300); else await locatorClick("[data-ats-trigger], [data-ats-pick]");
      return;
    }
    if (mode === "toggle") { await toggleClick(); return; }
    if (mode === "arrowdown") { await page.keyboard.press("ArrowDown").catch(() => {}); await page.waitForTimeout(900); return; }
    if (mode === "type") {
      // TYPE-TO-SEARCH NEEDS THE FIELD FOCUSED FIRST. On a react-select the press is what opens the menu and puts the
      // caret in the control's own input; typing into an unfocused field sends the keystrokes to the document and the
      // list never renders (it reported "0 option(s)" on the fixture). The press is repeated here because `--open type`
      // skips the click path, and `typeInto` then re-checks the focus itself.
      const target = openAt === "input" && found.kind === "react-select" ? "trigger" : "pick";
      const pt = await measure(target);
      if (pt && pt.onScreen) await press(pt, 500);
      else if (pt) { await locatorClick(target === "trigger" ? "[data-ats-trigger]" : "[data-ats-pick]"); await page.waitForTimeout(500); }
      const first = queries[0] || item.option;
      await typeInto(first);
      await page.waitForTimeout(1200);
      return;
    }
    // click (and the first attempt of auto): the measured coordinate press, with the locator fallback off screen.
    const target = openAt === "input" && found.kind === "react-select" ? "trigger" : "pick";
    const pt = await measure(target);
    if (pt && pt.onScreen) await press(pt, 800);
    else if (pt) { await locatorClick(target === "trigger" ? "[data-ats-trigger]" : "[data-ats-pick]"); await page.waitForTimeout(800); }
    else await locatorClick("[data-ats-pick]");
  };

  const typeInto = async (text) => {
    // NOVA CREDIT: a type-to-search autocomplete renders NO options on click, so the typed query is what makes them
    // appear — and if the press landed on a different control, the text goes THERE and the list silently stays empty.
    // The focus is therefore read and corrected by a real click on the field's own input, never by a DOM value write.
    // The marked input ITSELF counts as correct: a react-select keeps the caret on its own input and reports it as
    // `className` rather than an id, so an id-shaped test called a correct focus wrong and re-clicked the control.
    const focusNow = () => bounded.evaluate(() => {
      const a = document.activeElement;
      if (!a) return "(none)";
      return { id: a.id || "", tag: a.tagName, mine: a.hasAttribute && a.hasAttribute("data-ats-trigger") };
    });
    let focused = await focusNow();
    const good = (f) => f && (f.mine || f.tag === "INPUT" && (f.id === "" || String(f.id).startsWith(String(item.id || "\u0000"))));
    if (!good(focused)) {
      await locatorClick("[data-ats-trigger], [data-ats-pick]");
      await page.waitForTimeout(250);
      focused = await focusNow();
      if (!good(focused)) {
        // A BROAD CLICK CAN MISS THE INPUT (Affirm school field, 2026-10-07). Its event log proved the characters reach
        // input#school--0 when the click lands ON the input, while this path left focus on BODY (activeElement reported
        // an empty id and class) - so `keyboard.type` went nowhere and the list never filtered. Click the element
        // itself, by its own coordinates, and re-read. This is a correction, not a guess: it only runs when the
        // existing path already failed to focus the control.
        const box = await bounded.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.focus();
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, item.id ? `#${item.id}` : "[data-ats-trigger]").catch(() => null);
        if (box) { await page.mouse.click(box.x, box.y).catch(() => {}); await page.waitForTimeout(300); }
        focused = await focusNow();
        if (!good(focused)) {
          say(`  note ${name}: focus is on ${JSON.stringify(focused.id || focused.tag)} rather than this control's input — `
            + "the query may be going to the wrong control.");
        }
      }
    }
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(text), { delay: 55 }).catch(() => {});
    await page.waitForTimeout(1200);
  };

  if (found.kind === "input") {
    // KIND input: cleared and typed. Kept from the base for the number/text fields that share a plan with selects.
    // --rowsOnly AND --dry-run ARE READS: they must not type into a live field either. Skipping the write here is not a
    // nicety — a text field on a real application is just as real as a dropdown, and `--rowsOnly` is the mode the caller
    // reaches for while somebody is working in that tab.
    if (rowsOnly || dryRun) {
      const cur = (await readValue(item, item.verify)).value;
      say(`  ${rowsOnly ? "ROWS" : "DRY "} ${name}: plain input, reads ${JSON.stringify(String(cur).slice(0, 60))}; `
        + `nothing typed (${rowsOnly ? "--rowsOnly" : "--dry-run"} does not write).`);
      itemRec.status = rowsOnly ? "ROWS" : "DRY_RUN";
      itemRec.verified = cur; itemRec.how = "input";
      if (rowsOnly) itemRec.row = [String(cur)];
      report.dry++;
      report.items.push(itemRec);
      continue;
    }
    const text = item.option === undefined || item.option === null ? "" : String(item.option);
    if (text.trim() === "") {
      // The literal string "undefined" reached this point once and was typed into a live field, so a value that is not a
      // value must stop the item rather than be typed at. A whitespace-only option is the ONE deliberate exception: it
      // is the only way this CLI can express "leave the field empty", which is how a field is put back to untouched
      // after a bad write — select-all, delete, and type nothing.
      if (text !== "" && text === " ".repeat(text.length)) {
        await openOnce("auto");
        await page.keyboard.press("Meta+a").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(600);
        const cleared = (await readValue(item, item.verify)).value;
        say(`  ${String(cleared).trim() === "" ? "OK  " : "WARN"} ${name}: cleared -> ${JSON.stringify(String(cleared).slice(0, 70))}`);
        itemRec.action = "cleared"; itemRec.verified = cleared; itemRec.how = "input";
        itemRec.status = String(cleared).trim() === "" ? "VERIFIED" : "DISAGREE";
        if (String(cleared).trim() === "") report.ok++;
        else { report.disagree++; raise(1); report.problems.push(`${name}: asked to clear but still reads ${JSON.stringify(cleared)}`); }
        report.items.push(itemRec);
        continue;
      }
      say(`  FAIL ${name}: no usable option text to type — nothing was written.`);
      report.problems.push(`${name}: empty option for a text field`); report.notSet++; raise(3);
      itemRec.status = "NOTHING_SET"; report.items.push(itemRec);
      continue;
    }
    await openOnce("auto");
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(text, { delay: 70 });
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(700);
    const now = await readValue(item, item.verify === "auto" ? "auto" : item.verify);
    const ok = compare(now.value, text);
    say(`  ${ok ? "OK  " : "WARN"} ${name}: typed -> ${JSON.stringify(String(now.value).slice(0, 70))}`);
    itemRec.action = "typed"; itemRec.verified = now.value; itemRec.how = now.how; itemRec.status = ok ? "VERIFIED" : "DISAGREE";
    if (ok) report.ok++;
    else { report.disagree++; raise(1); report.problems.push(`${name}: typed ${JSON.stringify(text)} but reads ${JSON.stringify(now.value)}`); }
    report.items.push(itemRec);
    continue;
  }

  // CLOSE EVERY OPEN MENU, NOT JUST ONE (Affirm, 2026-10-07). A select left open by an earlier field keeps its menu in
  // the DOM, and an unscoped row read then returns THAT field's options: reading the Affirm form reported ten rows of
  // Degree options while the School control was the one being addressed. A stale open menu also intercepts clicks and
  // keys, which is the same failure mode recorded for Workday. Escape until nothing is open.
  for (let i = 0; i < 4; i++) {
    const openMenus = await bounded.evaluate(() =>
      document.querySelectorAll('[class*="select__menu"]').length).catch(() => 0);
    if (!openMenus) break;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(250);
  await locate(item);
  await page.waitForTimeout(450);
  await openOnce(openMode === "auto" ? "click" : openMode);
  let rows = await rowsScoped();
  if (!rows.length && (openMode === "auto" || openMode === "click")) {
    // "An empty option list is not an empty list": some widgets only render on ArrowDown, some only on the toggle.
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(900);
    rows = await rowsScoped();
  }
  if (!rows.length && found.kind === "ashby-combobox" && openMode === "auto") {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
    await locate(item);
    await page.waitForTimeout(300);
    await toggleClick();
    rows = await rowsScoped();
  }
  for (let attempt = 0; attempt < 3 && !rows.length && !queries.length; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(350);
    await locate(item);
    await page.waitForTimeout(400);
    await openOnce(openMode === "auto" ? "click" : openMode);
    rows = await rowsScoped();
  }

  if (rowsOnly) {
    let list = rows;
    if (!list.length && queries.length) {
      for (const q of queries) { await typeInto(q); list = await rowsScoped(); if (list.length) break; }
    }
    if (!list.length) {
      // A reading mode that read nothing is a real finding, but not the "nothing was set" finding — it never tried to
      // set anything. It is reported and counted; the caller decides whether an unreadable list is worth a retry.
      say(`  FAIL ${name}: list never opened — nothing to read (${rows.length} row(s))`);
      report.problems.push(`${name}: list never opened`);
    } else {
      say(`  ${name}: ${list.length} row(s) ${JSON.stringify(list.map((r) => String(r.t).slice(0, 44)).slice(0, 8))}`);
      itemRec.status = "ROWS";
      itemRec.row = list.map((r) => String(r.t));
    }
    // Leave no menu open behind: a stale open menu is what made an earlier option read ambiguous (it returned the
    // phone-country list instead of the control's own), and it swallows the next click.
    await page.keyboard.press("Escape").catch(() => {});
    report.items.push(itemRec);
    continue;
  }

  // ---- query escalation ------------------------------------------------------------------------------------
  // PORTED from fill_big_autocomplete: the full official name renders ZERO options on Block and Coinbase while a short
  // fragment works (Block's field was optional, Coinbase's was REQUIRED — so this decides whether a form can be
  // submitted at all). Try query 1, and only if zero rows render try query 2, and so on.
  let list = rows;
  let usedQuery = null;
  if (!list.length && queries.length) {
    for (const q of queries) {
      await typeInto(q);
      list = await rowsScoped();
      if (list.length) { usedQuery = q; break; }
      say(`  query ${JSON.stringify(q)} -> 0 option(s)`);
    }
  }
  // A SHORT LIST IS NOT ALWAYS THE RIGHT LIST. Some controls render a default set of rows on open that does not contain
  // the wanted option (Rula's Race identity showed five standard rows while the wanted one sat further down), so when
  // the caller asked for a query the query is typed even though rows already exist — the widget filters as you type, and
  // the read-back is what decides. If the query renders nothing at all, come back to the unfiltered list rather than
  // losing an option that was already on screen.
  if (list.length && queries.length && !usedQuery) {
    await typeInto(queries[0]);
    usedQuery = queries[0];
    const filtered = await rowsScoped();
    if (filtered.length) list = filtered;
    else { say(`  query ${JSON.stringify(usedQuery)} rendered 0 option(s) — falling back to Escape and the unfiltered list`); await page.keyboard.press("Escape"); await page.waitForTimeout(250); await locate(item); await page.waitForTimeout(350); await openOnce("click"); list = await rowsScoped(); usedQuery = null; }
  }

  if (!list.length) {
    say(`  FAIL ${name}: no option list rendered${queries.length ? ` for quer${queries.length > 1 ? "ies" : "y"} ${JSON.stringify(queries)}` : ""} — the field is NOT set, record this rather than inventing a value.`);
    report.problems.push(`${name}: no option list`); report.notSet++; raise(3); itemRec.status = "NOTHING_SET";
    await page.keyboard.press("Escape").catch(() => {});
    report.items.push(itemRec);
    continue;
  }

  // ---- choose the row: EXACT rendered text only, unless the caller explicitly asked for a regex -------------
  // Prefix and substring fallbacks are precisely how "Senior" selects "Senior Director" (TRM Labs, Rula) and how
  // "Lakeside State University" selects Bakersfield. startsWith is not offered at all. A WARN the caller can see
  // beats a silent wrong answer.
  const want = item.optionRegex !== undefined ? item.optionRegex : item.option;
  const useRegex = item.match === "regex" || (item.match === undefined && item.optionRegex !== undefined);
  const matchRows = (rows) => (useRegex
    ? rows.filter((r) => { try { return new RegExp(want, "i").test(r.t); } catch { return false; } })
    : rows.filter((r) => low(r.t) === low(item.option)));
  let hits = matchRows(list);
  // A ROW THAT IS NOT RENDERED YET IS NOT A ROW THAT DOES NOT EXIST. Long react-select lists render a slice at a time,
  // so the read is retried with a scroll between attempts (the base's twenty-attempt loop, kept rather than replaced
  // by a single read — "no row for X; saw [...]" on a list that merely had not been scrolled is a wrong answer
  // reported as a page problem). The first attempt always scrolls the list itself, because that is the only way to
  // reach rows below the fold INSIDE the menu, and it writes scrollTop rather than guessing a wheel target; later
  // attempts scroll the page too, which is what a short fixed list needs when it sits below the viewport.
  const scrollListbox = (pageToo) => bounded.evaluate((alsoPage) => {
    const marked = document.querySelector("[data-ats-pick]");
    const box = (marked && marked.closest('[class*="select__menu"], [class*="menu"]'))
      || doorOf(marked) || document.querySelector('[role="listbox"]');
    function doorOf(el) {
      // a bare combobox links its menu through aria-controls where it has one
      const ref = el && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
      return ref ? document.getElementById(ref) : null;
    }
    let moved = false;
    if (box && box.scrollBy) { box.scrollBy(0, 300); moved = true; }
    if (!moved && alsoPage) window.scrollBy(0, 300);
  }, pageToo);
  for (let attempt = 0; attempt < 20 && !hits.length; attempt++) {
    await scrollListbox(attempt > 0 && !scrollRows).catch(() => {});
    await page.waitForTimeout(450);
    const again = await rowsScoped();
    if (!again.length) break;
    list = again;
    hits = matchRows(list);
  }
  const ambiguous = hits.length > 1;
  let row = hits[0] || null;

  if (!row) {
    // Print EVERY row on a miss: a truncated list hides the very option being looked for (Rula's Race identity showed
    // five standard rows while the wanted one sat further down).
    say(`  FAIL ${name}: no row exactly ${JSON.stringify(item.option ?? item.optionRegex)}; saw ${JSON.stringify(list.map((r) => String(r.t).slice(0, 34)))}`);
    report.problems.push(`${name}: no matching row`); report.notSet++; raise(3); itemRec.status = "NOTHING_SET";
    await page.keyboard.press("Escape").catch(() => {});
    report.items.push(itemRec);
    continue;
  }

  // THE INTENT IS THE ROW'S OWN RENDERED TEXT. For an exact pick that is the option the caller asked for; for a regex
  // pick it is the text actually matched, so the read-back is still compared by equality against something real rather
  // than against a pattern that could match several different options.
  const intent = row.t;

  // ---- commit ----------------------------------------------------------------------------------------------
  const commitMode = item.commit || "mouse";
  itemRec.row = norm(row.t);
  if (commitMode === "keyboard") {
    // THE ONE MECHANISM NONE OF THE SEVEN IMPLEMENTED (spec §"And one mechanism"; KoBold, Mozilla): a pointer pick
    // would not stick and `focus → ArrowDown → Enter → Tab` committed first time. Each step is real input.
    //
    // THE COUNT MATTERS MORE THAN THE KEYSTROKES. Enter commits the HIGHLIGHTED row, not the intended one, so the
    // wanted row's offset in the rendered list is counted first (the ashby_combobox_by_index lesson: pressing Enter
    // blind takes the first match). The convention is the one that shipped and worked on Benchling, where the widget
    // highlights NOTHING until the user arrows: the FIRST ArrowDown opens the list and lands on row 0, so reaching
    // offset n takes n+1 presses. A widget that auto-highlights on open commits its own first row instead — the
    // read-back catches that as a disagreement, which is the honest outcome; the caller then retries with --commit
    // mouse. Deliberately no ArrowUp here: it desynchronises the count on exactly the widget this was built for.
    const offset = Math.max(0, list.findIndex((r) => r.t === row.t));
    // CLOSE FIRST, SO THE COUNT HAS A KNOWN BASELINE. The list was opened by the time this line runs, and the widget's
    // highlight is wherever that left it — measured on the fixture, one ArrowDown during the open attempt landed the
    // highlight on row 1, and the offset count then committed the row AFTER the intended one. Escape puts the widget
    // back to nothing-highlighted, which is the state the offset is expressed in.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    for (let i = 0; i <= offset; i++) { await page.keyboard.press("ArrowDown").catch(() => {}); await page.waitForTimeout(150); }
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Tab").catch(() => {});            // Tab commits and leaves the field, as a human would
    await page.waitForTimeout(700);
    itemRec.action = `keyboard(Escape + ArrowDown x${offset + 1} + Enter + Tab; wanted row offset ${offset})`;
  } else if (commitMode === "enter") {
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(900);
    itemRec.action = "enter";
  } else if (commitMode === "tab") {
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(900);
    itemRec.action = "tab";
  } else {
    // mouse: press the row itself. When the row's measured point is off screen (Notion, Benchling: the control sat at
    // y=2962 and hand-computed coordinates hit empty space) fall back to a Playwright locator click on the exact text.
    const viewport = await bounded.evaluate(() => window.innerHeight);
    const onScreen = row.y > 0 && row.y < viewport && row.w > 0;
    if (onScreen) { await press(row, 900); itemRec.action = "pressed the row at its measured point"; }
    else {
      const esc = norm(row.t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await page.locator('[role="option"], [class*="select__option"]').filter({ hasText: new RegExp(`^${esc}$`) }).first()
        .click({ timeout: 8000 }).catch(async () => { await page.keyboard.press("Enter").catch(() => {}); });
      await page.waitForTimeout(900);
      itemRec.action = "locator click on the row (its measured point was off screen)";
    }
  }

  // ---- verify ----------------------------------------------------------------------------------------------
  let now = await readValue(item, item.verify);
  // PORTED from pick_ashby_combobox's retry shape: Ashby REPLACES the input node on commit, so an immediate read can
  // still find the pre-commit DOM. Give it one short second look before believing a disagreement.
  if (!compareIntent(now.value, intent, expectDecorated)) {
    await page.waitForTimeout(700);
    const again = await readValue(item, item.verify);
    if (compareIntent(again.value, intent, expectDecorated)) now = again;
  }
  const ok = compareIntent(now.value, intent, expectDecorated);
  const weak = now.how === "input" || now.how === "container";
  const note = ambiguous
    ? ` (AMBIGUOUS: ${hits.length} rows matched ${JSON.stringify(String(want))}; pressed the first)`
    : usedQuery ? ` (query ${JSON.stringify(usedQuery)})` : "";
  say(`  ${ok ? "OK  " : "WARN"} ${name}: ${itemRec.action} ${JSON.stringify(String(row.t).slice(0, 40))}${note} -> reads `
    + `${JSON.stringify(String(now.value).slice(0, 70))} [${now.how}${weak ? " — weaker evidence, input.value is not proof the form received it" : ""}]`
    + `${ok ? "" : ` wanted ${JSON.stringify(intent)}`}`);
  itemRec.verified = now.value; itemRec.how = now.how;
  itemRec.status = ok ? "VERIFIED" : "DISAGREE";
  if (ok) {
    report.ok++;
    if (ambiguous) { report.disagree++; raise(1); report.problems.push(`${name}: ambiguous row match (${hits.length} rows) — the wrong one may now be committed`); }
  } else {
    // SET BUT THE READ-BACK DISAGREES. Never 0 here: this is the "Fairview College for a Cal State Fairview answer"
    // case, and reporting it as success is a false credential on the application.
    report.disagree++; raise(1);
    report.problems.push(`${name}: pressed ${JSON.stringify(row.t)} but reads ${JSON.stringify(now.value)}`);
  }
  report.items.push(itemRec);
}

/**
 * THE SAFETY NET UNDER THE EXIT CONTRACT. Exit 0 is a claim that every requested item was verified, so a run that
 * reaches the end having verified NOTHING must not report it — that sentence, printed by a script, is what gets
 * recorded in the tracker as "filled" for a form nobody set. In a read-only mode the claim is never made at all, so
 * --rowsOnly and --dry-run are exempt (their output says so explicitly).
 */
if (exitCode === 0 && report.ok === 0 && !rowsOnly && !dryRun) {
  console.error("internal check: no item was verified, so this run may not exit 0. Reporting 3 (nothing set) instead.");
  exitCode = 3;
}

if (asJson) {
  console.log(JSON.stringify({
    url: page.url(), rowsOnly, dryRun, exit: exitCode,
    ok: report.ok, disagree: report.disagree, notSet: report.notSet, read: report.dry,
    items: report.items, problems: report.problems,
  }, null, 2));
} else {
  console.log(`\n${plan.length} field(s): ${report.ok} verified, ${report.disagree} set-but-disagreeing, ${report.notSet} not set`
    + (report.dry ? `, ${report.dry} read-only (nothing pressed)` : ""));
  if (report.problems.length) console.log(`problems: ${report.problems.join(" | ")}`);
  // SAY WHAT THE EXIT CODE MEANS, AND NOTHING MORE. A reading mode must never print the sentence that claims the form
  // was verified — that sentence is how a "success" gets recorded for a run that never touched the form.
  if (exitCode === 0 && (dryRun || rowsOnly)) {
    console.log("READ-ONLY run: nothing was pressed and nothing was verified. No claim is being made about the form.");
  } else if (exitCode === 0) {
    console.log("every requested item was verified by equality against its own display node.");
  } else if (exitCode === 1) console.log("SOME ITEM WENT IN AND READS DIFFERENTLY — do not submit until it is resolved.");
  else if (exitCode === 3) console.log("SOMETHING WAS NOT SET. Record it rather than inventing a value.");
  else if (exitCode === 2) console.log("USAGE or GUARD error: review the message above before re-running; nothing else was touched.");
}
process.exit(exitCode);
