#!/usr/bin/env node
/**
 * greenhouse_finish_plan.mjs - apply a whole answer plan (text fields AND react-selects) to a Greenhouse embed form,
 * then submit and read the result.
 *
 * WHY A FILE: shell-quoted `node -e` fragments have failed twice in this project. Everything real goes in a file.
 * WHY NOT pick_select_option.mjs ALONE: it reported "control not found" for react-selects on the Coast board and
 * wrongly matched by prefix on Enveritas, so this drives the control through its DOM ancestry instead - the approach
 * that has worked on every board so far - and refuses to choose when the wanted text is not an EXACT option.
 *
 * Usage:  node src/forms/greenhouse_finish_plan.mjs --rid <jobId> --plan <plan.json> [--submit]
 *
 * plan.json:
 *   { "text":  [ { "match": "preferred first and last name", "answer": "Example Candidate" } ],
 *     "select":[ { "id": "gender", "option": "Male" } ] }
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d = "") => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const RID = arg("--rid");
const PLAN = JSON.parse(readFileSync(arg("--plan"), "utf8"));
const SUBMIT = argv.includes("--submit");

const b = await chromium.connectOverCDP(arg("--cdp", "http://127.0.0.1:9223"));
const pages = b.contexts()[0].pages();
const page = pages.find((x) => (x.url() || "").includes("embed/job_app") && (x.url() || "").includes(RID));
if (!page) { console.log("NO EMBED TAB for " + RID); process.exit(2); }
console.log("using: " + page.url().slice(-56));

// ---- text fields, matched on the question text so the plan survives a board's own id churn ----
for (const item of PLAN.text || []) {
  const id = await page.evaluate((m) => {
    const rx = new RegExp(m, "i");
    for (const e of document.querySelectorAll("input,textarea")) {
      const t = (e.type || "").toLowerCase();
      if (["hidden", "submit", "button", "file", "checkbox", "radio"].includes(t)) continue;
      if (e.offsetParent === null) continue;
      if ((e.className || "").toString().includes("select__input")) continue;
      let q = ""; const lab = (e.labels && e.labels[0]) || null;
      if (lab) q = (lab.innerText || "").trim();
      if (!q) { const f = e.closest("div,fieldset,li") || e.parentElement; const l = f ? f.querySelector("label,legend") : null; q = l ? (l.innerText || "").trim() : ""; }
      if (rx.test(q)) return e.id || e.name || "";
    }
    return "";
  }, item.match);
  if (!id) { console.log(`TEXT  no field for "${item.match}"`); continue; }
  const loc = page.locator(`[id="${id}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.type(String(item.answer), { delay: 45 });
  await page.keyboard.press("Tab");            // Greenhouse validates some questions on blur
  await page.waitForTimeout(700);
  console.log(`TEXT  ${item.match} -> ${JSON.stringify(String(item.answer).slice(0, 34))} :: #${id.slice(0, 26)}`);
}

// ---- react-selects, driven through DOM ancestry and matched by EXACT option text ----
for (const item of PLAN.select || []) {
  const ctl = page.locator(`[id="${item.id}"]`).locator("xpath=ancestor-or-self::*[contains(@class,'select__control')][1]").first();
  const target = (await ctl.count()) ? ctl : page.locator(`[id="${item.id}"]`).first();
  // VIRTUALISED LISTS: many Greenhouse react-selects render only the first four or five rows, so an option that
  // exists (Man, East Asian, Heterosexual, Career Site) is simply not in the DOM until the control is filtered.
  // Typing the wanted text narrows the list and brings the row into view; we then re-read and match EXACTLY.
  // This is a READ-side fix only - the choice itself is still an exact-text click, never a prefix match.
  // Choose the LONGEST word as the filter term: a first-word rule degenerates on options like
  // "No, I am not a veteran or active member", where "No" is a terrible filter and "veteran" is a good one.
  const filter = String(item.option)
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0] || String(item.option).replace(/[^A-Za-z]/g, "").slice(0, 12);
  let chosen = "";
  for (let attempt = 0; attempt < 5 && !chosen; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1000);
    let opts = await page.evaluate(() => [...document.querySelectorAll("[class*=select__option]")].map((o) => (o.textContent || "").trim()));
    // If the exact option is not among the rendered rows, filter the list by typing, then re-read.
    if (opts.length && !opts.includes(item.option) && filter && attempt < 4) {
      await page.keyboard.type(filter, { delay: 80 }).catch(() => {});
      await page.waitForTimeout(1400);
      const filtered = await page.evaluate(() => [...document.querySelectorAll("[class*=select__option]")].map((o) => (o.textContent || "").trim()));
      if (filtered.length) opts = filtered;
    }
    if (!opts.length) continue;
    const exact = opts.find((o) => o === item.option);
    if (!exact) { console.log(`SEL   ${item.id}: NO EXACT option "${item.option}" (filtered by ${JSON.stringify(filter)}); saw ${JSON.stringify(opts.slice(0, 4))}`); break; }
    await page.locator("[class*=select__option]").filter({ hasText: new RegExp("^" + exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }).first()
      .click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(900);
    chosen = await page.evaluate((id) => {
      const e = document.getElementById(id); let w = e, c = null;
      for (let k = 0; k < 10 && w; k++) { if (w.classList && w.classList.contains("select__control")) { c = w; break; } w = w.parentElement; }
      const sv = c ? c.querySelector("[class*=select__single-value]") : null;
      return sv ? sv.textContent.trim() : (e ? e.value : "");
    }, item.id).catch(() => "");
    console.log(`SEL   ${item.id} -> ${JSON.stringify(chosen)}`);
  }
  if (!chosen) console.log(`SEL   ${item.id}: UNSET`);
}

if (SUBMIT) {
  const btn = page.locator("input[type=submit], button[type=submit], #submit_app").first();
  if (await btn.count()) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 20000 }).catch((e) => console.log("submit err " + String(e).slice(0, 40)));
  }
  await page.waitForTimeout(16000);
  const post = await page.evaluate(() => ({
    url: location.href,
    controls: document.querySelectorAll("input,textarea,select").length,
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
    errs: [...document.querySelectorAll(".field-error, [class*=error]")].map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5),
  }));
  console.log("POST: " + JSON.stringify(post, null, 1).slice(0, 900));
}
process.exit(0);
