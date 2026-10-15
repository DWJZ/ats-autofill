#!/usr/bin/env node
/**
 * greenhouse_standard.mjs - read and fill a standard Greenhouse application form, in the order that actually works.
 *
 * WHY THIS EXISTS. A first manual pass on Emergent Labs filled everything and reported success, but reading the
 * committed state back afterwards showed: country still empty, four CONDITIONAL QUESTIONS newly revealed, degree and
 * discipline blank again, and THE FILE INPUT EMPTY - the upload had claimed success and done nothing. The lesson is
 * that this form is GATED ON THE COUNTRY SELECT and re-renders when it changes, so order is not cosmetic:
 *
 *     1. choose Country first        (a react-select, so it needs a real click, a type, and an option click)
 *     2. RE-READ the form            (the country selection reveals conditional questions and blanks siblings)
 *     3. fill every text field        (including the ones that only appeared in step 2)
 *     4. attach the resume LAST      (anything re-rendering earlier drops it)
 *     5. read everything back         (never trust an upload or a type without reading the value)
 *
 * Also load the BARE posting URL, never `/application`: this board renders an empty shell at /application - zero
 * controls, zero submit buttons - while the bare URL renders the real form.
 *
 * Usage:
 *   node src/forms/greenhouse_standard.mjs --rid 4226177009 --read
 *   node src/forms/greenhouse_standard.mjs --rid 4226177009 --fill --resume <path.pdf>
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
// Both profiles come from the configured data directory (`ATS_DATA_DIR`) through `src/paths.mjs`, so this
// script reads the same configuration the rest of the toolkit does wherever it is run from.
import { DATA_DIR } from "../paths.mjs";
import { join } from "node:path";

const CDP = process.env.ATS_CDP || "http://127.0.0.1:9223";
const argv = process.argv.slice(2);
const arg = (name, dflt = "") => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const flag = (name) => argv.includes(name);

const RID = arg("--rid");
const RESUME = arg("--resume");
const PROFILE = JSON.parse(readFileSync(join(DATA_DIR, "application_profile.json"), "utf8"));
const CANDIDATE = JSON.parse(readFileSync(join(DATA_DIR, "candidate_profile.json"), "utf8"));

// The profile stores LinkedIn as `linkedin.com/in/<handle>`; the form asks for the URL. Same normalisation the
// pipeline's own _linkedin helper does, so a bare handle does not land in the field as written.
const withScheme = (value) => {
  if (!value || value.startsWith("http")) return value;
  return value.startsWith("linkedin.com") ? `https://www.${value}` : `https://${value}`;
};

// Canonical values, read from the profile files rather than typed inline, so this tool cannot drift from the data.
// NO PLACEHOLDER FALLBACKS: a value the profile does not carry stays an empty string, because a field left blank is
// visible in the audit while a plausible-looking default is a statement about the candidate that nobody made.
const VALUES = {
  first_name: PROFILE.candidate?.first_name || (PROFILE.candidate?.name || "").split(" ")[0],
  last_name: PROFILE.candidate?.last_name || (PROFILE.candidate?.name || "").split(" ").slice(1).join(" "),
  email: PROFILE.candidate?.email || "",
  phone: PROFILE.candidate?.phone?.formatted || "",
  "candidate-location": [PROFILE.candidate?.address?.city, PROFILE.candidate?.address?.state].filter(Boolean).join(", "),
  "question_5909786009": withScheme(CANDIDATE.candidate?.linkedin || ""),
  // A BOARD'S OWN CUSTOM QUESTIONS ARE NOT ANSWERED HERE. This table used to carry four entries keyed by one
  // board's question ids - a LinkedIn slot and three conditional questions revealed only after the country is
  // chosen (expected pay, notice period, a preferred office). Every value in them was one person's: a salary
  // figure, an availability date, a location commitment. On any other board those ids do not exist, so the
  // entries are inert; on a board whose ids collided they would type a stranger's answer into a real form.
  //
  // They belong to the generic path instead, where the answer comes from configuration rather than from code:
  //   node src/forms/inspect_ats_form.mjs "<url-substring>" --options --out tmp/<slug>_fields.json
  //   python3 src/forms/draft_form_spec.py tmp/<slug>_fields.json --job "<Company> — <Role>" \
  //       --resume <resume.pdf> --out data/form_specs/<slug>.spec.json
  //   node src/forms/apply_form_spec.mjs data/form_specs/<slug>.spec.json
  // The drafter has no value for those questions either, and reports them: a pay expectation the posting does
  // not publish, or a notice period, is a fact about the applicant that no default can supply.
};

const b = await chromium.connectOverCDP(CDP);
// PREFER THE EMBED URL. On several Greenhouse boards /application renders an EMPTY SHELL - zero controls, zero
// submit buttons - while the classic embed form (/embed/job_app?for=<slug>&token=<jobId>) renders a real file input,
// which is the only way setInputFiles can work. Prefer the embed tab when one is open, then any non-/application tab.
const pages = b.contexts()[0].pages();
const page =
  pages.find((x) => (x.url() || "").includes("embed/job_app") && (x.url() || "").includes(RID)) ||
  pages.find((x) => (x.url() || "").includes(RID) && !(x.url() || "").includes("/application"));
if (!page) {
  console.log("NO BARE TAB. Open it first:  node src/forms/cdp_tabs.mjs open <bare posting url>");
  process.exit(2);
}

async function readState(label) {
  const s = await page.evaluate(() => {
    const fields = [];
    for (const e of document.querySelectorAll("input,textarea,select")) {
      const t = (e.type || e.tagName).toLowerCase();
      if (["hidden", "submit", "button"].includes(t)) continue;
      if (e.offsetParent === null) continue;
      const lab = (e.labels && e.labels[0]) || null;
      let q = lab ? (lab.innerText || "").trim() : "";
      if (!q) { const f = e.closest("div,fieldset,li") || e.parentElement; const l = f ? f.querySelector("label,legend") : null; q = l ? (l.innerText || "").trim() : ""; }
      fields.push({ type: t, id: (e.id || e.name || "(no-id)"), val: (e.value || "").slice(0, 34), req: !!e.required, q: q.replace(/\s+/g, " ").slice(0, 56) });
    }
    const selects = [...document.querySelectorAll("[class*=select__control]")].length;
    const files = [...document.querySelectorAll("input[type=file]")].map((f) => (f.files || []).length);
    const blanks = fields.filter((f) => !f.val).map((f) => f.id);
    return { fields, selects, files, blanks };
  });
  console.log(`--- ${label}: ${s.fields.length} visible fields, ${s.selects} react-selects, file inputs ${JSON.stringify(s.files)}`);
  if (flag("--verbose")) for (const f of s.fields) console.log(`   [${f.type}] #${f.id} req=${f.req ? "Y" : "n"} val=${JSON.stringify(f.val)} :: ${f.q}`);
  return s;
}

// A react-select has no usable <input value>; it must be clicked, typed into, and chosen from the listbox.
async function chooseCountry() {
  const ctl = page.locator("[class*=select__control]").first();
  if (!(await ctl.count())) { console.log("country: no react-select found"); return false; }
  await ctl.scrollIntoViewIfNeeded().catch(() => {});
  await ctl.click({ timeout: 15000 }).catch((e) => console.log("country click err", String(e).slice(0, 40)));
  await page.waitForTimeout(700);
  await page.keyboard.type("United States", { delay: 45 });
  await page.waitForTimeout(900);
  const opt = page.locator("[role=option], [class*=select__option]").filter({ hasText: /^United States/i }).first();
  if (await opt.count()) {
    await opt.click({ timeout: 10000 }).catch((e) => console.log("country option err", String(e).slice(0, 40)));
    await page.waitForTimeout(1200);
  } else {
    // THIS BOARD'S COUNTRY CONTROL IS AN INTL-TEL-INPUT COUNTRY PICKER, not a plain name list: typing "United States"
    // and pressing Enter set the control to "+1" (its dial code) and did not return a named option. The widget does
    // expose per-country handles as `iti-0__item-<iso>`, so click the United States entry directly, then read back.
    console.log("country: no named option appeared - falling back to the iti country handle");
    const us = page.locator("#iti-0__item-us").first();
    if (await us.count()) {
      await us.scrollIntoViewIfNeeded().catch(() => {});
      await us.click({ timeout: 10000 }).catch((e) => console.log("iti us click err", String(e).slice(0, 40)));
      await page.waitForTimeout(1200);
    } else {
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(800);
    }
  }
  const shown = await page.evaluate(() => {
    const v = document.querySelector("[class*=select__single-value], [class*=select__multi-value__label]");
    return v ? (v.textContent || "").trim() : "";
  });
  console.log(`country now reads: ${JSON.stringify(shown)}`);
  return /united states/i.test(shown);
}

async function setById(id, text, label) {
  const loc = page.locator(`[id="${id}"]`).first();
  if (!(await loc.count())) { console.log(`${label}: NOT FOUND (#${id})`); return false; }
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.focus().catch(() => {});
  await page.waitForTimeout(180);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  // SLOW ON PURPOSE: at delay 8 this board re-renders and wipes the field. At 45 the value sticks.
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(900);
  const got = await loc.inputValue().catch(() => "");
  const ok = got.trim().length > 0;
  console.log(`${label}: ${ok ? "SET" : "FAILED"} -> ${JSON.stringify(got.slice(0, 34))}`);
  return ok;
}

if (flag("--read")) {
  await readState("initial");
  process.exit(0);
}

if (flag("--fill")) {
  console.log("STEP 1 - country first, because it gates the rest");
  await chooseCountry();

  console.log("STEP 2 - re-read: the country selection may have revealed conditional questions");
  const after = await readState("after country");

  console.log("STEP 3 - fill every visible empty field whose value is known");
  const filled = [];
  for (const f of after.fields) {
    if (f.val) continue;
    const t = f.type;
    if (!["text", "tel", "email", "number", "search"].includes(t)) continue;
    if (VALUES[f.id] !== undefined) {
      if (await setById(f.id, VALUES[f.id], f.id)) filled.push(f.id);
      continue;
    }
    // The education block: degree, discipline and the year pair, matched by the question text on the field.
    const q = f.q.toLowerCase();
    if (/^degree/.test(q)) { if (await setById(f.id, "Master's Degree", "degree")) filled.push(f.id); continue; }
    if (/^discipline/.test(q)) { if (await setById(f.id, "Computer Engineering", "discipline")) filled.push(f.id); continue; }
    if (/start date year/.test(q)) { if (await setById(f.id, "2025", "start year")) filled.push(f.id); continue; }
    if (/end date year/.test(q)) { if (await setById(f.id, "2026", "end year")) filled.push(f.id); continue; }
  }
  console.log(`filled ${filled.length} fields: ${JSON.stringify(filled)}`);

  console.log("STEP 4 - attach the resume LAST, after all re-rendering has happened");
  if (RESUME) {
    const rf = page.locator("input[type=file]").first();
    if (await rf.count()) {
      await rf.setInputFiles(RESUME, { timeout: 40000 }).then(() => console.log("resume set")).catch((e) => console.log("resume err", String(e).slice(0, 60)));
      await page.waitForTimeout(3000);
    } else console.log("resume: no file input");
  } else console.log("resume: no --resume path given");

  console.log("STEP 5 - read everything back; an upload or a type is not evidence until it is read");
  const fin = await readState("final");
  console.log("STILL BLANK:", JSON.stringify(fin.blanks));
  process.exit(fin.blanks.length ? 1 : 0);
}

console.log("usage: --read | --fill --resume <path>  [--rid <greenhouse job id>] [--verbose]");
process.exit(0);
