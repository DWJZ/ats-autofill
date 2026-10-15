#!/usr/bin/env node
/**
 * advance_form_steps.mjs <url-part> [--max N] [--submit-at-end] [--cdp URL]
 *
 * Walk a MULTI-STEP (wizard) ATS form to its end by pressing the forward control, re-inventorying after each press.
 *
 * WHY THIS EXISTS (2026-10-06, SmartRecruiters' One-Click UI): that form is a wizard - its tail reads
 * "Resume * | Message to the Hiring Team | NEXT" - and it renders NO submit button anywhere in the DOM until the steps
 * have been walked. submit_with_verification_code.mjs therefore CRASHED instead of reporting a missing control, and the
 * fill itself was already complete and verified.
 *
 * The "press the forward control and verify the press" pattern is not new: workday_runner.mjs has had advance() since
 * the Workday wizard was first driven, and this file is the same idea made ATS-agnostic rather than re-derived per site.
 * It deliberately does NOT fill anything - apply_form_spec.mjs does that - so the two tools stay independent.
 *
 * Prints one line per step: the step number, the forward control it pressed, and how many controls the new step shows.
 * Exits non-zero when no forward control can be found and no submit control is present either, because that is the state
 * that needs a human-or-tool decision rather than another silent pass.
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2];
if (!urlPart) {
  console.error("usage: advance_form_steps.mjs <url-part> [--max N] [--submit-at-end] [--cdp URL]");
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const maxSteps = Number(arg("--max", "8"));
const submitAtEnd = process.argv.includes("--submit-at-end");
const cdp = arg("--cdp", "http://127.0.0.1:9223");

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => (p.url() || "").includes(urlPart) && !/confirmation/.test(p.url()));
if (!page) {
  console.error("tab not found for:", urlPart);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count the controls a step is asking about, so a step that changes is visibly different from one that stalls. */
async function inventory() {
  return await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const walk = (root, out) => {
      for (const el of root.querySelectorAll("input,textarea,select")) if (vis(el) && el.type !== "hidden") out.push(el.id);
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot, out);
      return out;
    };
    return walk(document, []).length;
  }).catch(() => -1);
}

/** Press the forward control. Shadow-aware: Playwright locators pierce shadow roots, so this works on the one-click UI. */
async function pressForward() {
  const names = [/^next$/i, /save and continue/i, /^continue$/i, /^next step$/i];
  for (const name of names) {
    const btn = page.getByRole("button", { name }).first();
    if (await btn.count().catch(() => 0)) {
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width < 2) continue;
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 8000 }).catch(() => {});
      await sleep(1800);
      return name.source;   // the SOURCE, not the pattern with characters stripped out of it
    }
  }
  return null;
}

async function pressSubmit() {
  for (const name of [/^submit( application)?$/i, /^send application$/i]) {
    const btn = page.getByRole("button", { name }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 8000 }).catch(() => {});
      await sleep(2500);
      return name.source;
    }
  }
  return null;
}

console.log(`attached to: ${page.url().slice(0, 110)}`);
for (let step = 1; step <= maxSteps; step++) {
  const before = await inventory();
  const submitted = await pressSubmit();
  if (submitted) {
    console.log(`step ${step}: pressed SUBMIT (${submitted}); controls before submit: ${before}`);
    const done = await page.evaluate(() => ({
      url: location.href,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    })).catch(() => ({ url: "?", text: "" }));
    const confirmed = /thank|received|success|submitted/i.test(done.text);
    console.log("final:", JSON.stringify({ url: done.url.slice(0, 120), confirmed }));
    process.exit(confirmed ? 0 : 3);
  }
  const pressed = await pressForward();
  if (!pressed) {
    console.log(`step ${step}: NO forward control and NO submit control (controls: ${before}) - stopping`);
    process.exit(4);
  }
  const after = await inventory();
  console.log(`step ${step}: pressed ${pressed}; controls ${before} -> ${after}`);
  if (after === before && step > 1) {
    console.log("  (control count unchanged - the step may not have advanced)");
  }
}
console.log(`stopped after --max ${maxSteps} steps without reaching a submit control`);
process.exit(5);
