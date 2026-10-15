// ashby_combobox_by_index.mjs — fill an ID-LESS Ashby combobox whose question text cannot be located.
//
// Usage: node src/forms/ashby_combobox_by_index.mjs <url-part> "<value to choose>" [--cdp URL] [--dry-run]
//
// WHY THIS EXISTS (Benchling, 2026-10-03). A required field named "U.S. Work Authorization Status" renders as an id-less
// input[role=combobox] with placeholder "Start typing...". apply_form_spec has no selects entry for it because it is not a
// native select, and pick_ashby_combobox reports "combobox not found" because it anchors on the container whose text carries
// the question - and on this form that container is unreachable. The page has three such comboboxes; the first holds the
// Location and the empty ones are the target.
//
// TWO RULES THIS ENCODES, EACH LEARNED BY GETTING IT WRONG:
//   1. CLICK THROUGH THE LOCATOR, NEVER BY RAW COORDINATES. These controls can sit far below the viewport - on this form at
//      y=2962 and y=3177 - and a mouse click at those coordinates hits empty space, so no rows ever render. Locator clicks
//      scroll the element into view first. (Notion taught the same lesson on its option buttons.)
//   2. READ THE FILTERED ROWS AND COUNT THE OFFSET BEFORE PRESSING ENTER. Enter takes the FIRST match, not the intended one,
//      so the wanted row's position in the rendered list is counted and ArrowDown is pressed that many times.
import { chromium } from "playwright-core";

const [urlPart, value] = process.argv.slice(2);
const cdpIdx = process.argv.indexOf("--cdp");
const CDP = cdpIdx > 0 ? process.argv[cdpIdx + 1] : "http://127.0.0.1:9223";
const dry = process.argv.includes("--dry-run");
if (!urlPart || !value) { console.error('usage: ashby_combobox_by_index.mjs <url-part> "<value>" [--cdp URL] [--dry-run]'); process.exit(2); }

const SEL = 'input[role="combobox"], input[aria-autocomplete="list"]';
const b = await chromium.connectOverCDP(CDP);
const page = b.contexts()[0].pages().find((p) => (p.url() || "").includes(urlPart));
if (!page) { console.log("tab missing for", urlPart); process.exit(2); }

// global index among ALL comboboxes, plus whether it is empty and where it sits
const listCombos = () => page.evaluate((sel) => {
  const out = [];
  [...document.querySelectorAll(sel)].forEach((e, gi) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    out.push({ gi, value: e.value || "", ph: (e.placeholder || "").slice(0, 22) });
  });
  return out;
}, SEL);
const listRows = () => page.evaluate(() => {
  const out = [];
  for (const s of ['[role="listbox"]', '[class*="select__menu"]', '[class*="menu"]']) {
    for (const el of document.querySelectorAll(s)) {
      if (el.offsetParent === null) continue;
      for (const o of el.querySelectorAll('[role="option"], li, [class*="option"]')) {
        const t = (o.innerText || "").trim();
        if (t && t.length < 90) out.push(t);
      }
    }
  }
  return [...new Set(out)];
});

const before = await listCombos();
console.log("VISIBLE COMBOBOXES:", JSON.stringify(before.map((c) => `#${c.gi} ${c.ph}${c.value ? `="${c.value.slice(0, 16)}"` : " (empty)"}`)));
const empties = before.filter((c) => !c.value.trim());
console.log(`empty comboboxes to try: ${empties.length}`);

for (const target of empties) {
  const loc = page.locator(SEL).nth(target.gi);
  console.log(`--- combobox #${target.gi}: scroll into view, then locator click`);
  if (dry) continue;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);
  await loc.click({ timeout: 8000 }).catch((e) => console.log("    click error:", String(e).slice(0, 70)));
  await page.waitForTimeout(400);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(value, { delay: 35 });
  await page.waitForTimeout(1400);
  const rows = await listRows();
  console.log("    rows:", JSON.stringify(rows.slice(0, 12)));
  if (!rows.length) {
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter").catch(() => {});
  } else {
    // count the offset of the wanted row and press ArrowDown that many times - Enter takes the FIRST match
    const idx = rows.findIndex((r) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(r));
    const offset = idx < 0 ? 0 : idx;
    console.log(`    wanted row index ${idx}; pressing ArrowDown ${offset} time(s) then Enter`);
    for (let i = 0; i < offset; i++) { await page.keyboard.press("ArrowDown").catch(() => {}); await page.waitForTimeout(140); }
    await page.keyboard.press("Enter").catch(() => {});
  }
  await page.waitForTimeout(800);
  const after = await listCombos();
  console.log("    comboboxes now:", JSON.stringify(after.map((c) => c.value.slice(0, 26) || "(empty)")));
  if (after.some((c) => new RegExp("^" + value.slice(0, 3), "i").test(c.value))) { console.log("COMMITTED:", JSON.stringify(after.map((c) => c.value))); process.exit(0); }
}
console.log("no combobox accepted the value");
process.exit(1);
