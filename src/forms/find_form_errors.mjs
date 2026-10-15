#!/usr/bin/env node
// A NATIVE VALIDATION BUBBLE IS INVISIBLE TO EVERY TOOL HERE. Four submits on Palantir (2026-10-07) returned
// `confirmed: false`, kind "no wording found", while every tool reported the form complete: this one said 0
// `aria-invalid`, and the inventory listed every required field as filled. The browser renders that bubble in its
// own UI, so nothing that reads the DOM - and no screenshot the filler takes - can see it. When a submit is
// refused with every check green, ask the USER what the page says before refilling anything.

/**
 * find_form_errors.mjs — screenshot what a Greenhouse form is actually complaining about.
 *
 * The user's advice, twice proven today: when a submit is refused, look at the page instead of reasoning about it.
 * This collects anything the form marks invalid or paints in an error colour, scrolls the first such control into
 * view, and saves a viewport screenshot next to the url part so it can be read directly.
 *
 * USAGE: node tmp/find_form_errors.mjs <url-part> [shot-name]
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2];
const shot = process.argv[3] || `tmp/err_${(urlPart || "x").slice(0, 10)}.png`;
if (!urlPart) { console.error("usage: find_form_errors.mjs <url-part> [shot-name]"); process.exit(2); }

const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const found = await page.evaluate(() => {
  const out = [];
  const mark = (el, why) => {
    const t = (el.innerText || el.getAttribute("aria-label") || el.value || "").replace(/\s+/g, " ").trim();
    if (t && t.length < 140) out.push(`${why}: ${t}`);
  };
  for (const el of document.querySelectorAll('[aria-invalid="true"]')) mark(el, "ARIA-INVALID");
  for (const el of document.querySelectorAll("span[role=alert], .field-error, [class*=errorMessage]")) mark(el, "ALERT");
  for (const el of document.querySelectorAll("div, span, p, label, li")) {
    const c = getComputedStyle(el).color || "";
    const m = c.match(/rgb\((\d+), *(\d+), *(\d+)\)/);
    if (!m) continue;
    const [r, g, bl] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 150 && r > g + 60 && r > bl + 60) mark(el, "RED");
  }
  return [...new Set(out)].slice(0, 10);
});
console.log("error-ish text:");
found.forEach((f) => console.log("   ", f));
if (!found.length) console.log("    (nothing marked invalid or coloured red)");

const scrolled = await page.evaluate(() => {
  const el = document.querySelector('[aria-invalid="true"]');
  if (!el) return false;
  el.scrollIntoView({ block: "nearest" });
  return true;
});
await page.waitForTimeout(700);
await page.screenshot({ path: shot });
console.log("scrolled to an invalid control:", scrolled, "| screenshot:", shot);
process.exit(0);
