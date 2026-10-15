#!/usr/bin/env node
/**
 * fill_lever_cards.mjs — fill a Lever application form from a name/value plan.
 *
 * Lever has no settled driver in this repo, and its custom-question cards are plain controls carrying `name`
 * attributes, so the cheapest reusable tool is one that drives them directly:
 *
 *   - `radios`:   [{name, value}]  click the input whose value matches, fall back to its wrapping label, then verify
 *   - `selects`:  [{name, value}]  set the native select and dispatch change (Lever's EEO selects need this)
 *   - `texts`:    [{name, value}]  clear and retype with real keystrokes (the desync cure)
 *   - `checks`:   [{name}]         tick, verifying through the input's checked flag
 *   - `files`:    [{name, path}]   setInputFiles ONLY - never a click on the control, so no native dialog appears
 *
 * Everything is verified by reading the control back, and the run prints which entries did not stick.
 *
 * USAGE: node tmp/fill_lever_cards.mjs <url-part> <plan.json> [--submit-label "Submit application"]
 */
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const urlPart = process.argv[2];
const planPath = process.argv[3];
if (!urlPart || !planPath) { console.error("usage: fill_lever_cards.mjs <url-part> <plan.json>"); process.exit(2); }
const plan = JSON.parse(await readFile(planPath, "utf8"));

const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const results = [];
const log = (kind, name, ok, detail) => {
  results.push({ kind, name, ok, detail });
  console.log(`  ${ok ? "OK  " : "FAIL"} ${kind.padEnd(7)} ${String(name).slice(0, 54).padEnd(56)} ${detail || ""}`);
};

// radios
for (const item of plan.radios || []) {
  const done = await page.evaluate(({ name, value }) => {
    const inputs = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
    const hit = inputs.find((i) => (i.value || "").trim() === value) ||
                inputs.find((i) => (i.value || "").trim().toLowerCase().startsWith(value.toLowerCase()));
    if (!hit) return { ok: false, offered: inputs.map((i) => i.value).slice(0, 8) };
    hit.scrollIntoView({ block: "nearest" });
    if (!hit.checked) hit.click();
    if (!hit.checked) {
      const wrap = hit.closest("label") || hit.parentElement;
      if (wrap) wrap.click();
    }
    hit.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: hit.checked, picked: hit.value };
  }, item);
  log("radio", item.name, done.ok, done.ok ? `= ${done.picked}` : `offered ${JSON.stringify(done.offered)}`);
}

// native selects
for (const item of plan.selects || []) {
  const done = await page.evaluate(({ name, value }) => {
    const el = document.querySelector(`select[name="${CSS.escape(name)}"]`);
    if (!el) return { ok: false, why: "no select" };
    // MATCH A WHOLE WORD, NEVER A BARE SUBSTRING (fixed 2026-10-07, Palantir). The old fallback was
    // `includes(value)`, and asking this tenant's 3,302-option school picker for "Other" matched
    // "Christian Brothers University" - "other" sits inside "Brothers" - and set it. On a fact-bearing select that
    // is a false statement silently committed, which is the failure the honesty rule (docs/RULES.md, rule 4) exists to prevent. A near
    // match must now align to a word boundary ("Company Website" still matches "Company Website (Careers)").
    const needle = value.trim().toLowerCase();
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i");
    const opt = [...el.options].find((o) => (o.text || "").trim().toLowerCase() === needle) ||
                [...el.options].find((o) => (o.text || "").trim().toLowerCase().startsWith(needle)) ||
                [...el.options].find((o) => wordRe.test((o.text || "").trim()));
    if (!opt) {
      // SHOW THE WHOLE OFFERED LIST AND THE NEAR MISSES (fixed 2026-10-07, Palantir). Reporting only the first eight
      // options is useless on a select with a thousand of them - the school picker's first eight are all "Aalborg",
      // "Aalto", "Aarhus" - so a caller could not tell "the option is worded differently" from "this school is not
      // listed at all", which are different answers. The report now carries up to forty options plus every option
      // sharing a distinctive token of the wanted text.
      const texts = [...el.options].map((o) => o.text);
      const words = String(value).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      const near = words.length ? texts.filter((t) => words.some((w) => t.toLowerCase().includes(w))) : [];
      return { ok: false, why: "option not found", offered: texts.slice(0, 40), near: [...new Set(near)].slice(0, 12), total: texts.length };
    }
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, picked: opt.text };
  }, item);
  log("select", item.name, done.ok, done.ok ? `= ${done.picked}` : `${done.why} (${done.total || "?"} options)`);
  if (!done.ok && done.near && done.near.length) console.log("      closest options:", JSON.stringify(done.near));
  if (!done.ok && done.offered) console.log("      first options:", JSON.stringify(done.offered));
}

