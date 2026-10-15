#!/usr/bin/env node
/**
 * submit_ashby_application.mjs — press Submit on a filled Ashby application and verify success.
 *
 * Usage:
 *   node src/forms/submit_ashby_application.mjs <url-substring> <slug> [--cdp http://127.0.0.1:9223]
 *
 * The CDP default is 9223, the project instance. It previously hard-coded 9222, which belongs to a
 * Chrome, which this project must never drive — so the script could never find a project tab.
 *
 * Ashby shows no confirmation URL: success renders "Application Success — Your application was
 * successfully submitted." somewhere in the page, so the whole body text is searched (an earlier
 * helper only looked at the first 300 characters and reported false negatives). Before/after
 * screenshots and a result JSON are written to tmp/pre_submit/.
 *
 * Exit codes: 0 = confirmed, 2 = no submit button, 4 = not confirmed.
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../paths.mjs";
// Telemetry must never break a submission: see submit_with_verification_code.mjs.
const { recordLedger, SUBMIT } = await import("./_ledger.mjs")
  .catch(() => ({ recordLedger: () => null, SUBMIT: "submit" }));

const argv = process.argv.slice(2);
const cdpFlag = argv.indexOf("--cdp");
const cdpUrl = cdpFlag >= 0 ? argv[cdpFlag + 1] : "http://127.0.0.1:9223";
const positional = argv.filter((a, i) => !a.startsWith("--") && (cdpFlag < 0 || i !== cdpFlag + 1));
const [urlSub, slug] = positional;
if (!urlSub || !slug) {
  console.error("usage: node src/forms/submit_ashby_application.mjs <url-substring> <slug> [--cdp http://127.0.0.1:9223]");
  process.exit(1);
}
// Output paths are derived from THIS FILE's location, so the script works from any checkout and from any
// working directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, "tmp", "pre_submit");

// The standing answer table: what recurring questions are answered with, per wording. Read once, and a
// failure to read it is REPORTED - an empty table means every post-submit question is left for a person,
// which is the safe direction but not a silent one.
const STANDING_RULES = (() => {
  const path = join(DATA_DIR, "form_specs", "ashby_pairs_standing.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")).rules || [];
  } catch (error) {
    console.error(`cannot read the standing answer table ${path}: ${String(error).slice(0, 120)}`);
    return [];
  }
})();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages().find(p => p.url().includes(urlSub) && !/confirmation|thank/i.test(p.url()));
if (!page) { console.error("tab not found"); process.exit(3); }
page.setDefaultTimeout(15000);

await page.screenshot({ path: `${OUT}/${slug}_before_submit.png`, fullPage: false }).catch(() => {});

// Some Ashby tenants (Plaid, for one) show a cookie-consent banner that intercepts every click on
// the submit button until it is dismissed.
for (const pattern of [/^accept all$/i, /^necessary only$/i, /^accept( cookies)?$/i]) {
  const banner = page.getByRole("button", { name: pattern }).first();
  if (await banner.count() > 0) {
    await banner.click({ force: true }).catch(() => {});
    await sleep(700);
    break;
  }
}

let button = page.getByRole("button", { name: /submit application/i }).first();
if (await button.count() === 0) button = page.locator('button:has-text("Submit Application")').first();
if (await button.count() === 0) button = page.locator('button:has-text("Submit")').first();
if (await button.count() === 0) { console.error("no submit button"); process.exit(2); }
await button.scrollIntoViewIfNeeded().catch(() => {});

const clickAndWait = async () => {
  await button.click({ timeoutMs: 15000 }).catch(async error => {
    console.error("click failed:", error.message.split("\n")[0]);
    await button.click({ force: true, timeoutMs: 15000 }).catch(() => {});
  });
  console.log("clicked Submit…");
  let confirmed = false;
  let text = "";
  let errorTexts = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(2500);
    const state = await page.evaluate(() => ({
      url: location.href,
      body: (document.body.innerText || "").replace(/\s+/g, " "),
      errors: [...document.querySelectorAll("[class*=error],[role=alert]")]
        .map(element => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 3),
    })).catch(() => ({ url: page.url(), body: "", errors: [] }));
    text = state.body;
    errorTexts = state.errors;
    if (/application success|successfully submitted|thank you for applying/i.test(state.body)) { confirmed = true; break; }
    if (state.body && !/submit application/i.test(state.body)) break; // form gone: inspect the captured text
  }
  return { confirmed, text, errorTexts };
};

let { confirmed: ok, text: body, errorTexts: errors } = await clickAndWait();

/**
 * Ashby's custom radio and Yes/No button groups can end up visually active while the form model never
 * registered the change, so the server answers "Missing entry for required field: <question>" even
 * though the control looks chosen. Re-activating the option (via the other option first, so the
 * handler definitely fires) repairs it. Returns the labels it touched.
 */
