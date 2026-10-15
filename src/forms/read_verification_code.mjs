#!/usr/bin/env node
/**
 * read_verification_code.mjs — read the newest Greenhouse security-code e-mail from a webmail tab
 * the user has open in the CDP browser, so the 8-character code can be typed into a form that is
 * waiting on it.
 *
 * Usage:
 *   node src/forms/read_verification_code.mjs [--mail outlook|gmail] [--cdp http://127.0.0.1:9223]
 *
 * Why this exists: some Greenhouse tenants challenge Submit with eight `security-input-*` boxes and
 * the text "A verification code was sent to <email>. To submit your application, enter the
 * 8-character code to confirm you're a human." The code only arrives after clicking Submit, so the
 * flow is: click Submit -> read the newest code e-mail -> type the code -> Submit again.
 *
 * Read-only: it opens the newest message that matches /security code/i and reads its text. It does
 * not delete, reply, forward, or mark anything, and it never reads any other message.
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const cdpIndex = args.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? args[cdpIndex + 1] : "http://127.0.0.1:9223";
const mailIndex = args.indexOf("--mail");
const provider = mailIndex >= 0 ? args[mailIndex + 1] : "outlook";

const PATTERNS = {
  // Microsoft has moved webmail between hosts over time; cover all of them.
  outlook: /outlook\.(office\.com|office365\.com|live\.com|cloud\.microsoft)/,
  gmail: /mail\.google\.com/,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(cdp);
const existing = browser.contexts()[0].pages().find(p => PATTERNS[provider].test(p.url()));
if (!existing) {
  console.error(`no ${provider} tab found — open the mailbox in the CDP browser first`);
  process.exit(1);
}
// Never touch the user's own mailbox tab: open a background copy of the inbox, read the code there
// and close it again. Navigating or focusing the user's tab would steal their focus.
const inboxUrl = existing.url().replace(/\/mail\/.*/, "/mail/inbox");
const session = await browser.newBrowserCDPSession();
// re-use an existing background reader tab if one is open
let page = browser.contexts()[0].pages().find(p => p.url().includes("/mail/inbox"));
if (!page) {
  const { targetId } = await session.send("Target.createTarget", { url: inboxUrl, background: true });
  for (let i = 0; i < 30 && !page; i++) {
    await sleep(1000);
    page = browser.contexts()[0].pages().find(p => p.url().includes("/mail/inbox"));
  }
  if (!page) { console.error("could not open a background mailbox tab"); process.exit(1); }
  page.__openedByReader = targetId;
}
page.setDefaultTimeout(20000);
console.log("mailbox (background tab):", page.url());

const openNewest = async () => page.evaluate(() => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const row = [...document.querySelectorAll('[role="option"], tr')].find(n => /security code/i.test(clean(n.innerText)));
  if (!row) return "";
  row.click();
  return clean(row.innerText).slice(0, 160);
});

// User-confirmed strategy (2026-09-20): 10s, then double each attempt (10/20/40/80/160s), max five.
// Navigating to the inbox list (rather than pressing F5) is what actually pulls new mail.
const CODE_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000];
let header = "";
for (let attempt = 0; attempt < CODE_BACKOFF_MS.length && !header; attempt++) {
  const waitMs = CODE_BACKOFF_MS[attempt];
  console.log(`  attempt ${attempt + 1}/${CODE_BACKOFF_MS.length}: waiting ${waitMs / 1000}s…`);
  await sleep(waitMs);
  const inbox = page.url().replace(/\/mail\/.*/, "/mail/inbox");
  await page.goto(inbox, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3000);
  header = await openNewest();
}
if (!header) console.error("no security-code e-mail found after 5 attempts");
if (!header) { console.error("no security-code e-mail found"); process.exit(2); }
console.log("message:", header);

await sleep(2200);
const body = await page.evaluate(() => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  return clean(document.querySelector('[role="main"]')?.innerText || document.body.innerText);
});
const m = body.match(/security code field on your application:\s*([A-Za-z0-9]{6,12})/i)
  || body.match(/\bcode\b[^A-Za-z0-9]{0,20}([A-Za-z0-9]{8})\b/i);
if (!m) { console.error("could not parse the code out of the message body"); process.exit(3); }
console.log("code:", m[1]);
if (page.__openedByReader) await session.send("Target.closeTarget", { targetId: page.__openedByReader }).catch(() => {});
await session.detach().catch(() => {});
process.exit(0);
