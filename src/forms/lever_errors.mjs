#!/usr/bin/env node
/**
 * lever_errors.mjs — read a Lever form's field-level errors and any still-blank required control.
 *
 * Lever reports refusals inline (red text next to the field, plus an error summary), and its labels carry a "✱" for
 * required fields. This prints the error strings it can find and, separately, every required-looking control that is
 * still empty, so the next step is a fix rather than a guess.
 *
 * USAGE: node tmp/lever_errors.mjs <url-part>
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2] || "";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const report = await page.evaluate(() => {
  const errors = [];
  for (const sel of [".error", "[class*=error]", "[class*=Error]", ".application-error", "[role=alert]", ".postings-error"]) {
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 200 && !errors.includes(t)) errors.push(t);
    }
  }
  const blanks = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = el.type || el.tagName.toLowerCase();
    if (["hidden", "submit", "button"].includes(type)) continue;
    const name = el.name || el.id || "";
    if (!name) continue;
    let node = el.closest(".application-question, [class*=card], fieldset") || el.parentElement;
    let label = "";
    for (let i = 0; i < 6 && node; i++) {
      const t = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 12) { label = t.slice(0, 80); break; }
      node = node.parentElement;
    }
    const required = /✱/.test(label) || el.required;
    const hasValue = (type === "checkbox" || type === "radio") ? el.checked : Boolean((el.value || "").trim()) || type === "file";
    if (required && !hasValue) blanks.push(`${type} ${name.slice(0, 50)} | ${label.replace(/✱/g, "*").slice(0, 60)}`);
  }
  const summary = (document.body.innerText.match(/[^\n]{0,80}(error|required|missing)[^\n]{0,80}/gi) || []).slice(0, 6);
  return { errors: [...new Set(errors)].slice(0, 8), blanks: [...new Set(blanks)].slice(0, 10), summary };
});

console.log("ERROR TEXT:");
report.errors.forEach((e) => console.log("  -", e.slice(0, 150)));
console.log("\nSTILL-BLANK REQUIRED CONTROLS:");
report.blanks.forEach((e) => console.log("  -", e));
console.log("\nPAGE MENTIONS:");
report.summary.forEach((e) => console.log("  -", e.slice(0, 130)));
process.exit(0);
