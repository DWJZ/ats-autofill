// ashby_finish_form.mjs — fill what the spec cannot, answer the hidden Yes/No pairs, then gate and submit.
//
// Usage: node src/forms/ashby_finish_form.mjs <url-part> <profile> <company> <bundle.json> [essayFile]
//
// THE CLICK RULE, LEARNED THE HARD WAY ON NOTION (2026-10-03): option buttons can sit BELOW the viewport (Notion's were at
// y=1310). Clicking hand-computed viewport coordinates then hits empty space - the buttons' aria stayed false and the hidden
// checkbox never flipped, across many rounds of retries. Options are therefore clicked through Playwright's own locator,
// which scrolls the element into view first. Raw coordinates are not used for options at all.
//
// THE PROOF RULE: the answer is only recorded when the HIDDEN 0x0 CHECKBOX flips. The buttons' aria-pressed is decoration -
// the server refused a form whose buttons claimed Yes while the checkbox read false, and accepted the question whose
// checkbox it could read. aria staying false after a real click means the click missed, not that the widget ignores clicks.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Configuration is located through the one definition of the `ATS_DATA_DIR` setting. This file is an
// ordinary Node ESM script - it already derives its own directory from `import.meta.url` above - so a
// sibling import is viable here, and it is the same mechanism rather than a second reading of the variable.
import { DATA_DIR } from "../paths.mjs";
// The Ashby location rule - the queries to type and what counts as committed - is pure and lives beside this file,
// so it is pinned by a test that needs no browser (test_ashby_location_query.mjs) instead of only by a live run.
import { locationAddress } from "./ashby_location_query.mjs";

const [part, profile, company, bundle, essayFile] = process.argv.slice(2);
if (!part || !profile || !company || !bundle) {
  console.error("usage: ashby_finish_form.mjs <url-part> <profile> <company> <bundle.json> [essayFile]");
  process.exit(2);
}
const CDP = "http://127.0.0.1:9223";
// IDENTITY COMES FROM THE PROFILE, NEVER FROM LITERALS IN THIS FILE. These four fields used to be typed in as
// strings, which is how a finisher drifts from the canonical data: the profile could be corrected and this file
// would keep submitting the old value. Both profile files are read through `src/paths.mjs` - the data
// directory, wherever `ATS_DATA_DIR` points - the same two its sibling greenhouse_standard.mjs reads.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PROFILE = JSON.parse(readFileSync(join(DATA_DIR, "application_profile.json"), "utf8"));
const CAND_PROFILE = JSON.parse(readFileSync(join(DATA_DIR, "candidate_profile.json"), "utf8"));
const CAND = APP_PROFILE.candidate || {};
const STD = CAND_PROFILE.candidate || {};
const IDENTITY = {
  name: CAND.name || STD.name || "",
  email: CAND.email || STD.email || "",
  linkedin: (() => {
    const v = CAND.linkedin || STD.linkedin || "";
    if (!v || v.startsWith("http")) return v;
    return v.startsWith("linkedin.com") ? `https://www.${v}` : `https://${v}`;
  })(),
  github: CAND.github || STD.github || "",
  // The current employer was a literal in this file while the four fields above already read the profile, which is
  // the drift the comment above warns about: the profile could be corrected and this line would keep typing the old
  // employer. It is the first entry of `work_experience`, and a profile with none yields "" rather than a name.
  current_company: ((APP_PROFILE.work_experience || [{}])[0] || {}).company || "",
  // The phone was the last identity literal here, and the same drift applied to it: a corrected number in the profile
  // could not reach the form. `data/application_profile.json` keeps it as an object
  // (`{country, country_code, number, formatted}`) and `formatted` is the string a text input wants.
  phone: ((CAND.phone || {}).formatted) || "",
  // PRONOUNS ARE A FACT ABOUT THE CANDIDATE, SO THEY ARE READ OR THE FIELD IS LEFT ALONE - "He/Him/His" used to be
  // typed in here, which is a claim about a real person made by a script. Neither profile carries a pronouns key
  // today, so this is normally empty and the call site below reports the miss on stdout the way every other
  // unfilled control in this file is reported. Three places are checked, in the order the fields above use:
  // application_profile.candidate, candidate_profile.candidate, and candidate_profile's `standard_answers` block,
  // which is where a recurring form answer belongs.
  pronouns: CAND.pronouns || STD.pronouns || ((STD.standard_answers || {}).pronouns) || "",
};
const pdf = JSON.parse(readFileSync(bundle, "utf8")).resume_pdf_path;
const ESSAY = essayFile && existsSync(essayFile) ? readFileSync(essayFile, "utf8").trim() : "";
// This path used to be relative to the WORKING DIRECTORY, which is a different answer from "the data
// directory" the moment the script is run from anywhere but the repo root - and a different one again once
// `ATS_DATA_DIR` is set. It comes from the same definition as the profiles above.
const rules = JSON.parse(readFileSync(join(DATA_DIR, "form_specs", "ashby_pairs_standing.json"), "utf8")).rules || [];
const b = await chromium.connectOverCDP(CDP);
const page = b.contexts()[0].pages().find((x) => (x.url() || "").includes(part));
if (!page) { console.log("no tab for", part); process.exit(2); }
const run = (args) => { try { return execFileSync("node", args, { encoding: "utf8", timeout: 600000 }); } catch (e) { return String(e.stdout || e); } };

