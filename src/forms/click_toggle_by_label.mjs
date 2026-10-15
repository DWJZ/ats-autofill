#!/usr/bin/env node
/** Click a Yes/No (or any button-option) toggle by its question text. Usage:
 *    node src/forms/click_toggle_by_label.mjs "<url substring>" '[["question prefix","Yes"], ...]'
 *  Ashby renders Yes/No questions as button pairs rather than radios, so the generic filler cannot
 *  reach them. */
import { chromium } from "playwright-core";
const urlSub = process.argv[2];
const pairs = JSON.parse(process.argv[3]);   // [["question prefix","Yes"], ...]
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages().find(p => p.url().includes(urlSub) && !/confirmation/.test(p.url()));
if (!page) { console.error("tab not found"); process.exit(1); }
page.setDefaultTimeout(15000);
for (const [q, answer] of pairs) {
  const res = await page.evaluate(({ q, answer }) => {
    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const nodes = [...document.querySelectorAll("div,fieldset,section")].filter(n => vis(n) && clean(n.innerText).toLowerCase().startsWith(q.toLowerCase()));
    if (!nodes.length) return "question not found";
    // smallest matching container so we do not hit another question's buttons
    const box = nodes.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length)[0];
    let btn = [...box.querySelectorAll("button")].find(b => clean(b.innerText).toLowerCase() === answer.toLowerCase());
    // CLICK BY ATTRIBUTE WHEN THERE IS NO VISIBLE TEXT (added 2026-10-07). Two independent tenants need this and
    // nothing in the toolkit could do it: Stripe's Greenhouse school field opens through a button whose only name is
    // aria-label="Toggle flyout", and NVIDIA's Workday source field through span[data-automation-id=promptSearchButton].
    // Neither is a role and neither has visible text, so every clicker missed them and the fields could not be driven
    // at all. Match aria-label or data-automation-id when the text match fails.
    if (!btn) {
      const want = answer.toLowerCase();
      btn = [...box.querySelectorAll("button,[role=button],span")].find(b => {
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const auto = (b.getAttribute("data-automation-id") || "").toLowerCase();
        return aria === want || auto === want;
      });
    }
    if (!btn) return "toggle not found";
    btn.click();
    return "clicked";
  }, { q, answer }).catch(e => e.message);
  await sleep(400);
  console.log(`${q} -> ${answer}: ${res}`);
}
process.exit(0);
