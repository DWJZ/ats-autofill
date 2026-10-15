/**
 * fill_big_autocomplete.mjs — fill an oversized react-select (school/university pickers and their kin) that renders no
 * match for the full official name but answers a short distinctive fragment.
 *
 * WHY THIS IS A TOOL AND NOT A ONE-OFF. The same field defeated two tenants in one session: "Lakeside State University,
 * Fairview" rendered ZERO options on Block and on Coinbase, twice each, while the single word "Fairview" rendered the
 * entry immediately on the sibling requisition. On Block the field was optional and was left blank; on Coinbase it is
 * REQUIRED, so the workaround decided whether an application could be submitted at all. A procedure I have to remember is
 * not a fix, so the routine lives here.
 *
 * WHAT IT DOES: opens the control, tries each query in order until options appear, prints them, clicks the EXACT option,
 * reads the committed value back, and leaves no menu open behind it (a stale open menu is what made an earlier option
 * read ambiguous - it returned the phone-country list instead of the control's own).
 *
 * USAGE
 *   node src/forms/fill_big_autocomplete.mjs --tab "<url fragment>" --id school--0 \
 *     --option "Lakeside State University, Fairview" --query Fairview --query "Cal State" \
 *     [--label-fragment school] [--cdp http://127.0.0.1:9223]
 *
 * EXIT: 0 when the option was clicked and the value reads back; 3 when no query rendered it (a real finding - the caller
 * should record it rather than invent a value).
 */
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const get = (flag, dflt = "") => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const all = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const cdp = get("--cdp", "http://127.0.0.1:9223");
const tabFrag = get("--tab");
const id = get("--id");
const option = get("--option");
const labelFrag = get("--label-fragment", "");
const queries = all("--query");
if (!tabFrag || !id || !option) { console.error("usage: fill_big_autocomplete.mjs --tab <frag> --id <id> --option <text> [--query q ...]"); process.exit(2); }
if (!queries.length) queries.push(option.split(",")[0].trim());

const b = await chromium.connectOverCDP(cdp);
// react-select renders [class*=select__option]; Lever and others render a plain list. Matching BOTH is what lets one
// tool drive either kind of menu, and reading the same constant in the listing and the click keeps them in step.
const OPTION_SELECTOR = "[class*=select__option], [role=option], ul[role=listbox] li, .dropdown-results > div, .dropdown-results li, [class*=dropdown-results] > div";

const p = b.contexts()[0].pages().find((x) => (x.url() || "").includes(tabFrag));
if (!p) { console.log(`no tab matching ${tabFrag}`); process.exit(2); }

const shown = () => p.evaluate((i) => {
  const e = document.getElementById(i);
  if (!e) return "(missing)";
  let w = e, c = null;
  for (let k = 0; k < 9 && w; k++) { if (w.classList && w.classList.contains("select__control")) { c = w; break; } w = w.parentElement; }
  const sv = c ? c.querySelector("[class*=select__single-value], [class*=select__multi-value__label]") : null;
  return sv ? sv.textContent.trim() : (e.value || "");
}, id);

if (labelFrag) {
  const guard = await p.evaluate(([i, frag]) => {
    const e = document.getElementById(i);
    if (!e) return { ok: false, label: "(no element)" };
    let w = e, label = "";
    for (let k = 0; k < 8 && w; k++) {
      const l = w.querySelector ? w.querySelector("label,legend") : null;
      const t = l ? (l.innerText || "").replace(/\s+/g, " ").trim() : "";
      if (t) { label = t; break; }
      const own = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (own.length > 15) { label = own; break; }
      w = w.parentElement;
    }
    return { ok: new RegExp(frag, "i").test(label), label: label.slice(0, 90) };
  }, [id, labelFrag]);
  console.log("guard:", JSON.stringify(guard));
  if (!guard.ok) { console.log("ABORTING: the control under that id is not the expected question."); process.exit(2); }
}

const ctl = p.locator(`[id="${id}"]`).locator("xpath=ancestor-or-self::*[contains(@class,'select__control')][1]").first();
const target = (await ctl.count()) ? ctl : p.locator(`[id="${id}"]`).first();
if (!(await target.count())) { console.log(`control ${id} NOT FOUND`); process.exit(2); }

for (const q of queries) {
  await p.keyboard.press("Escape").catch(() => {});          // never leave a stale menu open
  await p.waitForTimeout(300);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 12000 }).catch(() => {});
  await p.waitForTimeout(450);
  await p.keyboard.press("Meta+A").catch(() => {});
  await p.keyboard.press("Backspace").catch(() => {});
  await p.keyboard.type(q, { delay: 110 });
  let opts = [];
  for (let a = 0; a < 5 && !opts.length; a++) {
    await p.waitForTimeout(1700);
    opts = await p.evaluate((sel) => [...document.querySelectorAll(sel)].map((o) => (o.textContent || "").trim()).filter(Boolean), OPTION_SELECTOR);
  }
  console.log(`query ${JSON.stringify(q)} -> ${opts.length} option(s) ${JSON.stringify(opts.slice(0, 4))}`);
  const hit = opts.find((o) => o === option) || opts.find((o) => /Fairview|Lakeside State University, Fairview/i.test(o) && option.includes("Fairview"));
  if (hit) {
    const el = p.locator(OPTION_SELECTOR).filter({ hasText: new RegExp("^" + hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(800);
    const now = await shown();
    console.log(`clicked ${JSON.stringify(hit)} -> value now ${JSON.stringify(now)}`);
    await p.keyboard.press("Escape").catch(() => {});        // leave no menu open
    await p.waitForTimeout(250);
    process.exit(now ? 0 : 3);
  }
}
console.log(`NO query rendered ${JSON.stringify(option)}. The field is NOT set - record this rather than inventing a value.`);
await p.keyboard.press("Escape").catch(() => {});
process.exit(3);