// the browser's own label->control association; document order is unreliable (the label can follow its input)
const labelMap = () => page.evaluate(() => {
  const out = [];
  for (const lab of document.querySelectorAll("label")) {
    const id = lab.getAttribute("for");
    if (!id) continue;
    const el = document.getElementById(id);
    if (!el || ["hidden", "file", "checkbox", "radio", "submit", "button"].includes(el.type)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ label: (lab.innerText || "").trim().slice(0, 70), id, value: el.value || "" });
  }
  return out;
});

async function fill(re, value, what) {
  const map = await labelMap();
  const hit = map.find((m) => re.test(m.label));
  if (!hit) { console.log(`  ${what}: no label match`); return false; }
  const loc = page.locator(`[id="${hit.id}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(180);
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(value, { delay: 5 });
  await page.waitForTimeout(240);
  await page.keyboard.press("Tab");                       // blur -> the change event the server needs
  await page.waitForTimeout(420);
  const now = (await loc.inputValue().catch(() => "")) || "";
  console.log(`  ${what} -> "${hit.label}" len=${now.length} ${now.length > 0 ? "OK" : "EMPTY"}`);
  return now.length > 0;
}

const nameOk = await fill(/^(Full|First and Last|First|Last) Name$/i, IDENTITY.name, "name");
// FALLBACK BY STANDARD ID: some tenants label the name field so that no matcher catches it, but Ashby always gives it the id
// _systemfield_name. Fill it by id rather than leaving the most important field empty.
if (!nameOk) {
  const nl = page.locator("#_systemfield_name").first();
  if (await nl.count()) {
    await nl.scrollIntoViewIfNeeded().catch(() => {});
    await nl.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(180);
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(IDENTITY.name, { delay: 12 });
    await page.waitForTimeout(240);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(420);
    console.log("  name (by standard id):", (await nl.inputValue().catch(() => "")) || "EMPTY");
  }
}
await fill(/^Email$/i, IDENTITY.email, "email");
await fill(/^Phone/i, IDENTITY.phone, "phone");
const linkedinOk = await fill(/LinkedIn/i, IDENTITY.linkedin, "linkedin");
await fill(/Current Company/i, IDENTITY.current_company, "current company");
// A CONTROL WITH NO PROFILE VALUE IS NOT FILLED WITH A GUESS. When the profile has no pronouns the field is left
// exactly as the page has it - which may be a value this candidate set on an earlier application with the same tenant
// - and the miss is printed on stdout in the same form as every other one this file reports.
if (IDENTITY.pronouns) await fill(/^Pronouns$/i, IDENTITY.pronouns, "pronouns");
else console.log("  pronouns: no profile value - left alone");
await fill(/GitHub/i, IDENTITY.github, "github");
if (ESSAY) {
  const map = await labelMap();
  // EXCLUDE NON-ESSAY QUESTIONS FROM THE ESSAY MATCHER (Sierra, 2026-10-03): the pattern included the word what, which
  // matched the icebreaker question about favourite junk food and put a 985-character essay into it. Exclude the
  // icebreaker and any question that is plainly not asking for prose.
  const essay = map.find((m) => m.value === "" && /\?|why|tell us|describe/i.test(m.label) && !/junk food|favourite|favorite/i.test(m.label));
  if (essay) await fill(new RegExp(essay.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ESSAY, "essay");
}

// pairs: find the hidden checkbox and its question, decide from the standing table, click the wanted option through the
// locator (which scrolls it into view), and accept ONLY the hidden checkbox flipping as proof.
const pairs = await page.evaluate(() => {
  const allButtons = [...document.querySelectorAll("button")];
  const out = [];
  for (const e of document.querySelectorAll("input[type=checkbox]")) {
    const r = e.getBoundingClientRect();
    if (r.width > 2 || r.height > 2) continue;
    let w = e, q = "";
    for (let i = 0; i < 20 && w; i++) { const t = (w.innerText || "").replace(/\s+/g, " ").trim(); if (t && t.length > 10 && t.length < 500) { q = t; break; } w = w.parentElement; }
    let box = e, opts = null;
    for (let i = 0; i < 10 && box; i++) {
      const bs = [...box.querySelectorAll("button")].filter((x) => /^\s*(yes|no)\b/i.test((x.innerText || "").trim()) && (x.innerText || "").trim().length < 24);
      if (bs.length >= 2) { opts = bs.slice(0, 2); break; }
      box = box.parentElement;
    }
    if (!opts) continue;
    out.push({
      name: e.name || "-", checked: e.checked === true, q: (q || "").replace(/ Yes No$/, ""),
      opts: opts.map((x) => ({ text: (x.innerText || "").trim().slice(0, 8), index: allButtons.indexOf(x) })),
    });
  }
  return out;
});
// RADIO GROUPS WHOSE OPTION IS THE QUESTION (Astronomer, 2026-10-03): some tenants render a pair as two radios whose
// OPTION LABELS carry the question text themselves - Yes, I am open to relocation and No, I am not interested in
// relocation - so an ancestor walk finds only the option text and a matcher keyed on the question NEVER fires even
// though the control is plainly present. This pass matches the OPTION LABEL against the standing table instead, and
// commits with a locator check, reading the control state back.
const radioOnly = await page.evaluate((ruleSources) => {
  const all = [...document.querySelectorAll("input[type=radio]")];
  const out = [];
  for (const e of all) {
    let lab = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
    if (!lab) lab = e.closest("label") || e.parentElement;
    const lt = (lab.innerText || "").trim();
    if (!lt || lt.length > 90) continue;
    let hit = null;
    for (const src of ruleSources) { try { if (new RegExp(src, "i").test(lt)) { hit = src; break; } } catch {} }
    if (!hit) continue;
    out.push({ index: all.indexOf(e), label: lt.slice(0, 60), rule: hit, checked: e.checked });
  }
  return out;
}, rules.map((r) => String(r.questionRe || "")));
for (const r of radioOnly) {
  const rule = rules.find((x) => String(x.questionRe || "") === r.rule);
  const want = rule ? String(rule.answer).toLowerCase() : null;
  if (!["yes", "no"].includes(want)) continue;
  const matches = new RegExp("^\\s*" + want, "i").test(r.label);
  if (!matches) continue;
  if (r.checked) { console.log(`  RADIO ${want.toUpperCase()} already set: "${r.label}"`); continue; }
  await page.locator("input[type=radio]").nth(r.index).check({ timeout: 8000 }).catch(async () => { await page.locator("input[type=radio]").nth(r.index).click({ timeout: 8000 }).catch(() => {}); });
  console.log(`  RADIO ${want.toUpperCase()} by OPTION LABEL: "${r.label}" -> checked=${await page.evaluate((i) => [...document.querySelectorAll("input[type=radio]")][i].checked, r.index)}`);
}
// RADIO GROUPS ANCHORED BY THEIR FIELDSET (Sierra, 2026-10-03). These questions render as div._option_ rows, each containing a
// REAL input[type=radio] whose name is the field id, and the div class token true is only a STYLE that does not follow the
// input state - so clicking the div changes nothing observable while the INPUT is what the server reads. Clicking the div with
// a real mouse press, a locator click and a force click all left it at false; checking the radio input is the fix. The fieldset
// text names the question reliably, which makes it the right anchor.
const radioGroups = await page.evaluate(() => {
  const out = [];
  for (const fs of document.querySelectorAll("fieldset")) {
    const q = (fs.innerText || "").replace(/\s+/g, " ").trim();
    if (!q || q.length > 300) continue;
    const radios = [...fs.querySelectorAll("input[type=radio]")];
    // ALLOW UP TO SIX OPTIONS (2026-10-03): a non-compete question rendered as Yes / No / Not Sure / N-A and the old
    // 2-to-3 cap made this pass skip it silently, so the gate named a required question that no pass had touched.
    if (radios.length < 2 || radios.length > 6) continue;
    const opts = radios.map((r) => {
      let lab = r.id ? document.querySelector(`label[for="${r.id}"]`) : null;
      if (!lab) lab = r.closest("label") || r.parentElement;
      return { label: (lab.innerText || "").trim().slice(0, 30), id: r.id || "", name: r.name || "", checked: r.checked === true };
    });
    if (opts.some((o) => o.checked)) continue;
    out.push({ q: q.slice(0, 120), opts });
  }
  return out;
});
for (const g of radioGroups) {
  // match against the QUESTION first, then against the group OPTION LABELS - option-text rules such as Seeking work
  // authorization are written against the choice, not the question, and the div pass has always matched that way.
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(g.q); } catch { return false; } })
    || rules.find((r) => (g.opts || []).some((o) => { try { return new RegExp(String(r.questionRe || ""), "i").test(String(o.label || "")); } catch { return false; } }));
  // answer may be yes/no, or a SPECIFIC OPTION TEXT (self-identification questions ask for a category, not a yes/no)
  const want = rule ? (String(rule.answer).toLowerCase() === "option" ? String(rule.option || "") : String(rule.answer).toLowerCase()) : null;
  if (!want) { console.log(`  RADIO GROUP with NO RULE: ${g.q.slice(0, 70)}`); continue; }
  const hit = g.opts.find((o) => new RegExp("^\\s*" + want, "i").test(o.label));
  if (!hit || !hit.id) { console.log(`  RADIO GROUP: no ${want} option in ${g.q.slice(0, 50)}`); continue; }
  const loc = page.locator(`[id="${hit.id}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.check({ timeout: 8000 }).catch(async () => { await loc.click({ timeout: 8000 }).catch(() => {}); });
  const ok = await page.evaluate((id) => { const e = document.getElementById(id); return e ? e.checked === true : null; }, hit.id);
  console.log(`  RADIO ${want.toUpperCase()} (fieldset anchor): ${g.q.slice(0, 52)} -> checked=${ok}`);
}

// YES/NO-NAMED CHECKBOX PAIRS (Sprinter Health, 2026-10-03). Some tenants render a Yes/No question as TWO input[type=checkbox]
// elements whose NAME attributes are literally "Yes" and "No" and which SHARE ONE ID - so answer_by_checkbox cannot address them,
// because it anchors on a checkbox name that is a field uuid, and a click on the wrong one records the OPPOSITE answer. This pass
// finds such pairs by their container text and clicks the one whose name matches the standing rule.
const yesNoNamed = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll("input[type=checkbox]")) {
    if (e.name !== "Yes" && e.name !== "No") continue;
    let w = e, q = "";
    for (let i = 0; i < 18 && w; i++) { const s = (w.innerText || "").replace(/\s+/g, " ").trim(); if (s.length > 10 && s.length < 700) { q = s; break; } w = w.parentElement; }
    if (!q) continue;
    out.push({ name: e.name, checked: e.checked === true, q: q.slice(0, 140), id: e.id || "" });
  }
  return out;
});
const seenPairs = new Set();
for (const f of yesNoNamed) {
  const key = f.q.slice(0, 90);
  if (seenPairs.has(key)) continue;
  const group = yesNoNamed.filter((x) => x.q.slice(0, 90) === key);
  seenPairs.add(key);
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(f.q); } catch { return false; } });
  if (!rule) { console.log(`  YES/NO-NAMED PAIR with NO RULE: ${f.q.slice(0, 60)}`); continue; }
  const want = String(rule.answer).toLowerCase();
  if (!["yes", "no"].includes(want)) continue;
  const target = group.find((g) => g.name.toLowerCase() === want);
  const wrong = group.find((g) => g.name.toLowerCase() !== want);
  if (!target) { console.log(`  YES/NO-NAMED PAIR has no ${want} control: ${f.q.slice(0, 50)}`); continue; }
  if (target.checked && !(wrong && wrong.checked)) { console.log(`  YES/NO-NAMED PAIR already ${want.toUpperCase()}: ${f.q.slice(0, 46)}`); continue; }
  await page.evaluate(({ wantName, key }) => {
    for (const e of document.querySelectorAll("input[type=checkbox]")) {
      if (e.name !== wantName) continue;
      let w = e, q = "";
      for (let i = 0; i < 18 && w; i++) { const s = (w.innerText || "").replace(/\s+/g, " ").trim(); if (s.length > 10 && s.length < 700) { q = s; break; } w = w.parentElement; }
      if (q.slice(0, 90) !== key) continue;
      e.scrollIntoView({ block: "center" });
      e.click();
      return;
    }
  }, { wantName: target.name, key });
  await page.waitForTimeout(620);
  const now = await page.evaluate(({ wantName, key }) => {
    for (const e of document.querySelectorAll("input[type=checkbox]")) {
      if (e.name !== wantName) continue;
      let w = e, q = "";
      for (let i = 0; i < 18 && w; i++) { const s = (w.innerText || "").replace(/\s+/g, " ").trim(); if (s.length > 10 && s.length < 700) { q = s; break; } w = w.parentElement; }
      if (q.slice(0, 90) !== key) continue;
      return e.checked === true;
    }
    return null;
  }, { wantName: target.name, key });
  console.log(`  YES/NO-NAMED PAIR ${want.toUpperCase()}: ${f.q.slice(0, 48)} -> checked=${now}`);
}

