#!/usr/bin/env node
/**
 * fill_by_label.mjs — fill a form control by the text of its question, for tenants (Ashby in
 * particular) whose inputs carry no id and no label[for]. Walks up from the control until it finds
 * an ancestor whose text starts with the given question, then fills/types the value.
 *
 * Usage:
 *   node src/forms/fill_by_label.mjs "<url substring>" "<question prefix>" "<value>" [--select]
 *
 * --select  treat the control as a combobox: type the value and click the first matching option.
 */
import { chromium } from "playwright-core";

const [urlSub, question, value, ...flags] = process.argv.slice(2);
const asSelect = flags.includes("--select");
if (!urlSub || !question || value === undefined) {
  console.error('usage: node src/forms/fill_by_label.mjs "<url substring>" "<question prefix>" "<value>" [--select]');
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages().find(p => p.url().includes(urlSub) && !/confirmation/.test(p.url()));
if (!page) { console.error("tab not found for", urlSub); process.exit(2); }
page.setDefaultTimeout(15000);

const handle = await page.evaluateHandle((q) => {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  for (const el of [...document.querySelectorAll("input,textarea,[role=combobox]")].filter(vis)) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "file", "checkbox", "radio", "submit"].includes(type)) continue;
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const t = clean(node.innerText);
      if (t && t.toLowerCase().startsWith(q.toLowerCase())) return el;
      node = node.parentElement;
    }
  }
  return null;
}, question);
const el = handle.asElement();
if (!el) { console.error("no control found for question:", question); process.exit(3); }

await el.scrollIntoViewIfNeeded().catch(() => {});
if (asSelect) {
  await el.click({ timeoutMs: 8000 }).catch(() => {});
  await sleep(300);
  await el.click({ timeout: 12000 }).catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 20 });
  await sleep(1400);
  const opts = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("[role=listbox] [role=option]").forEach(o => { if (o.offsetParent !== null) out.push((o.textContent || "").trim()); });
    return out;
  });
  const want = opts.find(o => o.toLowerCase() === value.toLowerCase()) || opts.find(o => o.toLowerCase().startsWith(value.toLowerCase())) || opts[0];
  if (!want) { console.error("no option for", value, "| options:", JSON.stringify(opts.slice(0, 5))); process.exit(4); }
  await page.getByRole("option", { name: new RegExp("^" + want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }).first().click({ timeoutMs: 8000 });
  await sleep(500);
  console.log(`${question} = ${want}`);
} else {
  await el.click({ timeoutMs: 8000 }).catch(() => {});
  await el.click({ timeout: 12000 }).catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 20 });
  await sleep(300);
  const now = await el.inputValue().catch(() => "");
  console.log(`${question} = ${JSON.stringify(now)}`);
  if (now !== value) process.exit(5);
}
process.exit(0);
