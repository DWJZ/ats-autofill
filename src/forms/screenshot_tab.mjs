/**
 * screenshot_tab.mjs — capture a tab to a PNG so a refusal can be LOOKED AT instead of theorised about.
 *
 * The standing contract requires a screenshot before theorising whenever a submit is refused, and no such tool existed -
 * which is why two refusals on the Abnormal Security form were reasoned about blind. This closes that gap.
 *
 * Usage:
 *   node src/forms/screenshot_tab.mjs <url-substring> [--out tmp/shot.png] [--cdp http://127.0.0.1:9223] [--full]
 *   node src/forms/screenshot_tab.mjs --list          # print every open tab, so the right one can be chosen
 */
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const get = (flag, dflt = "") => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const cdp = get("--cdp", "http://127.0.0.1:9223");
const out = get("--out", "tmp/screenshot.png");
const full = argv.includes("--full");

const b = await chromium.connectOverCDP(cdp);
const pages = b.contexts()[0].pages();

if (argv.includes("--list")) {
  console.log(`${pages.length} tab(s):`);
  pages.forEach((p, i) => console.log(`   ${i}: ${p.url()}`));
  process.exit(0);
}

const target = argv.find((a) => !a.startsWith("--") && a !== cdp && a !== out);
const indexArg = get("--index", "");
if (!target) { console.error("usage: screenshot_tab.mjs <url-substring> [--out x.png] [--full] [--index N] | --list"); process.exit(2); }
const hits = pages.filter((p) => (p.url() || "").includes(target));
console.log(`tabs matching ${JSON.stringify(target)}: ${hits.length}`);
hits.forEach((p, i) => console.log(`   ${i}: ${p.url()}`));
if (!hits.length) { console.error("no matching tab"); process.exit(2); }

// --index matters when two urls are prefixes of each other (…/<id> and …/<id>/application cannot be told apart by a
// substring), which is exactly how a posting page and its application page get confused.
let page;
if (indexArg !== "") {
  const n = Number(indexArg);
  if (!Number.isInteger(n) || n < 0 || n >= hits.length) { console.error(`--index ${indexArg} out of range 0..${hits.length - 1}`); process.exit(2); }
  page = hits[n];
} else {
  page = hits[hits.length - 1];
}
// NO bringToFront(): raising the tab would move the user's focus, which is forbidden. Playwright can capture a
// background tab without activating it, and the standing focus check must stay green.
await page.screenshot({ path: out, fullPage: full }).catch(async (e) => {
  console.error("screenshot failed:", String(e).slice(0, 80));
  process.exit(1);
});
console.log(`wrote ${out} (tab: ${page.url()}, fullPage: ${full})`);
process.exit(0);