// NAME-BUT-NO-ID CHECKBOX FIELDS (Sierra public sector, 2026-10-03). Some required questions render as two visible Yes/No buttons
// over a hidden checkbox that HAS A NAME BUT NO ID, so a label[for] lookup resolves to nothing and an ancestor-text walk reaches only
// the zero-sized input. Hand every such field to the settled answer_by_checkbox tool, which anchors on input[type=checkbox][name].
const nameOnly = await page.evaluate(() => {
  const out = [];
  for (const box of document.querySelectorAll("div[class*=fieldEntry]")) {
    const cb = box.querySelector("input[type=checkbox]");
    if (!cb || !cb.name || cb.id) continue;
    const r = cb.getBoundingClientRect();
    out.push({ name: cb.name, checked: cb.checked === true, zero: r.width < 2 && r.height < 2, q: (box.innerText || "").replace(/\s+/g, " ").trim().slice(0, 130) });
  }
  return out;
});
for (const f of nameOnly) {
  if (f.checked) continue;
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(f.q); } catch { return false; } });
  if (!rule) { console.log(`  NAME-ONLY CHECKBOX with NO RULE: ${f.q.slice(0, 64)}`); continue; }
  const want = String(rule.answer).toLowerCase();
  if (!["yes", "no"].includes(want)) { console.log(`  NAME-ONLY CHECKBOX rule is not yes/no: ${f.q.slice(0, 50)}`); continue; }
  // DELEGATED TO THE UNIFIED TOOL (2026-10-06). `answer_by_checkbox.mjs` is one of the eight this migration folded
  // into `ashby_yesno.mjs`, and this name-only shape is the one that motivated the `--checkbox`/`--answer` pair: the
  // unified tool now presses it by the sibling label bound with `for`, confines its button search to the pair's own
  // container (otherwise it hit another pair's buttons), and verifies by re-reading the checkbox. Success is
  // `OK` at the start of a result line, not the old tool's `ANSWERED`.
  const out2 = run(["src/forms/ashby_yesno.mjs", part, "--checkbox", f.name, "--answer", want]);
  console.log(`  NAME-ONLY CHECKBOX ${want.toUpperCase()}: ${f.q.slice(0, 50)} -> ${/^\s*OK\s/m.test(out2) ? "ANSWERED" : "no answer"}`);
}

