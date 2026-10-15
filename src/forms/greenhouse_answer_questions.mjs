#!/usr/bin/env node
/**
 * greenhouse_answer_questions.mjs - answer a Greenhouse board's custom questions by their QUESTION TEXT, then submit.
 *
 * WHY A FILE. `node -e` one-liners with nested quotes have already failed twice in this project, wasting a call each
 * time and producing no diagnosis. Real logic goes in a file.
 *
 * WHY BY TEXT AND NOT BY ID: the ids on these boards are opaque (`question_4033198008`) and arrive in a different
 * order on every board, so a hard-coded id plan does not survive one employer. Each answer here is keyed to a
 * distinctive phrase in the question, which is what the standing answer table is actually about.
 *
 * Every field is typed at human speed and then BLURRED with Tab, because Greenhouse validates some React-controlled
 * questions on blur - typing and reading back succeeds while the server still reports the field as required.
 *
 * Usage:
 *   node src/forms/greenhouse_answer_questions.mjs --rid <jobId> --answers <plan.json> [--submit]
 *
 * plan.json:
 *   [ { "match": "core hours", "answer": "Yes" },
 *     { "match": "legally eligible", "answer": "Yes" } ]
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d = "") => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const RID = arg("--rid");
const PLAN_FILE = arg("--answers");
const SUBMIT = argv.includes("--submit");
const CDP = arg("--cdp", "http://127.0.0.1:9223");

if (!RID || !PLAN_FILE) { console.error("usage: <--rid jobId> <--answers plan.json> [--submit]"); process.exit(2); }
const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));

const b = await chromium.connectOverCDP(CDP);
const pages = b.contexts()[0].pages();
const page = pages.find((x) => (x.url() || "").includes("embed/job_app") && (x.url() || "").includes(RID))
  || pages.find((x) => (x.url() || "").includes(RID) && !(x.url() || "").includes("/application"));
if (!page) { console.log("NO TAB for " + RID); process.exit(2); }
console.log("using: " + page.url().slice(-58));

// Every visible, empty, non-select text field with its question text - the map the plan is matched against.
async function questionMap() {
  return await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll("input,textarea")) {
      const t = (e.type || "").toLowerCase();
      if (["hidden", "submit", "button", "file", "checkbox", "radio"].includes(t)) continue;
      if (e.offsetParent === null) continue;
      if ((e.className || "").toString().includes("select__input")) continue; // react-select: picked, not typed
      let q = ""; const lab = (e.labels && e.labels[0]) || null;
      if (lab) q = (lab.innerText || "").trim();
      if (!q) { const f = e.closest("div,fieldset,li") || e.parentElement; const l = f ? f.querySelector("label,legend") : null; q = l ? (l.innerText || "").trim() : ""; }
      out.push({ id: e.id || "", q: q.replace(/\s+/g, " ") });
    }
    return out;
  });
}

let answered = 0, unmatched = [];
for (const item of plan) {
  const map = await questionMap();
  const hit = map.find((f) => new RegExp(item.match, "i").test(f.q) && !f.q.startsWith("__done"));
  if (!hit || !hit.id) { unmatched.push(item.match); console.log("NO FIELD for: " + item.match); continue; }
  const loc = page.locator(`[id="${hit.id}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.type(item.answer, { delay: 45 });
  await page.keyboard.press("Tab");   // the blur Greenhouse validates on
  await page.waitForTimeout(700);
  console.log(`${item.match} -> ${JSON.stringify(item.answer)} :: #${hit.id.slice(0, 30)}`);
  answered++;
  // mark it so a later plan item cannot re-answer the same box
  await page.evaluate((id) => { const e = document.getElementById(id); if (e && e.labels && e.labels[0]) e.labels[0].innerText = "__done " + e.labels[0].innerText; }, hit.id).catch(() => {});
}

const st = await page.evaluate(() => ({
  files: [...document.querySelectorAll("input[type=file]")].map((f) => (f.files || []).length),
  resumeShown: ((document.body.innerText || "").match(/Example_Candidate_[A-Za-z_]*\.pdf/) || [])[0] || "(no filename)",
}));
console.log(`answered ${answered}; unmatched ${JSON.stringify(unmatched)}`);
console.log("resume: " + st.resumeShown);

if (SUBMIT) {
  const btn = page.locator("input[type=submit], button[type=submit], #submit_app").first();
  if (await btn.count()) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 20000 }).catch((e) => console.log("submit err " + String(e).slice(0, 40)));
  }
  await page.waitForTimeout(15000);
  const post = await page.evaluate(() => ({
    url: location.href,
    controls: document.querySelectorAll("input,textarea,select").length,
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
    errs: [...document.querySelectorAll(".field-error, [class*=error]")].map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5),
  }));
  console.log("POST: " + JSON.stringify(post, null, 1).slice(0, 900));
}
process.exit(0);
