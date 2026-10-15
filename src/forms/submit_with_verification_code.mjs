#!/usr/bin/env node
/**
 * submit_with_verification_code.mjs — submit a filled Greenhouse application that challenges with the
 * eight `security-input-*` boxes, using the code e-mailed to the candidate.
 *
 * Usage:
 *   node src/forms/submit_with_verification_code.mjs <token> <slug> [--no-submit]
 *
 * Flow (the order matters):
 *   1. note which security-code e-mail is currently newest in the webmail tab (baseline),
 *   2. click Submit on the form, which makes Greenhouse send a fresh code,
 *   3. wait for a security-code e-mail that is newer than the baseline,
 *   4. clear all eight boxes (they are single-character inputs, so Ctrl+A only clears one of them),
 *      type the code, and click Submit again,
 *   5. confirm the confirmation page and record before/after screenshots.
 *
 * Read-only on the mailbox: it opens only messages matching /security code/i.
 */
import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Telemetry must never break a submission: a missing or broken ledger module falls back to a no-op
// rather than failing this module's own import.
const { recordLedger, SUBMIT } = await import("./_ledger.mjs")
  .catch(() => ({ recordLedger: () => null, SUBMIT: "submit" }));

const [token, slug, ...flags] = process.argv.slice(2);
if (!token || !slug) {
  console.error("usage: node src/forms/submit_with_verification_code.mjs <token> <slug> [--no-submit]");
  process.exit(1);
}
const shouldSubmit = !flags.includes("--no-submit");
const __ci = flags.indexOf("--code");
const GIVEN_CODE = __ci >= 0 ? (flags[__ci + 1] || "") : "";
const companyIndex = flags.indexOf("--company");
const company = companyIndex >= 0 ? flags[companyIndex + 1] : "";
// 9223 is the browser profile you sign in to the job boards with, so it is the one holding the
// application sessions. Point --cdp elsewhere if your debugging Chrome listens on another port.
const cdpIndex = flags.indexOf("--cdp");
const CDP = cdpIndex >= 0 ? flags[cdpIndex + 1] : "http://127.0.0.1:9223";
// Output paths and the mail AppleScript are derived from THIS FILE's location, so the script works from any
// checkout and from any working directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, "tmp", "pre_submit");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(CDP);
const pages = browser.contexts()[0].pages();
// Greenhouse/embed URLs carry ?token=<id>; Ashby and other SPA ATS put the job id in the path,
// so accept either form (the uuid is unique enough not to collide with another tab).
const form = pages.find(p => (p.url().includes(`token=${token}`) || p.url().includes(token)) && !/confirmation/.test(p.url()));
let mail = pages.find(p => /outlook\.(office\.com|office365\.com|live\.com|cloud\.microsoft)|mail\.google\.com/.test(p.url()));
if (!form) { console.error("form tab not found (already submitted?)"); process.exit(3); }
form.setDefaultTimeout(15000);

const formState = () => form.evaluate(() => ({
  url: location.href,
  body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260),
  // Ashby puts "Application Success / Your application was successfully submitted" at the *bottom* of
  // the page, past the 260-char head slice, so a successful Ashby submit still read confirmed: false
  // (Sierra and Browserbase, 2026-09-27). Keep the tail as well and match against both.
  tail: (document.body.innerText || "").replace(/\s+/g, " ").slice(-400),
  security: document.querySelectorAll('[id^="security-input"]').length,
  errors: [...document.querySelectorAll("[class*=error]")].map(e => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 2),
})).catch(() => ({ url: form.url(), body: "", tail: "", security: 0, errors: [] }));
const readBoxes = () => form.evaluate(() => [...document.querySelectorAll('[id^="security-input"]')].map(e => e.value).join(""));