console.log(`hidden pairs: ${pairs.length}`);
let pairProblems = 0;
for (const p of pairs) {
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(p.q); } catch { return false; } });
  const want = rule ? String(rule.answer).toLowerCase() : null;
  if (!want || !["yes", "no"].includes(want)) { console.log(`  PAIR WITH NO RULE: "${p.q.slice(0, 70)}" (box=${p.checked})`); pairProblems++; continue; }
  const wanted = want === "yes";
  // NO SHORT-CIRCUIT HERE (Baseten Capacity, 2026-10-03): a hidden checkbox reading the wanted value is ambiguous - answered,
  // or never answered - and the server only registers an ANSWER when the settled tool presses the pair. The delegation below
  // therefore runs for every pair, even one that already looks correct.
  if (p.checked === wanted) console.log(`  ${want.toUpperCase()} looks set already; delegating anyway so the server sees an answer`);
  const target = p.opts.find((o) => new RegExp("^\\s*" + want, "i").test(o.text)) || (wanted ? p.opts[0] : p.opts[1]);
  // DELEGATE TO THE SETTLED TOOL (Baseten Capacity, 2026-10-03). answer_by_checkbox.mjs performs the opposite-then-wanted retry
  // correctly - its log reads before box=false, attempt 1 box=true - whereas the hand-written press logic below either skipped a
  // press the server still needed (leaving the field named as missing) or toggled an already-correct pair off. The settled tool
  // wins; the loop below remains only as a fallback.
  const delegated = run(["src/forms/ashby_yesno.mjs", part, "--checkbox", p.name, "--answer", want]);
  // read the pair state directly by its hidden checkbox name - no dependency on other helpers in this file
  const boxNow = await page.evaluate((name) => { const e = [...document.querySelectorAll("input[type=checkbox]")].find((x) => (x.name || "") === name); return e ? { name, checked: e.checked === true } : null; }, p.name);
  console.log(`  ${want.toUpperCase()} via ashby_yesno: ${/^\s*OK\s/m.test(delegated) ? "ANSWERED" : "no answer"} (checkbox=${boxNow ? boxNow.checked : "?"})`);
  if (boxNow && boxNow.checked === wanted) continue;
  let ok = false;
  for (const mode of ["locator click", "opposite then wanted"]) {
    if (mode === "opposite then wanted") {
      const opp = p.opts.find((o) => o !== target);
      if (opp && opp.index >= 0) { await page.locator("button").nth(opp.index).click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(450); }
    }
    await page.locator("button").nth(target.index).click({ timeout: 8000 }).catch((e) => console.log("     click error:", String(e).slice(0, 70)));
    await page.waitForTimeout(520);
    const now = await page.evaluate((name) => {
      const e = [...document.querySelectorAll("input[type=checkbox]")].find((x) => (x.name || "") === name);
      if (!e) return null;
      let box = e, states = [];
      for (let i = 0; i < 10 && box; i++) {
        const bs = [...box.querySelectorAll("button")].filter((x) => /^\s*(yes|no)\b/i.test((x.innerText || "").trim()));
        if (bs.length >= 2) { states = bs.map((x) => (x.innerText || "").trim().slice(0, 4) + "=" + (x.getAttribute("aria-pressed") || "?")); break; }
        box = box.parentElement;
      }
      return { checked: e.checked === true, states };
    }, p.name);
    console.log(`     ${mode}: checkbox=${now ? now.checked : "?"} ${JSON.stringify(now ? now.states : [])}`);
    if (now && now.checked === wanted) { ok = true; console.log(`  ${want.toUpperCase()} COMMITTED (checkbox is the proof): "${p.q.slice(0, 48)}"`); break; }
  }
  if (!ok) pairProblems++;
}
console.log(pairProblems ? `WARNING: ${pairProblems} pair(s) unresolved` : "all pairs resolved");

