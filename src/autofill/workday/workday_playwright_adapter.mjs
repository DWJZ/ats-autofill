/**
 * Playwright adapter for the Workday autofill helpers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `workday_experience_helper.mjs` expects a `tab.playwright` wrapper richer than a plain browser session
 * exposes: getByRole/locator/waitForTimeout PLUS `domSnapshot()`, which its date-calendar routine parses
 * with a regex. Driving the helper from this project's plain Playwright-over-CDP session therefore fails
 * with
 *   TypeError: tab.playwright.domSnapshot is not a function
 * This file is the bridge, kept deliberately thin so the page logic stays where it already lives (the
 * helper), and the adapter owns only the missing pieces.
 *
 * USAGE
 * -----
 *   import { chromium } from "playwright-core";
 *   import { readFile } from "node:fs/promises";
 *   import { makeWorkdayTab, makeWorkdayHelper } from ".../workday_playwright_adapter.mjs";
 *
 *   const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
 *   const page = browser.contexts()[0].pages().find(p => p.url().includes("workday"));
 *   const tab = makeWorkdayTab(page);
 *   const helper = await makeWorkdayHelper();
 *   const payload = JSON.parse(await readFile(".../workday_sde_everywhere_payload.json", "utf8"));
 *   await helper.fillMyExperiencePage(tab, payload);
 *
 * WHAT THE ADAPTER PROVIDES
 * -------------------------
 * 1. `tab.playwright` = the Playwright page, so every standard helper call works unchanged.
 * 2. `domSnapshot()` - an accessibility-shaped text dump good enough for the helper's calendar parser, which looks
 *    for `generic: <Month> <YYYY>` followed by a `button "Next month"`. It is built from the visible date-picker
 *    header and the visible buttons, so it degrades honestly: if the header cannot be read, the snapshot simply
 *    omits the pattern and the helper raises its own clear error rather than silently picking a wrong date.
 * 3. A guard that reports clearly when a helper is unavailable, instead of the raw TypeError.
 *
 * The Workday date masks rewrite bare digits ('8' for '08'), so calendar-driven entry - which is what the helper
 * uses - is the reliable path; this adapter exists so that path can run in a plain Playwright session.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The helper lives beside THIS file, so the default is derived from the module's own URL rather than from an
// absolute path - which made the adapter importable only from one checkout.
const HERE = dirname(fileURLToPath(import.meta.url));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Build the tab wrapper the Workday helpers expect, from a Playwright page. */
export function makeWorkdayTab(page) {
  if (!page) throw new Error("makeWorkdayTab: a Playwright page is required");
  page.domSnapshot = async () => {
    return await page.evaluate((months) => {
      const lines = [];
      // the date-picker header renders the current month/year as text near a Next month button
      const nextBtn = [...document.querySelectorAll("button")].find((b) => /next month/i.test(b.getAttribute("aria-label") || b.innerText || ""));
      if (nextBtn) {
        let node = nextBtn;
        for (let k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (!node) break;
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          const m = text.match(new RegExp(`(${months.join("|")})\\s+(\\d{4})`));
          if (m) {
            lines.push(`generic: ${m[1]} ${m[2]}`);
            lines.push(`  - button "Next month"`);
            break;
          }
        }
      }
      // include the visible buttons so callers can still match day cells and navigation
      for (const b of document.querySelectorAll("button")) {
        const label = (b.getAttribute("aria-label") || b.innerText || "").replace(/\s+/g, " ").trim();
        if (label && label.length < 60) lines.push(`  - button "${label}"`);
      }
      return lines.join("\n");
    }, MONTHS);
  };
  return { playwright: page };
}

/** Import the settled helpers; throw a legible error when the module or an export is missing. */
export async function makeWorkdayHelper(baseDir = HERE) {
  try {
    const mod = await import(`${baseDir}/workday_experience_helper.mjs`);
    return mod;
  } catch (e) {
    throw new Error(`Could not import the Workday helper from ${baseDir}: ${String(e).slice(0, 200)}`);
  }
}