// --- mailbox helpers
async function newestCodeHeader() {
  if (!mail) return "";
  const inbox = mail.url().replace(/\/mail\/.*/, "/mail/inbox");
  // Read from a background copy of the inbox so the user's own mailbox tab is never navigated.
  if (!globalThis.__mailBg) {
    const session = await browser.newBrowserCDPSession();
    const { targetId } = await session.send("Target.createTarget", { url: inbox, background: true });
    for (let i = 0; i < 25 && !globalThis.__mailBg; i++) {
      await sleep(1000);
      globalThis.__mailBg = browser.contexts()[0].pages().find(p => p.url().includes("/mail/inbox"));
    }
    globalThis.__mailBgId = targetId;
    await session.detach().catch(() => {});
  }
  mail = globalThis.__mailBg || mail;
  await sleep(1500);
  return mail.evaluate(() => {
    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const row = [...document.querySelectorAll('[role="option"]')].find(o => /security code/i.test(clean(o.innerText)));
    return row ? clean(row.innerText).slice(0, 140) : "";
  });
}
async function openAndReadCode(header) {
  await mail.evaluate(({ want, co }) => {
    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const rows = [...document.querySelectorAll('[role="option"]')].filter(o => /security code/i.test(clean(o.innerText)));
    const hints = rows.filter(o => (!co || new RegExp(co, "i").test(clean(o.innerText))));
    const pool = hints.length ? hints : rows;
    const row = pool.find(o => clean(o.innerText).startsWith(want)) || pool[0];
    if (row) row.click();
  }, { want: header, co: company }).catch(() => {});
  // the reading pane can lag behind the click, and it may still show the previous message; poll
  // until the pane text matches the expected company (when one was given) before parsing the code.
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const body = await mail.evaluate(() => {
      const clean = s => (s || "").replace(/\s+/g, " ").trim();
      return clean(document.querySelector('[role="main"]')?.innerText || document.body.innerText);
    });
    if (company && !new RegExp(company, "i").test(body)) continue;
    const m = body.match(/security code field on your application:\s*([A-Za-z0-9]{6,12})/i);
    if (m) return m[1];
  }
  return "";
}

// 1) baseline

/**
 * Press the real Submit control.
 *
 * The role-based locator is tried first, but it is scoped to the form element and can miss a button that Ashby
 * renders outside it (Luma AI's "Submit Application" timed out that way while present and enabled on the page). The
 * fallback finds the visible, enabled control whose own text matches, measures it, and presses it with a real mouse
 * event - the same visibility-and-verify discipline the Workday runner uses.
 */
async function pressSubmit(page) {
  // Two tiers, strict first. Broadening the pattern to include "Apply" fixed SeatGeek's "SUBMIT YOUR APPLICATION"
  // label but then broke it differently: the same page also carries a decorative "Apply" button, the loose pattern
  // matched it first, and the script reported a click while nothing was submitted (no receipt, confirmed: false).
  // So the submit wordings are tried on their own before the apply wordings are considered at all.
  const STRICT = /^(submit( your)? application|send application)$/i;
  const LOOSE = /^(apply( now| for this job)?)$/i;

  // DISMISS A COOKIE BANNER FIRST (added 2026-10-07). The Ashby submitter has had this for a while
  // because Plaid's banner intercepted every click; the generic submitter did NOT, and Lever tenants
  // with their own consent overlay (Palantir, for one) silently swallowed the submit: the click landed
  // on the banner, the ledger recorded not_confirmed with kind "no wording found", and the only visible
  // trace was that the page body was still the cookie notice. Dismissing it here fixes every platform
  // at once instead of one submitter at a time.
  for (const pattern of [/^accept all$/i, /^accept( cookies)?$/i, /^allow all$/i, /^i accept$/i, /^agree$/i, /^ok$/i]) {
    const banner = page.getByRole("button", { name: pattern }).first();
    if (await banner.count() > 0) {
      await banner.click({ force: true }).catch(() => {});
      await sleep(700);
      break;
    }
  }

  // NAME THE FIELD THE BROWSER WILL REFUSE ON (added 2026-10-07). Lever relies on native HTML5
  // validation, so an empty required field stops the submit with a bubble reading "Please fill out this
  // field." that appears in NO text dump, NO field inventory and NO audit - three Palantir submits were
  // reported as not_confirmed with kind "no wording found" while the real cause was one empty disability
  // Date input, and only a screenshot found it. Asking the DOM for :invalid turns that silence into a name.
  const invalidBefore = await page.evaluate(() => [...document.querySelectorAll("input:invalid, select:invalid, textarea:invalid")]
    .map((el) => ({
      field: el.name || el.id || el.getAttribute("aria-label") || "(unnamed)",
      why: el.validationMessage || "invalid",
      empty: !String(el.value || "").trim(),
    }))).catch(() => []);
  if (invalidBefore.length) {
    console.log(`[${slug}] THE BROWSER WILL REFUSE THIS SUBMIT - ${invalidBefore.length} invalid control(s):`);
    for (const f of invalidBefore) console.log(`   - ${f.field} :: ${f.why}${f.empty ? " (EMPTY)" : ""}`);
  }

  const pressByText = async (rx) => {
    const target = await page.evaluate((src) => {
      const re = new RegExp(src, "i");
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
      };
      const el = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
        .filter(visible)
        .filter((x) => !x.disabled)
        .find((x) => re.test((x.innerText || x.value || "").replace(/\s+/g, " ").trim()));
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (el.innerText || el.value || "").trim() };
    }, rx.source);
    if (!target) return null;
    await page.mouse.move(target.x, target.y).catch(() => {});
    await page.mouse.click(target.x, target.y);
    return target.label;
  };

  for (const rx of [STRICT, LOOSE]) {
    const roleLocator = page.getByRole("button", { name: rx }).first();
    try {
      await roleLocator.click({ timeoutMs: 8000 });
      return `role:${rx === STRICT ? "strict" : "loose"}`;
    } catch {
      const label = await pressByText(rx);
      if (label) return `visible-text:${label}`;
    }
  }
  throw new Error("no visible enabled Submit control found");
}