// DIV-RENDERED OPTION GROUPS (Benchling and Sierra, 2026-10-03): some required questions render as divs whose class contains
// _option_, with the SELECTED one carrying the class token true. They must be located by their OPTION TEXTS, because the
// ancestor-text heuristic can pick a completely different label and the group can sit above the current scroll position. This
// is how the field that appeared in a refusal as a bare U was finally answered - it was the U.S. Work Authorization Status
// group, and the honest choice for this candidate was Seeking work authorization.
const divGroups = await page.evaluate(() => {
  const seen = new Set(); const out = [];
  for (const o of document.querySelectorAll("div[class*=_option_]")) {
    const box = o.parentElement;
    if (!box || seen.has(box)) continue;
    seen.add(box);
    const opts = [...box.querySelectorAll("div[class*=_option_]")];
    if (opts.length < 2) continue;
    out.push({
      texts: opts.map((x) => (x.innerText || "").trim().slice(0, 60)),
      anySelected: opts.some((x) => /(^|\s)true(\s|$)/.test((x.className || "").toString())),
    });
  }
  return out;
});
for (const g of divGroups) {
  if (g.anySelected) continue;
  // NEVER TICK A LANGUAGE: the canonical profile records no languages, so any tick there would be an untrue claim.
  const LANGS = /^(English|Mandarin|Cantonese|Spanish|French|German|Greek|Hebrew|Italian|Japanese|Korean|Portuguese|Russian|Hindi|Arabic)$/i;
  if (g.texts.length && g.texts.every((tx) => LANGS.test(String(tx).trim()))) { console.log("  DIV GROUP skipped: language list (none are claimed)"); continue; }
  const rule = rules.find((r) => g.texts.some((tx) => { try { return new RegExp(String(r.questionRe || ""), "i").test(tx); } catch { return false; } }));
  // answer may be yes/no, or a SPECIFIC OPTION TEXT. The self-identification groups - age bracket, gender identity,
  // sexual orientation, ethnicity, communities - are answered by naming a category, so the rule carries that text in
  // option and the press below then matches it exactly among the group option texts.
  const want = rule ? (String(rule.answer).toLowerCase() === "option" ? String(rule.option || "") : String(rule.answer).toLowerCase()) : null;
  if (!want) { console.log(`  DIV GROUP unanswered with NO RULE: ${JSON.stringify(g.texts).slice(0, 110)}`); continue; }
  // isOpt is computed OUT HERE and passed IN: the arrow below runs in the page, where the Node-side `rule` object does not
  // exist. Writing rule.answer inside it threw a ReferenceError and silently aborted the whole div pass.
  const isOpt = String(rule.answer).toLowerCase() === "option";
  const pressed = await page.evaluate(({ texts, want, isOpt }) => {
    const boxes = new Set();
    for (const o of document.querySelectorAll("div[class*=_option_]")) if (o.parentElement) boxes.add(o.parentElement);
    for (const box of boxes) {
      const opts = [...box.querySelectorAll("div[class*=_option_]")];
      if (opts.length < 2) continue;
      if (JSON.stringify(opts.map((x) => (x.innerText || "").trim().slice(0, 60))) !== JSON.stringify(texts)) continue;
      // option-type rules match the option text EXACTLY; Man must never match Mandarin again
      const target = opts.find((x) => isOpt
        ? (x.innerText || "").trim().toLowerCase().startsWith(String(want).toLowerCase())
        : new RegExp("^\\s*" + want, "i").test((x.innerText || "").trim()));
      if (!target) return null;
      target.scrollIntoView({ block: "center" });
      const r = target.getBoundingClientRect();
      // A div option can WRAP A REAL RADIO INPUT, and that input is what the server reads (Sierra, 2026-10-03).
      // Clicking the div alone pressed the option without committing it, and the server kept naming the question.
      const inner = target.querySelector("input[type=radio], input[type=checkbox]");
      if (inner && inner.id) { inner.scrollIntoView({ block: "center" }); return { radioId: inner.id, label: (target.innerText || "").trim().slice(0, 52) }; }
      return { x: Math.round(r.x + Math.min(r.width, 220) / 2), y: Math.round(r.y + r.height / 2), label: (target.innerText || "").trim().slice(0, 52) };
    }
    return null;
  }, { texts: g.texts, want, isOpt });
  if (!pressed) { console.log(`  DIV GROUP: no option starting with ${want} among ${JSON.stringify(g.texts).slice(0, 90)}`); continue; }
  if (pressed.radioId) {
    const rl = page.locator(`[id="${pressed.radioId}"]`).first();
    await rl.scrollIntoViewIfNeeded().catch(() => {});
    await rl.check({ timeout: 8000 }).catch(async () => { await rl.click({ timeout: 8000 }).catch(() => {}); });
    await page.waitForTimeout(500);
    console.log(`  DIV OPTION checked via its radio: ${pressed.label} -> ${await page.evaluate((id) => { const e = document.getElementById(id); return e ? e.checked : null; }, pressed.radioId)}`);
  } else {
    await page.mouse.click(pressed.x, pressed.y);
    await page.waitForTimeout(620);
    console.log(`  DIV OPTION pressed: ${pressed.label}`);
  }
}

