#!/usr/bin/env node
/**
 * ashby_location_keys.mjs - commit an Ashby Location autocomplete with the KEYBOARD.
 *
 * Discovered on Luma AI's tenant: the location field never paints an option list, so every click-based picker had
 * nothing to click, but ArrowDown + Enter commits the first filtered suggestion and clears the server's
 * "Missing entry for required field: Location". The first suggestion is not necessarily the right one - a city name
 * that exists in more than one country or state autocompletes to the one the tenant lists first, so the SAME query
 * can commit a different place than the candidate lives in - so this tries progressively shorter queries and only
 * accepts a committed value that names the candidate's own STATE or COUNTRY, pressing Down N times when the right
 * row is further down the list.
 *
 * USAGE: node src/forms/ashby_location_keys.mjs <url-part> <address> [maxDown]
 *   <address> is the place to commit, in the profile's own shape: "City, State, Country", i.e.
 *             `application_profile.json -> candidate.address`. There is NO built-in default, because a hardcoded
 *             place would answer a location field for a candidate who may not live there - and the state half of it
 *             is what this script used to carry: a query list spelled `, CA` / `, California` and an acceptance
 *             test defaulted to "california", so a candidate in Toronto had the autocomplete queried with a US
 *             address and an expectation no Canadian row can satisfy. The queries AND the accepted values are now
 *             both derived from the address by `ashby_location_query.mjs`, so the thing typed and the thing
 *             verified cannot drift apart, and neither is testable only through a browser.
 */
import { chromium } from "playwright-core";
// Sibling import: this file is an ordinary Node ESM script and the rule it applies is pure, so it lives in a module
// that a test can import without a browser (test_ashby_location_query.mjs).
import { committedMatches, locationPlan } from "./ashby_location_query.mjs";

const urlPart = process.argv[2] || "";
const address = process.argv[3] || "";
const maxDown = Number(process.argv[4] ?? 4);
// THE OLD ARGUMENT PAIR IS REFUSED RATHER THAN MISREAD. This script used to take `<city> <expect>`, and a caller
// still passing that shape would have its expectation - a city name - read as `maxDown` (NaN, so the Enter loop
// never runs and the run reports NOT COMMITTED with nothing typed) or as a fifth argument that no longer exists.
// It fails loudly instead: the whole point of the change is that the accepted value comes from the same address as
// the query, so there is no longer a caller that has one and not the other.
if (!urlPart || !address || process.argv.length > 5 || !Number.isInteger(maxDown) || maxDown < 0) {
  console.error("usage: ashby_location_keys.mjs <url-part> <address> [maxDown]");
  console.error('  <address> is "City, State, Country" - application_profile.json -> candidate.address. It has no');
  console.error("  default, and the old <city> <expect> pair is gone: the accepted value is derived from the same");
  console.error("  address the query is built from, so the two cannot disagree.");
  process.exit(2);
}
const { queries, expectations } = locationPlan(address);
console.log(`committing ${address} - accepting any value naming ${expectations.join(" | ") || "(nothing)"}`);

const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const find = async () => await page.evaluate(() => {
  for (const el of document.querySelectorAll('input:not([type="hidden"])')) {
    const wrap = el.closest("[data-field-path]");
    const lab = wrap ? (wrap.innerText || "").replace(/\s+/g, " ").trim() : "";
    if (!/^location/i.test(lab) && !/start typing/i.test(el.placeholder || "")) continue;
    el.setAttribute("data-loc-keys", "1");
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width, 90) / 2), y: Math.round(r.y + r.height / 2), value: el.value || "" };
  }
  return null;
});

for (const q of queries) {
  const start = await find();
  if (!start) { console.log("input not found"); process.exit(0); }
  if (committedMatches(start.value, expectations)) { console.log("ALREADY OK:", start.value); process.exit(0); }
  await page.mouse.click(start.x, start.y).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(q, { delay: 80 });
  await page.waitForTimeout(2200);
  for (let down = 0; down <= maxDown; down++) {
    if (down > 0) { await page.keyboard.press("ArrowDown").catch(() => {}); await page.waitForTimeout(400); }
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(900);
    const now = await find();
    const val = now ? now.value : "";
    console.log(`query "${q}" down=${down} -> ${val}`);
    if (committedMatches(val, expectations)) { console.log("COMMITTED:", val); process.exit(0); }
    // re-open the list for the next candidate
    if (down < maxDown) {
      await page.mouse.click(now.x, now.y).catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press("Meta+a").catch(() => {});
      await page.keyboard.type(q, { delay: 40 });
      await page.waitForTimeout(1200);
    }
  }
}
console.log("NOT COMMITTED");
process.exit(0);
