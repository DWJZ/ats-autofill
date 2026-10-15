import { chromium } from "playwright-core";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [urlPart, ...pairs] = process.argv.slice(2);
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find(p => p.url().includes(urlPart));
page.setDefaultTimeout(15000);
for (const pair of pairs) {
  const [q, ans] = pair.split("|");
  const entry = page.locator('[data-field-entry-id]', { hasText: q }).first();
  if (!(await entry.count())) { console.log("not found:", q); continue; }
  const btn = entry.locator(`button[data-option="${ans.toLowerCase()}"]`).first();
  if (!(await btn.count())) { console.log("no button", ans, "for", q); continue; }
  if ((await btn.getAttribute("aria-pressed")) !== "true") { await btn.click({ force: true }).catch(() => {}); await sleep(500); }
  console.log(`${q.slice(0, 46)} -> ${ans} (pressed=${await btn.getAttribute("aria-pressed")})`);
}
process.exit(0);