// LOCATION LAST OF THE FIELDS (Notion, 2026-10-03): this tenant has a Location autocomplete that the spec does not cover,
// and its committed value is the hidden sibling the settled picker writes, so use that picker rather than typing.
//
// THE PLACE IS A FACT ABOUT THE CANDIDATE, SO IT COMES FROM THE PROFILE (2026-10-13). This step used to read
//   const city = process.env.ASHBY_LOCATION_CITY || "San Francisco";
// and weld ", California, United States" onto it, while the picker's acceptance test stayed on "california" - so a
// candidate who does not live in California had a US address typed into the field and an expectation no Canadian or
// European row can satisfy, which ends as "NOT COMMITTED" and reads like a widget failure rather than like the
// wrong address it is. `application_profile.json -> candidate.address` held the answer all along: the same three
// fields `greenhouse_standard.mjs` reads and `src/pipeline/application_pipeline.py`'s `ats_place` joins.
// `ASHBY_LOCATION_CITY` keeps working as an override of the CITY only - the state and country are not the override's
// to change - and with no address at all nothing is typed, because a blank location is visible in the audit while a
// plausible-looking city nobody recorded is a claim about the candidate.
const ASHBY_ADDRESS = locationAddress(CAND.address, process.env.ASHBY_LOCATION_CITY);
try {
  if (!ASHBY_ADDRESS) {
    console.log("  location: no candidate.address in application_profile.json and no ASHBY_LOCATION_CITY - field left alone");
  } else {
    const out2 = run(["src/forms/ashby_location_keys.mjs", part, ASHBY_ADDRESS, "3"]);
    const line = out2.split("\n").filter((l) => /COMMITTED|not found/.test(l)).slice(-1)[0] || "";
    console.log("  location:", line.trim().slice(0, 90));
  }
} catch (e) { console.log("  location step failed:", String(e).slice(0, 60)); }

