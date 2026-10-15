/**
 * diagnose_open_forms.mjs — report, for EVERY open application tab, exactly where it is stuck.
 *
 * Reads each page's own state rather than trusting a remembered note: how many controls it has, which REQUIRED
 * fields are still blank, whether a submit button exists and is enabled, what the page's own text says, and any
 * visible error text. That is enough to distinguish the four different reasons a tab can be sitting open:
 *
 *   form_still_open   - a normal unfinished form (blanks listed)
 *   ready_to_submit   - every required field filled and the submit button enabled
 *   empty_shell       - a Greenhouse /application page with no controls (the driveable form is the embed URL)
 *   posting_or_other  - a job posting page, or something that is not a form at all
 *
 * Usage: node src/forms/diagnose_open_forms.mjs [--cdp http://127.0.0.1:9223]
 */
import { chromium } from "playwright-core";

const cdpIndex = process.argv.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? process.argv[cdpIndex + 1] : "http://127.0.0.1:9223";
const browser = await chromium.connectOverCDP(cdp);
const pages = browser.contexts()[0].pages();

const ATS = /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|smartrecruiters\.com/;

for (const p of pages) {
  const url = p.url() || "(no url)";
  let info;
  try {
    info = await p.evaluate(() => {
      const controls = [...document.querySelectorAll("input,textarea,select")].filter(
        (e) => !["hidden", "submit", "button", "file"].includes((e.type || "").toLowerCase()) && e.offsetParent !== null
      );
      const blankRequired = [];
      for (const e of controls) {
        const req = !!(e.required || e.getAttribute("aria-required") === "true");
        if (!req) continue;
        let isBlank = !(e.value || "").trim();
        if ((e.type || "").toLowerCase() === "checkbox" || (e.type || "").toLowerCase() === "radio") isBlank = !e.checked;
        if (isBlank) {
          let q = "";
          if (e.labels && e.labels[0]) q = (e.labels[0].innerText || "").trim();
          if (!q) {
            const li = e.closest("li.application-question");
            const lab = li ? li.querySelector(".application-label .text") : null;
            if (lab) q = (lab.innerText || "").trim();
          }
          if (!q) { const f = e.closest("div,fieldset,li") || e.parentElement; const l = f ? f.querySelector("label,legend") : null; q = l ? (l.innerText || "").trim() : ""; }
          blankRequired.push({ name: (e.name || e.id || "?").slice(0, 40), q: q.replace(/\s+/g, " ").slice(0, 70) });
        }
      }
      const submit = [...document.querySelectorAll('button,input[type=submit]')].find((b) => /submit/i.test(b.innerText || b.value || ""));
      const errors = [...document.querySelectorAll("[class*=error], .application-error")]
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t && !/exceeds the maximum upload size/i.test(t))
        .slice(0, 3);
      const body = (document.body.innerText || "").replace(/\s+/g, " ");
      return {
        controls: controls.length,
        fileInputs: [...document.querySelectorAll("input[type=file]")].map((f) => (f.files || []).length),
        blankRequired,
        submitFound: !!submit,
        submitDisabled: submit ? !!submit.disabled : null,
        errors,
        head: body.slice(0, 150),
      };
    });
  } catch (e) {
    info = { err: String(e).slice(0, 60) };
  }

  let kind = "posting_or_other";
  if (info.controls === 0 && /\/application/.test(url) && ATS.test(url)) kind = "empty_shell";
  else if (info.controls > 0) kind = (info.blankRequired.length === 0 && info.submitFound && !info.submitDisabled) ? "ready_to_submit" : "form_still_open";

  console.log("=".repeat(100));
  console.log(`${kind}  ${url}`);
  if (info.err) { console.log(`   ERROR: ${info.err}`); continue; }
  console.log(`   controls=${info.controls} files=${JSON.stringify(info.fileInputs)} submit=${info.submitFound}${info.submitDisabled === null ? "" : `(disabled=${info.submitDisabled})`}`);
  if (info.blankRequired.length) {
    console.log(`   BLANK REQUIRED (${info.blankRequired.length}):`);
    for (const b of info.blankRequired.slice(0, 8)) console.log(`      ${b.name} :: ${b.q}`);
  }
  if (info.errors.length) for (const e of info.errors) console.log(`   ERROR TEXT: ${e.slice(0, 120)}`);
  console.log(`   page says: ${info.head}`);
}
process.exit(0);