// --code lets the caller supply the code directly. This exists because the mailbox reader below needs an open
// Outlook/Gmail webmail TAB, while this project reads mail through Apple Mail - so on Greenhouse forms with the eight
// security boxes the lookup returned "(none)" forever even though the code e-mail was sitting in the inbox. Supplying
// the code skips the whole baseline/wait dance, types it immediately and clicks Submit exactly once.

// APPLE MAIL FALLBACK. The webmail-tab reader above only works when an Outlook/Gmail tab is open in the project
// browser, but this project reads mail through Apple Mail, so on the eight-box Greenhouse challenge the code lookup
// returned "(none)" indefinitely while the code sat in the inbox. This shells out to the project's own mail tool and
// pulls the code out of the newest matching message.
async function appleMailCode() {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("osascript", [join(ROOT, "src", "tools", "mail_app_body.applescript"), "Security code"],
      { encoding: "utf8", timeout: 40000 });
    const m = out.match(/security code field on your application:\s*([A-Za-z0-9]{6,12})/i);
    return m ? m[1] : "";
  } catch { return ""; }
}

console.log("[hint] code stale or never arriving? RELOAD the tab, refill from the job spec in one pass, and submit\n       again - a rebuilt form often needs NO code. A rebuilt Greenhouse form comes back with different control\n       ids, so re-read them off the page you actually have rather than reusing the ones from the first pass.");
const baseline = GIVEN_CODE ? "(supplied with --code)" : (mail ? await newestCodeHeader() : "");
console.log(`[${slug}] newest code e-mail before submit: ${baseline || "(none)"}`);

// 2) submit
let st = await formState();
if (st.security === 0 && shouldSubmit) {
  await form.screenshot({ path: `${OUT}/${slug}_before_submit.png`, fullPage: false }).catch(() => {});
  const how = await pressSubmit(form);
  console.log(`[${slug}] clicked Submit… (${how})`);
  for (let i = 0; i < 8 && st.security === 0 && !/confirmation/.test(st.url); i++) { await sleep(2000); st = await formState(); }
}