// VALUE-TYPE STANDING RULES FOR PLAIN TEXT QUESTIONS (2026-10-03). Some questions are text, not a choice, and their answer is a
// fixed canonical value rather than yes/no - Sierra icebreaker asking for a favourite junk food is the example, and the user
// supplied that answer directly. Runs before the resume attach so the resume still goes on last.
const valueRules = rules.filter((r) => String(r.answer).toLowerCase() === "value" && r.value);
for (const rule of valueRules) {
  const target = await page.evaluate((re) => {
    const rx = new RegExp(re, "i");
    for (const e of document.querySelectorAll("input, textarea")) {
      if (["hidden", "file", "checkbox", "radio", "submit", "button"].includes(e.type)) continue;
      const r0 = e.getBoundingClientRect();
      if (r0.width === 0 || r0.height === 0) continue;
      if ((e.value || "").trim()) continue;
      let w = e, q = "";
      for (let i = 0; i < 20 && w; i++) { const s = (w.innerText || "").replace(/\s+/g, " ").trim(); if (s && s.length > 4 && s.length < 400) { q = s; break; } w = w.parentElement; }
      if (!rx.test(q)) continue;
      if (!e.id) return null;
      return e.id;
    }
    return null;
  }, String(rule.questionRe || ""));
  if (!target) { console.log(`  VALUE RULE ${rule.questionRe}: no empty matching field`); continue; }
  const vloc = page.locator(`[id="${target}"]`).first();
  await vloc.scrollIntoViewIfNeeded().catch(() => {});
  await vloc.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(180);
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(rule.value), { delay: 20 });
  await page.waitForTimeout(260);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(420);
  console.log(`  VALUE RULE ${rule.questionRe} -> "${(await vloc.inputValue().catch(() => "")) || ""}"`);
}

try { await page.setInputFiles("#_systemfield_resume", pdf); await page.waitForTimeout(1700); console.log("resume attached"); } catch { console.log("resume issue"); }
console.log("RE-VERIFY:", JSON.stringify((await labelMap()).map((m) => `${m.label.slice(0, 26)}=${m.value.length}`)).slice(0, 520));