// texts and textareas, typed for real
for (const item of plan.texts || []) {
  const geo = await page.evaluate((name) => {
    const el = document.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width, 60) / 2), y: Math.round(r.y + r.height / 2), current: el.value || "" };
  }, item.name);
  if (!geo) { log("text", item.name, false, "not found"); continue; }
  if (geo.current.trim() === item.value.trim()) { log("text", item.name, true, "(already set)"); continue; }
  await page.mouse.click(geo.x, geo.y).catch(() => {});
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(item.value, { delay: 12 });
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(200);
  const now = await page.evaluate((name) => {
    const el = document.querySelector(`[name="${CSS.escape(name)}"]`);
    return el ? el.value : "(gone)";
  }, item.name);
  log("text", item.name, String(now).trim() === item.value.trim(), `= ${String(now).slice(0, 40)}`);
}

// checks
for (const item of plan.checks || []) {
  const done = await page.evaluate(({ name, value }) => {
    // A SAME-NAME CHECKBOX GROUP NEEDS A VALUE (fixed 2026-10-07, Palantir). Lever renders its whole "Language
    // Skill(s) (Check all that apply)" card - thirty-odd languages - as checkboxes that ALL carry one name, so
    // querySelector always returned the first in the DOM and a plan could only ever tick whichever language happened
    // to be first. An optional `value` now picks the intended box by its value attribute or by its wrapping label
    // text; the browser still does the ticking, and an unmatched value reports the offered list instead of guessing.
    const all = [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)];
    if (!all.length) return { ok: false, why: "no checkbox" };
    let el = all[0];
    if (value) {
      const want = String(value).toLowerCase();
      const labelOf = (x) => ((x.closest("label") || x.parentElement || {}).innerText || "").trim().toLowerCase();
      el = all.find((x) => (x.value || "").trim().toLowerCase() === want)
        || all.find((x) => labelOf(x) === want)
        || all.find((x) => (x.value || "").trim().toLowerCase().includes(want))
        || all.find((x) => labelOf(x).includes(want));
      if (!el) return { ok: false, why: "no checkbox matching value", offered: all.map((x) => x.value).slice(0, 40) };
    }
    el.scrollIntoView({ block: "nearest" });
    if (!el.checked) el.click();
    if (!el.checked) {
      const wrap = el.closest("label") || el.parentElement;
      if (wrap) wrap.click();
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: el.checked };
  }, { name: item.name, value: item.value || "" });
  log("check", item.name + (item.value ? ` value=${item.value}` : ""), done.ok, done.why || "");
  if (done.offered) console.log("      offered:", JSON.stringify(done.offered));
}

// files - setInputFiles only
for (const item of plan.files || []) {
  try {
    const input = page.locator(`input[type="file"][name="${item.name}"]`).first();
    await input.setInputFiles(item.path);
    await page.waitForTimeout(3000);
    const listed = await page.evaluate((name) => {
      const el = document.querySelector(`input[type="file"][name="${CSS.escape(name)}"]`);
      return el && el.files && el.files[0] ? el.files[0].name : "(none listed)";
    }, item.name);
    log("file", item.name, true, listed);
  } catch (e) {
    log("file", item.name, false, String(e).slice(0, 70));
  }
}


// checkboxes chosen by VALUE within a shared name (Lever's "select up to 3" groups)
for (const item of plan.checkValues || []) {
  const done = await page.evaluate(({ name, values }) => {
    const boxes = [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)];
    const picked = [];
    for (const v of values) {
      const box = boxes.find((b) => (b.value || "").trim() === v);
      if (!box) continue;
      box.scrollIntoView({ block: "nearest" });
      if (!box.checked) box.click();
      if (!box.checked) { const w = box.closest("label") || box.parentElement; if (w) w.click(); }
      box.dispatchEvent(new Event("change", { bubbles: true }));
      if (box.checked) picked.push(box.value);
    }
    return { picked, total: boxes.filter((b) => b.checked).length };
  }, item);
  log("checkVals", item.name, done.picked.length === item.values.length, `picked ${JSON.stringify(done.picked)} (total checked ${done.total})`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length} entries, ${bad.length} not confirmed`);
process.exit(0);
