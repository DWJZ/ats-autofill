#!/usr/bin/env node
/**
 * ashby_errors.mjs — read the field names an Ashby refusal lists, and any control it points at.
 *
 * Ashby's refusals read "Missing entry for required field: <NAME>" and each name is also a button that jumps to the
 * offending control. This prints the names, and for each one tries to locate the field container by that text so its
 * real control type and options are visible - which turns a refusal into a fix instead of a guess.
 *
 * USAGE: node tmp/ashby_errors.mjs <url-part>
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2] || "";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const report = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, " ");
  const names = [...new Set((text.match(/Missing entry for required field: [^.]{2,80}/g) || []))];
  const resolved = [];
  for (const raw of names) {
    const label = raw.replace("Missing entry for required field:", "").trim();
    let found = null;
    for (const wrap of document.querySelectorAll("[data-field-path], fieldset, [class*=fieldEntry]")) {
      const t = (wrap.innerText || "").replace(/\s+/g, " ").trim();
      if (!t.toLowerCase().includes(label.toLowerCase().slice(0, 24))) continue;
      const controls = [...wrap.querySelectorAll("input, select, textarea")].filter((c) => (c.type || "") !== "hidden");
      if (!controls.length) continue;
      found = {
        label: label.slice(0, 60),
        controls: controls.slice(0, 6).map((c) => `${c.type || c.tagName.toLowerCase()}${c.id ? " id=" + c.id.slice(0, 40) : ""}${c.name ? " name=" + c.name.slice(0, 30) : ""} value=${(c.value || "").slice(0, 20)}`),
      };
      break;
    }
    resolved.push(found || { label: label.slice(0, 60), controls: ["(container not found)"] });
  }
  return { names: names.slice(0, 8), resolved };
});

console.log("REFUSAL NAMES:");
report.names.forEach((n) => console.log("  -", n.slice(0, 110)));
console.log("\nRESOLVED CONTROLS:");
report.resolved.forEach((r) => {
  console.log(`  ${r.label}:`);
  (r.controls || []).forEach((c) => console.log(`      ${c}`));
});
process.exit(0);