// standing-table exceptions stay visible: they are recorded as acknowledged so the SERVER arbitrates, never silently ignored
// FINAL RADIO RE-ASSERT, IMMEDIATELY BEFORE THE GATE (2026-10-03). Order matters and this was the last piece of it: the
// div-option pass runs AFTER the first radio pass, and pressing a div option re-renders the form, which can CLEAR the radio
// groups answered earlier. That is why some tenants submitted and others came back with needs corrections naming a question
// whose radio had read checked moments before. Re-assert every rule-driven radio group here, after all presses and after the
// resume, so the state the server validates is the state we set last.
const finalGroups = await page.evaluate(() => {
  const out = [];
  for (const f of document.querySelectorAll("fieldset")) {
    const q = (f.innerText || "").replace(/\s+/g, " ").trim();
    if (!q || q.length > 300) continue;
    const rs = [...f.querySelectorAll("input[type=radio]")];
    if (rs.length < 2 || rs.length > 3) continue;
    out.push({ q: q.slice(0, 130), opts: rs.map((r) => { let lab = r.id ? document.querySelector(`label[for="${r.id}"]`) : null; if (!lab) lab = r.closest("label") || r.parentElement; return { label: (lab.innerText || "").trim().slice(0, 30), id: r.id || "", checked: r.checked === true }; }) });
  }
  return out;
});
for (const g of finalGroups) {
  // match against the QUESTION first, then against the group OPTION LABELS - option-text rules such as Seeking work
  // authorization are written against the choice, not the question, and the div pass has always matched that way.
  const rule = rules.find((r) => { try { return new RegExp(String(r.questionRe || ""), "i").test(g.q); } catch { return false; } })
    || rules.find((r) => (g.opts || []).some((o) => { try { return new RegExp(String(r.questionRe || ""), "i").test(String(o.label || "")); } catch { return false; } }));
  if (!rule) continue;
  const w = String(rule.answer).toLowerCase() === "option" ? String(rule.option || "") : String(rule.answer).toLowerCase();
  const hit = g.opts.find((o) => new RegExp("^\\s*" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(o.label));
  if (!hit || !hit.id || hit.checked) continue;
  const fl = page.locator(`[id="${hit.id}"]`).first();
  await fl.scrollIntoViewIfNeeded().catch(() => {});
  await fl.check({ timeout: 8000 }).catch(async () => { await fl.click({ timeout: 8000 }).catch(() => {}); });
  console.log(`  FINAL RADIO RE-ASSERT ${w}: ${g.q.slice(0, 44)} -> ${await page.evaluate((id) => { const e = document.getElementById(id); return e ? e.checked : null; }, hit.id)}`);
}

// RE-APPLY THE TEXTS BEFORE THE GATE. Pressing the pairs above re-renders the form and clears the text inputs beside
// them, which made the server refuse with "Missing entry for required field: Name Email LinkedIn Phone ..." on a form
// apply_form_spec had filled. Writing the texts last is the same ordering rule the Lever cards taught. The spec is
// already validated by spec_guard (assertNoSubmit), so this cannot press anything.
{
  const specPath = join(DATA_DIR, "form_specs", `${profile}.spec.json`);
  if (existsSync(specPath)) {
    const refill = run(["src/forms/apply_form_spec.mjs", specPath]);
    const okLines = (refill.match(/OK\s+/g) || []).length;
    const stillBlank = (refill.match(/=== still blank ===\s*(\d+)/) || [])[1];
    console.log(`  TEXTS REFILLED before the gate: ${okLines} field(s) OK, still blank ${stillBlank ?? "?"}`);
  } else {
    console.log("  no spec to refill (expected", specPath + ")");
  }
}

// EXPECT A FIELD ONLY WHEN THE FORM ACTUALLY HAS IT (fixed 2026-10-07, Alpaca Health). The LinkedIn expectation was
// hardcoded, so on a requisition whose form carries no LinkedIn field the gate could never be satisfied and it
// refused a completely filled form - the finisher's own line above had already reported "linkedin: no label match"
// and that verdict was being thrown away. The name expectation stays unconditional: every Ashby form asks for it.
const expectations = [{ kind: "valueIs", value: IDENTITY.name }];
if (linkedinOk) expectations.push({ kind: "valueMatch", re: "linkedin\\.com/in/" });
else console.log("  gate note: this form has no LinkedIn field, so no LinkedIn expectation is asserted.");

const args = ["src/forms/verify_and_submit.mjs", part, profile, "--company", company, "--expect", JSON.stringify(expectations)];
for (const q of ["work from our offices", "require Notion to sponsor"]) args.push("--ack-pair", q);
const out = run(args);
console.log(out.trim().split("\n").filter((l) => /GATE|confirmed|finalUrl|   x |   ! |submitting/.test(l)).join("\n"));
console.log("=== CONFIRMED:", /"confirmed":\s*true/.test(out), "===");
await page.waitForTimeout(2600);
const after = await page.evaluate(() => {
  const x = (document.body.innerText || "").replace(/\s+/g, " ");
  const m = x.match(/(thank you[^.]{0,240}|successfully submitted[^.]{0,90}|Missing entry[^.]{0,340})/i);
  return { inputs: document.querySelectorAll("input").length, thanks: m ? m[0].slice(0, 340) : "" };
});
console.log("AFTER inputs:", after.inputs, "| msg:", after.thanks || "(none captured)");
process.exit(pairProblems ? 1 : 0);
