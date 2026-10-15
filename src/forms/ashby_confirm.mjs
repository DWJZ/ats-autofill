/**
 * ashby_confirm.mjs — decide whether an Ashby application actually landed, from the PAGE, not the success string.
 *
 * WHY THIS EXISTS. Twice in one session a submission was recorded as successful and then reported as a STALE
 * SUCCESS, because it reads the page AFTER the form has already collapsed. Meanwhile a success string can also be
 * present on a page that reached that state during an EARLIER application - so neither the string nor the gate's
 * refusal is decisive on its own. What IS decisive is the shape of the page:
 *
 *   A COLLAPSED FORM  = success text present and the /application tab is down to 0 or 1 controls.
 *   A LIVE FORM       = roughly six or more controls, success text absent.
 *
 * A requisition cannot be both at once, so when tabs disagree it is the collapsed one that reflects a submission.
 * The bare posting URL is also checked when a tab is on it.
 *
 * This script is READ-ONLY: it never opens a page (newPage would steal focus, which the project contract forbids) and
 * never submits anything. Open the bare posting URL with `src/forms/cdp_tabs.mjs open` if you want it inspected.
 *
 * Usage:
 *   node src/forms/ashby_confirm.mjs --board sable [--cdp http://127.0.0.1:9223]
 *   node src/forms/ashby_confirm.mjs --url https://jobs.ashbyhq.com/sable/592b59d3-...
 *
 * Exit codes: 0 = SUBMITTED, 1 = NOT SUBMITTED, 2 = UNKNOWN (no tab on this requisition).
 */
import { chromium } from "playwright-core";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const board = arg("board");
const url = arg("url");
const cdp = arg("cdp", "http://127.0.0.1:9223");
if (!board && !url) {
  console.error("usage: --board <ashby board slug> | --url <bare posting url> [--cdp url]");
  process.exit(2);
}
// A bare posting URL carries the job id; the /application suffix is what a live form lives on.
const jobId = url ? (url.match(/\/([0-9a-f-]{36})/i) || [])[1] || "" : "";
const needle = jobId || board;

const browser = await chromium.connectOverCDP(cdp);
const pages = browser.contexts()[0].pages().filter((x) => {
  const u = x.url() || "";
  return u.includes("jobs.ashbyhq.com") && u.includes(needle);
});
if (!pages.length) {
  console.log(JSON.stringify({ needle, verdict: "UNKNOWN", why: "no Ashby tab on this requisition; open the bare posting URL first", exit: 2 }));
  process.exit(2);
}

const rows = [];
for (const p of pages) {
  const s = await p.evaluate(() => {
    const text = (document.body.innerText || "").replace(/\s+/g, " ");
    return {
      url: location.href,
      isApply: /\/application\/?$/.test(location.pathname),
      controls: document.querySelectorAll("input,textarea,select").length,
      success: /Application Success|successfully submitted/i.test(text),
      submitButtons: [...document.querySelectorAll("button,input[type=submit]")].filter((b) => /submit/i.test(b.innerText || b.value || "") && b.offsetParent !== null).length,
    };
  }).catch(() => null);
  if (s) rows.push(s);
}

// A collapsed apply tab with the success text is the strongest available evidence.
const collapsed = rows.filter((r) => r.isApply && r.controls <= 1 && r.success);
const live = rows.filter((r) => r.isApply && r.controls >= 4);
const verdict = collapsed.length ? "SUBMITTED" : live.length ? "NOT SUBMITTED" : "UNKNOWN";
const why = collapsed.length
  ? `apply tab down to ${collapsed[0].controls} control(s) with the success text - the collapse pattern`
  : live.length
    ? `apply tab still renders ${live[0].controls} controls and no success text`
    : "no apply tab matched a known shape";

// VERDICT FIRST, then the per-tab detail. A requisition can have several tabs at once (one collapsed with the
// thank-you text, others still rendering live forms), and a reader that only sees the tail must not infer the opposite
// conclusion from a stale tab.
console.log(`VERDICT: ${verdict} - ${why}`);
for (const [i, r] of rows.entries()) {
  console.log(`  tab ${i + 1}: apply=${r.isApply} controls=${r.controls} successText=${r.success} submitButtons=${r.submitButtons}`);
}
console.log(JSON.stringify({ needle, verdict, why, tabs: rows.map((r) => ({ apply: r.isApply, controls: r.controls, success: r.success, submitButtons: r.submitButtons })) }, null, 1));
process.exit(verdict === "SUBMITTED" ? 0 : verdict === "NOT SUBMITTED" ? 1 : 2);