// 3) wait for a newer e-mail
let header = baseline, code = GIVEN_CODE;
// The code e-mail is not instant. User-confirmed strategy (2026-09-20): wait 10s, then double the
// wait each attempt (10/20/40/80/160s) and give up after five attempts, so a throttled tenant cannot
// stall the run. Worst case is about 5 minutes.
const CODE_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000];
if (st.security > 0 && !code) {
  for (let attempt = 0; attempt < CODE_BACKOFF_MS.length && !code; attempt++) {
    const waitMs = CODE_BACKOFF_MS[attempt];
    console.log(`  attempt ${attempt + 1}/${CODE_BACKOFF_MS.length}: waiting ${waitMs / 1000}s, then checking the mailbox…`);
    await sleep(waitMs);
    if (!code) code = await appleMailCode();
    const now = await newestCodeHeader();
    if (now && now !== baseline) {
      code = await openAndReadCode(now);
      header = now;
    }
  }
  console.log(`[${slug}] code e-mail: ${header || "(none)"}`);
  console.log(`[${slug}] code: ${code || "(not found after 5 attempts)"}`);
}

// 4) clear the boxes, type the code, submit
if (code) {
  const boxes = form.locator('[id^="security-input"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    await b.click({ timeoutMs: 6000 }).catch(() => {});
    await b.press("Backspace").catch(() => {});
  }
  await sleep(300);
  await boxes.first().click({ timeoutMs: 6000 }).catch(() => {});
  await form.keyboard.type(code, { delay: 130 });
  await sleep(800);
  const filled = await readBoxes();
  console.log(`[${slug}] boxes now: ${JSON.stringify(filled)}`);
  if (filled === code && shouldSubmit) {
    await pressSubmit(form);
    console.log(`[${slug}] clicked Submit with the code…`);
  }
}

// 5) confirm
let ok = false;
for (let i = 0; i < 16; i++) {
  await sleep(2500);
  st = await formState();
  // Ashby keeps the /application URL after a successful POST and says "Application Success": without these
  // patterns a genuinely submitted Ashby application reported confirmed: false (Sierra, 2026-09-27) even
  // though the success page and the receipt e-mail were both present.
  //
  // "THANK YOU FOR YOUR INTEREST" was the next wording to slip through. Oneleet's success page reads "Thank you for
  // your interest in Oneleet and what we are building here" - the existing pattern covered "thanks for your interest"
  // but not the spelled-out "thank you", so a submitted application was reported unconfirmed. That false negative is
  // expensive: it sends the next step looking for a blocker that does not exist, and on Oneleet it produced three
  // pointless retries and two spurious "the resume is missing" investigations against a page that had no form left at
  // all. Matching is only a hint that the POST landed; the screenshot stays the authority.
  const successText = `${st.body} ${st.tail}`;
  if (/confirmation/.test(st.url)
      || /thank you for applying|thank you for your interest|application has been received|we successfully received|thanks for your interest|application (was )?(successfully )?(submitted|received)/i.test(successText)
      || /application success|successfully submitted|we.{0,20}received your application|in touch as soon as we can/i.test(successText)) { ok = true; break; }
}
const finalUrl = form.url();
const finalBody = await form.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260)).catch(() => "");
await form.screenshot({ path: `${OUT}/${slug}_after_submit.png` }).catch(() => {});
// leave no stray background mailbox tabs behind
if (globalThis.__mailBgId || globalThis.__mailBg) {
  const closer = await browser.newBrowserCDPSession();
  if (globalThis.__mailBgId) await closer.send("Target.closeTarget", { targetId: globalThis.__mailBgId }).catch(() => {});
  await closer.detach().catch(() => {});
}
await writeFile(`${OUT}/${slug}_result.json`, JSON.stringify({ token, slug, confirmed: ok, finalUrl, finalBody, codeEmail: header }, null, 2));
// One line per attempt, so the count and the reason survive even though the result file above is overwritten.
// `errors` and `tail` are what the form actually said: the head is the job description, which is why the
// first version of this recorded a useless "reason" for every unconfirmed submit.
recordLedger(SUBMIT, {
  slug, url: finalUrl, outcome: ok ? "confirmed" : "not_confirmed",
  detail: { token, code_email: header ? "found" : "none",
            errors: (st && st.errors) || [], tail: String((st && st.tail) || "").slice(-300) },
});
console.log(JSON.stringify({ confirmed: ok, finalUrl, body: finalBody.slice(0, 140) }, null, 1));
process.exit(ok ? 0 : 4);