const repairMissingChoiceField = async label => {
  const entry = page.locator('[data-field-path]').filter({ has: page.locator(`label:text-is("${label}")`) }).first();
  if (await entry.count() === 0) {
    // fall back to a prefix match ("...?" vs "...? " differences, long labels)
    const handle = await page.evaluateHandle(text => {
      const clean = value => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = clean(text);
      return [...document.querySelectorAll("[data-field-path]")].find(element =>
        clean(element.querySelector("label")?.innerText || "").startsWith(wanted.slice(0, 40))) || null;
    }, label);
    const element = handle.asElement();
    if (!element) return false;
    const buttons = element.locator("button");
    const count = await buttons.count();
    if (count > 0) {
      let active = -1;
      for (let i = 0; i < count; i += 1) {
        if ((await buttons.nth(i).getAttribute("aria-pressed")) === "true") { active = i; break; }
      }
      const keep = active >= 0 ? active : 0;
      const other = keep === 0 ? Math.min(1, count - 1) : 0;
      await buttons.nth(other).click({ timeoutMs: 8000 }).catch(() => {});
      await sleep(400);
      await buttons.nth(keep).click({ timeoutMs: 8000 }).catch(() => {});
      await sleep(400);
      return true;
    }
    const radios = element.locator('input[type="radio"]');
    const radioCount = await radios.count();
    for (let i = 0; i < radioCount; i += 1) {
      if (await radios.nth(i).isChecked().catch(() => false)) {
        const other = i === 0 ? Math.min(1, radioCount - 1) : 0;
        await radios.nth(other).click({ force: true, timeoutMs: 8000 }).catch(() => {});
        await sleep(400);
        await radios.nth(i).click({ force: true, timeoutMs: 8000 }).catch(() => {});
        await sleep(400);
        return true;
      }
    }
    return false;
  }
  const buttons = entry.locator("button");
  const count = await buttons.count();
  if (count > 0) {
    let active = -1;
    for (let i = 0; i < count; i += 1) {
      if ((await buttons.nth(i).getAttribute("aria-pressed")) === "true") { active = i; break; }
    }
    const keep = active >= 0 ? active : 0;
    const other = keep === 0 ? Math.min(1, count - 1) : 0;
    await buttons.nth(other).click({ timeoutMs: 8000 }).catch(() => {});
    await sleep(400);
    await buttons.nth(keep).click({ timeoutMs: 8000 }).catch(() => {});
    await sleep(400);
    return true;
  }
  return false;
};

