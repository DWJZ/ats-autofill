#!/usr/bin/env node
/**
 * retype_all_text.mjs — re-enter every text field with REAL KEYSTROKES.
 *
 * Ashby refused the submission twice, first naming PHONE NUMBER and then FULL NAME, while the DOM held both values:
 * that is the text-field desync the project has documented (the DOM property is right, React's model is empty, and
 * only the server notices). The cure is to clear each field and retype it with real keystrokes and then Tab away,
 * which dispatches through the framework. This does that for every visible text-like input, reading each value back.
 *
 * USAGE: node src/forms/retype_all_text.mjs [url-part]     (default url-part: "b3fab313", the tenant it was written on)
 *
 * NOTE: the tab was HARDCODED to b3fab313, so for every other tenant the tool printed "tab missing" and exited 0 -
 * a silent no-op that looks like a pass. Found on Replit (2026-10-03) while chasing values that vanished from the DOM.
 */
import { chromium } from "playwright-core";

const urlPart = process.argv[2] || "b3fab313";
const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
// --values <file.json> : { "<element id or name>": "<text>" }. Types supplied text into supplied elements with real
// keystrokes, clearing first and Tabbing away afterwards, and reads every value back. This is the mode that can repair a
// REQUIRED field the server reports as empty, which the retype-existing-values path cannot do.
const _vi = process.argv.indexOf("--values");
if (_vi >= 0 && process.argv[_vi + 1]) {
  const fs = await import("node:fs");
  const plan = JSON.parse(fs.readFileSync(process.argv[_vi + 1], "utf8"));
  const tabArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const bp = b.contexts()[0].pages().find((p) => p.url().includes(tabArg || ""));
  if (!bp) { console.log("tab missing for", tabArg); process.exit(0); }
  for (const [sel, text] of Object.entries(plan)) {
    // An element id that begins with a digit is not a valid CSS id selector, so address it by attribute instead.
    const bare = sel.startsWith("id:") ? sel.slice(3) : sel;
    let loc;
    if (sel.startsWith("question:")) {
      // Locate by the question text, for ATS fields rendered with no id and no name (Ashby does this). Added
      // 2026-10-05 after Oneleet's required city field was pre-filled with the wrong location and could not be
      // reached by id or name at all.
      const needle = sel.slice("question:".length);
      const handle = await bp.evaluateHandle((q) => {
        const fields = [...document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea, select')];
        for (const el of fields) {
          let host = el.closest("div, fieldset, section, li");
          for (let i = 0; i < 6 && host; i += 1) {
            const t = (host.innerText || "").replace(/\s+/g, " ").trim();
            if (t.length > 8) {
              if (t.toLowerCase().includes(String(q).toLowerCase())) return el;
              break;
            }
            host = host.parentElement;
          }
        }
        return null;
      }, needle);
      const el = handle.asElement();
      if (!el) { console.log("NOT FOUND:", sel); continue; }
      loc = el;
    } else {
      loc = bp.locator(`[id="${bare}"], [name="${bare}"]`).first();
    }
    // `loc` is a Locator for id/name targets and an ElementHandle for question targets; ElementHandle has no
    // count(), scrollIntoViewIfNeeded() or inputValue(), so the three operations are written for both.
    const isLocator = typeof loc.count === "function";
    if (isLocator && !(await loc.count())) { console.log("NOT FOUND:", sel); continue; }
    if (isLocator) await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 12000 }).catch(() => {});
    await bp.waitForTimeout(180);
    // NEVER TYPE INTO WHATEVER HAPPENS TO HAVE FOCUS (fixed 2026-10-07). Workable's address sub-fields (city,
    // postcode) are display-only - the address widget fills them - so on Creative Chaos the click above failed
    // silently, focus stayed on the field the PREVIOUS entry's Tab had landed on, and "Springfield" and "62704" were
    // keyed into the two REQUIRED "years of experience" textareas. The tool reported only "FAIL city len 0", so the
    // damage was invisible until the form was read back. A click that cannot be proven must stop the entry.
    const focused = isLocator
      ? await loc.evaluate((el) => el === document.activeElement).catch(() => false)
      : await bp.evaluate((el) => el === document.activeElement, loc).catch(() => false);
    if (!focused) { console.log("NOT FOCUSED, skipped:", sel, "- nothing was typed, so no field can have been written"); continue; }
    await bp.keyboard.press("Meta+A").catch(() => {});
    await bp.keyboard.press("Backspace").catch(() => {});
    await bp.keyboard.type(text, { delay: 5 });
    await bp.keyboard.press("Tab");
    await bp.waitForTimeout(420);
    const got = isLocator
      ? await loc.inputValue().catch(() => "")
      : await bp.evaluate((el) => el.value || "", loc).catch(() => "");
    console.log((got || "").trim() === String(text).trim() ? "OK  " : "FAIL", sel.slice(0, 40), "len", (got || "").length);
  }
  process.exit(0);
}

const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing for", urlPart); process.exit(0); }

const targets = await page.evaluate(() => {
  const out = [];
  for (const input of document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea')) {
    const wrap = input.closest("[data-field-path]");
    const label = wrap ? (wrap.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const value = input.value || "";
    const r = input.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (/start typing/i.test(input.placeholder || "")) continue; // the location autocomplete is already committed
    if (!value) continue;
    input.setAttribute("data-retype", String(out.length));
    out.push({ idx: out.length, label, value });
  }
  return out;
});
console.log("fields to retype:", JSON.stringify(targets.map((t) => [t.label.slice(0, 34), t.value.slice(0, 24)])));

for (const t of targets) {
  const geo = await page.evaluate((idx) => {
    const el = document.querySelector(`[data-retype="${idx}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    el.select && el.select();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width, 80) / 2), y: Math.round(r.y + r.height / 2) };
  }, t.idx);
  if (!geo) { console.log(`  ${t.label}: control gone`); continue; }
  await page.mouse.click(geo.x, geo.y);
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(t.value, { delay: 30 });
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(250);
  const now = await page.evaluate((idx) => {
    const el = document.querySelector(`[data-retype="${idx}"]`);
    return el ? el.value : "(gone)";
  }, t.idx);
  const ok = String(now).replace(/\s/g, "") === String(t.value).replace(/\s/g, "");
  console.log(`  ${ok ? "OK  " : "DIFF"} ${t.label.slice(0, 40)} -> ${String(now).slice(0, 34)}`);
  await page.evaluate((idx) => document.querySelector(`[data-retype="${idx}"]`)?.removeAttribute("data-retype"), t.idx);
}

// re-assert the radios and pairs that the retype pass must not have touched
const check = await page.evaluate(() => {
  const out = [];
  for (const wrap of document.querySelectorAll("[data-field-path]")) {
    const radios = [...wrap.querySelectorAll('input[type="radio"]')];
    if (!radios.length) continue;
    const label = (wrap.innerText || "").replace(/\s+/g, " ").trim().slice(0, 44);
    const chosen = radios.find((r) => r.checked);
    let text = null;
    if (chosen) {
      const byFor = chosen.id ? document.querySelector(`label[for="${CSS.escape(chosen.id)}"]`) : null;
      text = byFor ? (byFor.innerText || "").trim().slice(0, 40) : "(checked)";
    }
    out.push(`${label} -> ${text}`);
  }
  return out;
});
console.log("RADIOS AFTER RETYPE:");
check.forEach((c) => console.log("  -", c));
process.exit(0);
