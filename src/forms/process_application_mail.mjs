#!/usr/bin/env node
/**
 * process_application_mail.mjs — tidy the application mailbox after submitting.
 *
 * Standing rule (user, 2026-09-21): after an application is submitted, pure "we received your
 * application" notifications are marked as read; anything that needs the user's own attention
 * (interview requests, assessments, recruiter questions, verification, offers, deadlines) is left
 * UNREAD and reported so it can be handed over.
 *
 * Usage:
 *   node src/forms/process_application_mail.mjs [--limit 40] [--wait 120] [--dry-run]
 *                                          [--mail outlook|gmail] [--folder inbox|junkemail]
 *
 * --wait N  sleep N seconds before opening the mailbox. Employer auto-replies are delayed, so run
 *           this as a BACKGROUND job with --wait after a submission batch (it must never block the
 *           next application): `... --wait 150 > tmp/mail_tidy.log 2>&1 &` or via the agent's
 *           background-job facility, then read the log at the end of the round.
 *
 * The user's own mailbox tab is never touched: a background copy of the inbox is opened via CDP
 * (Target.createTarget with background: true) and closed again when the run finishes.
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const LIMIT = Number(value("--limit", "25"));
const DRY_RUN = flag("--dry-run");
const PROVIDER = value("--mail", "outlook");
const FOLDER = value("--folder", "inbox");
const CDP = value("--cdp", "http://127.0.0.1:9223");
// Auto-reply receipts are delayed (they can land minutes after a submit), so a tidy run that starts
// immediately after submitting is guaranteed to miss some. Wait first, then treat the mailbox once.
const WAIT_SECONDS = Number(value("--wait", "0"));

const HOSTS = {
  outlook: /outlook\.(office\.com|office365\.com|live\.com|cloud\.microsoft)/,
  gmail: /mail\.google\.com/,
};

// Purely informational receipts: safe to mark read.
const RECEIPT = [
  /thank you for applying/i,
  /thanks for applying/i,
  /thanks for your application/i,
  /thanks for your interest/i,
  /thank you for your interest in .{0,60}/i,
  /thank you for your application/i,
  /we(?:'ve| have)? received your application/i,
  /your application (?:has been|was) received/i,
  /application (?:has been |was )?(?:successfully )?submitted/i,
  /thanks for your interest and for applying/i,
  /we received your application/i,
  /we have your application/i,
  /application received/i,
  /application confirmation/i,
  /confirmation of your application/i,
  /application (?:has been )?received for/i,
  /thank you for your interest in (?:joining )?/i,
  /your application for .* at /i,
  /we(?:'ve| have) received your application for/i,
  // Semgrep (2026-09-24): "Your application for Senior Backend Software Engineer has been received,
  // and our team will be reviewing it carefully." The role sits between "application for" and
  // "has been received", so the tighter patterns above miss it.
  /application for [^.]{0,160}(?:has been|was) received/i,
  /(?:has been|was) received,? and our team/i,

  /we'?ve received your .*application/i,
  /has received your application/i,
  /application received/i,
];

// Unambiguous "the user must do something" signals. These are checked against the SUBJECT AND BODY
// *before* the receipt patterns, because an employer's next-step mail often opens with a receipt phrase.
// Learned 2026-09-28: Turing's "Thanks for your Interest! Next steps ... [Assessment]" was matched by
// /thanks for your interest/i and marked read even though it asked the user to take an online skills test
// and to expect an interview - exactly the message the rule says must stay unread and be reported.
const STRONG_ACTIONABLE = [
  /assessment/i, /take an online skills test/i, /skills test/i, /coding challenge/i,
  /hackerrank/i, /codesignal/i, /codility/i, /take[- ]home (?:exercise|assignment|project)/i,
  /action required/i, /complete your application/i, /additional information/i,
  /background check/i, /right to work/i, /offer letter/i,
  /schedule (?:a |your )?(?:call|interview|chat|time)/i, /invitation to interview/i,
];

// A rejection is not a receipt: the user wants to see it, so it stays unread and gets reported.
const REJECTION = [
  /unfortunately/i, /not (?:to )?(?:be )?moving forward/i, /other candidates/i,
  /decided not to/i, /pursue other/i, /will not be (?:moving|proceeding)/i,
  /not selected/i, /position has been filled/i,
  // Learned 2026-09-28 (Instacart, New Relic): these rejections open with "Thank you for applying" and
  // phrase the outcome as "unable to move forward" / "regret to inform", which the patterns above miss -
  // so the messages were marked read as receipts. Rejections must stay unread and be reported.
  /unable to (?:move|progress) forward/i, /regret to inform/i, /won't be (?:moving|proceeding)/i,
  /not (?:be )?(?:proceeding|advancing)/i, /we (?:have )?decided to (?:move|proceed) (?:forward )?with other/i,
  /keep your (?:resume|details|information) on file/i, /best of luck in your (?:search|job search)/i,
  // The inbox preview truncates, and these rejections bury the decision after a polite opening, so the
  // decisive word ("Unfortunately...") never reached the classifier. Match the opening idioms too.
  // Learned 2026-09-28 (New Relic: "We were very fortunate to have a strong group of applicants ... we
  // often have to make tough choices. Unfortunately, after careful consideration...").
  /fortunate to have a strong group/i, /strong group of applicants/i,
  /we often have to make tough choices/i, /after careful consideration/i,
  /have to make (?:tough|difficult) choices/i,

  /not quite the best fit/i,
  /not the best fit for the team/i,
  /isn'?t the best fit/i,];

// Anything here (or anything not recognised as a receipt) stays unread for the user.
const ACTIONABLE = [
  /interview/i, /schedule a (?:call|chat|time)/i, /availability/i, /next step/i, /recruiter/i,
  /assessment/i, /coding challenge/i, /take[- ]home/i, /hackerrank/i, /codesignal/i, /codility/i,
  /action required/i, /complete your application/i, /additional information/i, /question/i,
  /verify|verification/i, /security code/i, /password/i, /offer/i, /deadline/i, /respond/i,
  /reply/i, /documents?/i, /questionnaire/i, /background check/i, /right to work/i,
  /invitation/i, /invite/i, /update on your application/i,
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (WAIT_SECONDS > 0) {
  console.log(`waiting ${WAIT_SECONDS}s for delayed auto-reply receipts before touching the mailbox…`);
  await sleep(WAIT_SECONDS * 1000);
}

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const pagesBefore = new Set(context.pages());
const userTab = context.pages().find(page => HOSTS[PROVIDER].test(page.url()));
if (!userTab) {
  console.error(`no ${PROVIDER} tab found — open the mailbox in the CDP browser first`);
  process.exit(1);
}
const inboxUrl = userTab.url().replace(/\/mail\/.*/, `/mail/${FOLDER}`).replace(/\/#.*/, "");
const session = await context.newCDPSession(userTab);
const { targetId } = await session.send("Target.createTarget", { url: inboxUrl, background: true });
await sleep(6000);
// Identify the tab this script opened rather than matching on the URL: Outlook often redirects
// /mail/inbox to /mail/, and a URL match would then pick up (or miss) the wrong tab.
const page = context.pages().find(candidate => !pagesBefore.has(candidate))
  || context.pages().find(candidate => candidate.url().includes(`/mail/${FOLDER}`));
if (!page) {
  console.error("could not open a background mailbox tab");
  process.exit(1);
}
page.setDefaultTimeout(15000);
await page.goto(inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
// A re-goto is what actually pulls new mail into the list; without it the first read can be stale and
// freshly arrived receipts are missed entirely.
await page.goto(inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);

const readRows = () => page.evaluate(limit => {
  const clean = value => (value || "").replace(/\s+/g, " ").trim();
  const isTime = text => /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(text);
  return [...document.querySelectorAll('[role="option"]')].slice(0, limit).map((row, index) => {
    const unreadButton = row.querySelector('[aria-label="Mark as read" i], [title="Mark as read" i]');
    const readButton = row.querySelector('[aria-label="Mark as unread" i], [title="Mark as unread" i]');
    const sender = clean(row.querySelector("[class*=fui-Avatar][aria-label]")?.getAttribute("aria-label"));
    const leaves = [...row.querySelectorAll("*")]
      .filter(element => element.children.length === 0)
      .map(element => clean(element.textContent))
      .filter(Boolean);
    const preview = leaves.reduce((longest, text) => (text.length > longest.length ? text : longest), "");
    // Subject = first real text leaf that is neither the sender, the timestamp nor the preview body.
    const subject = leaves.find(text => text !== sender && text !== preview && !isTime(text) && text.length >= 3) || preview;
    return {
      index,
      unread: Boolean(unreadButton),
      hasToggle: Boolean(unreadButton || readButton),
      subject,
      sender,
      preview: preview.slice(0, 400),
    };
  });
}, LIMIT);

let rows = await readRows();
// Outlook sometimes renders an empty list in the background copy; an "unread: []" based on zero rows
// is a false clean, so insist on actually seeing the inbox before drawing conclusions.
for (let attempt = 0; attempt < 3 && rows.length === 0; attempt += 1) {
  console.error(`inbox returned 0 rows (attempt ${attempt + 1}) - re-navigating`);
  await sleep(4000);
  await page.goto(inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(6000);
  rows = await readRows();
}
if (rows.length === 0) {
  console.error("could not load the inbox list - treat this run as unclean and re-run");
  await session.send("Target.closeTarget", { targetId }).catch(() => {});
  process.exit(5);
}
const classify = row => {
  const haystack = `${row.subject} ${row.preview}`;
  if (REJECTION.some(pattern => pattern.test(haystack))) return "rejection";
  // A strong, unambiguous action request outranks a receipt phrase - the message needs the user.
  if (STRONG_ACTIONABLE.some(pattern => pattern.test(haystack))) return "actionable";
  // Receipts win over the *weak* actionable keywords: a "Thank you for applying" message may still
  // mention "questions" or "next steps" in its body, and holding it back defeats the whole rule.
  if (RECEIPT.some(pattern => pattern.test(row.subject))) return "receipt";
  if (RECEIPT.some(pattern => pattern.test(row.preview))) return "receipt";
  if (ACTIONABLE.some(pattern => pattern.test(row.subject))) return "actionable";
  return "unknown";
};

const planned = rows.map(row => ({ ...row, kind: classify(row) }));
const toMark = planned.filter(row => row.kind === "receipt" && row.unread);

console.log(`inbox rows inspected: ${rows.length} | unread receipts to mark read: ${toMark.length}`);
for (const row of planned) {
  console.log(`${row.unread ? "UNREAD" : "read  "} [${row.kind}] ${row.subject.slice(0, 120)}`);
}

let marked = 0;
if (!DRY_RUN) {
  // Outlook renders the list lazily and keeps serving a stale view for a few seconds, which is how
  // freshly arrived receipts were missed once. Navigate to the inbox again (a re-goto is what pulls
  // new mail), then run up to three passes until no unread receipt is left.
  for (let pass = 0; pass < 3; pass += 1) {
    const passRows = await readRows();
    const passTargets = passRows
      .map(row => ({ ...row, kind: classify(row) }))
      .filter(row => row.kind === "receipt" && row.unread);
    if (passTargets.length === 0) break;
    console.log(`pass ${pass + 1}: marking ${passTargets.length} receipt(s) read`);
    for (const target of passTargets) {
      const clicked = await page.evaluate(index => {
        const row = [...document.querySelectorAll('[role="option"]')][index];
        if (!row) return false;
        const button = row.querySelector('[aria-label="Mark as read" i], [title="Mark as read" i]');
        if (!button) return false;
        button.click();
        return true;
      }, target.index);
      if (clicked) marked += 1;
      await sleep(700);
    }
    await page.waitForTimeout(1500);
    await page.goto(inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3500);
  }
  rows = await readRows();
  const stillUnread = rows.filter(row => row.unread && classify(row) === "receipt").map(row => row.subject.slice(0, 110));
  console.log(JSON.stringify({
    marked,
    still_unread_receipts: stillUnread,
    unread: rows.filter(row => row.unread).map(row => `[${classify(row)}] ${row.subject.slice(0, 130)}`),
  }, null, 1));
}

await session.send("Target.closeTarget", { targetId }).catch(() => {});
process.exit(0);