if (!ok) {
  // Phone: Ashby's national-number field can show "+1 ..." while the model stays empty.
  if (errors.some(error => /required field: phone number/i.test(error))) {
    const tel = page.locator('input[type="tel"]').first();
    if (await tel.count() > 0) {
      const current = await tel.inputValue().catch(() => "");
      const digits = current.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      if (digits) {
        console.log("retrying with national phone digits:", digits);
        await tel.click({ timeoutMs: 8000 }).catch(() => {});
        await page.keyboard.press("ControlOrMeta+a").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.type(digits, { delay: 40 });
        await page.keyboard.press("Tab").catch(() => {});
        await sleep(800);
      }
    }
  }
  // Required choice fields that look answered but were never registered.
  const missing = [...new Set(errors.flatMap(error =>
    [...error.matchAll(/required field:\s*([^]*?)(?=(?:Missing entry)|$)/gi)].map(match => match[1].trim())
  ))].filter(Boolean);
  for (const label of missing.slice(0, 4)) {
    const repaired = await repairMissingChoiceField(label);
    console.log(repaired ? `re-activated choice field: ${label.slice(0, 70)}` : `could not re-activate: ${label.slice(0, 70)}`);
  }
  if (missing.length > 0 || errors.some(error => /required field: phone number/i.test(error))) {
    ({ confirmed: ok, text: body, errorTexts: errors } = await clickAndWait());
  }
}
// POST-SUBMIT STEP (Coder, 2026-10-04). Ashby can render an extra REQUIRED question only AFTER the first Submit
// click, and it reports NOTHING about it: the result is confirmed:false with an EMPTY errors array while every
// visible field is verifiably filled. The error-driven repair above therefore never fires, and the application sits
// one click short of done. The question seen in the wild is the sponsorship one. What it is ANSWERED WITH comes
// from the standing answer table, not from a value written here: this used to click "Yes" unconditionally,
// which was right for one person's profile and wrong for everyone else - a profile whose `sponsorship_required`
// is No would have been answered Yes, in the one field where a wrong answer is a false statement to an employer.
async function answerPostSubmitStep() {
  const prompts = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("input,textarea,select")) {
      const t = (el.type || el.tagName).toLowerCase();
      if (["hidden", "file", "submit", "button"].includes(t)) continue;
      if (el.offsetParent === null) continue;
      let q = "";
      const lab = el.labels && el.labels[0];
      if (lab) q = (lab.innerText || "").trim();
      if (!q) {
        let w = el;
        for (let k = 0; k < 6 && w; k++) {
          const x = (w.innerText || "").replace(/\s+/g, " ").trim();
          if (x.length > 8 && x.length < 240) { q = x; break; }
          w = w.parentElement;
        }
      }
      if (/sponsor|visa|legally authoriz|authorized to work|eligible to work/i.test(q)) {
        out.push({ name: el.name || el.id || "", type: t, q: q.replace(/\s+/g, " ").slice(0, 120) });
      }
    }
    return out;
  });
  if (!prompts.length) return false;
  const seen = new Set();
  const leftForAPerson = [];
  for (const pr of prompts) {
    if (pr.q && seen.has(pr.q)) continue;
    if (pr.q) seen.add(pr.q);
    // WHAT TO ANSWER COMES FROM THE TABLE, matched on the question's own wording. A question no rule claims
    // is left alone and named, because the alternative - guessing - is how a sponsorship question ends up
    // answered the wrong way round.
    const rule = STANDING_RULES.find((r) => {
      try { return new RegExp(String(r.questionRe || ""), "i").test(pr.q); } catch { return false; }
    });
    const want = rule ? String(rule.answer || "").trim().toLowerCase() : "";
    if (!["yes", "no"].includes(want)) {
      console.log(`  LEFT FOR A PERSON (${rule ? `the matching rule answers "${want}"` : "no standing rule"}): ${pr.q}`);
      leftForAPerson.push(pr.q);
      continue;
    }
    const btn = page.locator("label,span,div,button").filter({ hasText: new RegExp(`^${want}$`, "i") }).first();
    if (!(await btn.count())) continue;
    const near = await btn
      .evaluate((n) => { let w = n; for (let k = 0; k < 6 && w; k++) { const t = w.innerText || ""; if (/sponsor|visa|authoriz|eligible/i.test(t)) return true; w = w.parentElement; } return false; })
      .catch(() => false);
    if (!near) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeoutMs: 8000 }).catch(() => {});
    await sleep(600);
    console.log(`answered post-submit step (${want}): ${pr.q}`);
    return true;
  }
  if (leftForAPerson.length) {
    console.log(`\n${leftForAPerson.length} post-submit question(s) had no standing answer and were LEFT ALONE:`);
    for (const q of leftForAPerson) console.log(`  - ${q}`);
    console.log("Answer them on the page and submit again, or add a rule to the standing table.");
    return "unanswered";
  }
  return false;
}

if (!ok && errors.length === 0) {
  const answered = await answerPostSubmitStep();
  if (answered === true) {
    ({ confirmed: ok, text: body, errorTexts: errors } = await clickAndWait());
  } else if (answered === "unanswered") {
    // A question is on the page that the standing table does not answer. Re-clicking Submit cannot help -
    // the required field is still empty - and would only bury the report above under a second failure.
    console.log("a post-submit question was left for a person; not re-clicking Submit");
  } else {
    // No new question was found, so re-click anyway: a silently refused first attempt is also possible, and a
    // second click is free. Ashby's success state simply returns the browser to the posting page.
    console.log("no post-submit question found; re-clicking Submit once");
    ({ confirmed: ok, text: body, errorTexts: errors } = await clickAndWait());
  }
}

await page.screenshot({ path: `${OUT}/${slug}_after_submit.png` }).catch(() => {});
await writeFile(`${OUT}/${slug}_result.json`, JSON.stringify({ confirmed: ok, finalUrl: page.url(), errors, finalBody: body.slice(0, 500) }, null, 2));
console.log(JSON.stringify({ confirmed: ok, finalUrl: page.url(), errors, body: body.slice(-240) }, null, 1));
// One line per attempt. Ashby refuses silently (a spam flag has no banner), so the errors are the record.
recordLedger(SUBMIT, {
  slug, url: page.url(), outcome: ok ? "confirmed" : "not_confirmed",
  detail: { errors: errors.slice(0, 5), body: body.slice(-200) },
});
process.exit(ok ? 0 : 4);
