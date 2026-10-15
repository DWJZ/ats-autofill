#!/usr/bin/env node
/**
 * answer_ashby_widgets.mjs — answer Ashby Yes/No widgets by their QUESTION TEXT.
 *
 * Some Ashby tenants render work-authorisation questions as controls with long composite ids and sometimes no usable
 * `name`, in mixed widget types (a radio pair here, a checkbox pair there). The reliable handle is the question text
 * itself: walk up from each Yes/No control to the container that holds both options, match the container's text
 * against the question, then click the wanted option's own input and, if that does not register, its wrapping label.
 * Each answer is verified by reading the input's checked flag.
 *
 * USAGE: node tmp/answer_ashby_widgets.mjs <url-part> '[["<question fragment>","Yes|No"], ...]'
 */
import { chromium } from "playwright-core";

import { readFile } from "node:fs/promises";
const [urlPart, specArg, maybeFile] = process.argv.slice(2);
if (!urlPart || !specArg) { console.error('usage: answer_ashby_widgets.mjs <url-part> \'[["question","Yes"]]\' | --file <plan.json>'); process.exit(2); }
const spec = specArg === "--file" ? JSON.parse(await readFile(maybeFile, "utf8")) : JSON.parse(specArg);

const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }

const run = async (verifyOnly) =>
  await page.evaluate(({ spec, verifyOnly }) => {
    const out = [];
    for (const [fragment, want] of spec) {
      const needle = fragment.toLowerCase();
      // Keep the TIGHTEST container: the one with the fewest inputs that still holds the two options. Assigning on
      // every match (as the first version did) leaves the outermost element, whose input list is the whole form.
      let container = null;
      let bestCount = Infinity;
      for (const el of document.querySelectorAll("div, fieldset, section")) {
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!text.toLowerCase().includes(needle) || text.length > 400) continue;
        const optInputs = [...el.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
        if (optInputs.length < 2) continue;
        if (optInputs.length < bestCount) { bestCount = optInputs.length; container = el; }
      }
      if (!container) { out.push({ fragment, ok: false, why: "container not found" }); continue; }
      const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
      // The option's text lives in a div whose class contains "option" (the input's grandparent on this tenant),
      // not in a <label>; clicking that div is what actually registers.
      const optionNode = (input) =>
        input.closest('[class*="option"]') || input.closest("label") || input.parentElement;
      const labelFor = (input) => {
        const l = optionNode(input);
        return l ? (l.innerText || "").trim() : "";
      };
      const target = inputs.find((i) => labelFor(i).toLowerCase() === want.toLowerCase())
        || inputs.find((i) => labelFor(i).toLowerCase().startsWith(want.toLowerCase()))
        || inputs[want.toLowerCase() === "yes" ? 0 : inputs.length - 1];
      if (!verifyOnly && target && !target.checked) {
        target.scrollIntoView({ block: "nearest" });
        const node = optionNode(target);
        if (node) node.click();
        if (!target.checked) target.click();
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const chosen = inputs.find((i) => i.checked);
      out.push({
        fragment,
        requested: want,
        ok: Boolean(chosen && labelFor(chosen).toLowerCase().includes(want.toLowerCase().slice(0, 3))),
        chosen: chosen ? labelFor(chosen).slice(0, 24) : null,
      });
    }
    return out;
  }, { spec, verifyOnly });

console.log("SET:");
for (const r of await run(false)) console.log(`  ${r.ok ? "OK  " : "FAIL"} [${r.fragment.slice(0, 46)}] requested=${r.requested} chosen=${JSON.stringify(r.chosen)}${r.why ? " (" + r.why + ")" : ""}`);
await page.waitForTimeout(1000);
console.log("VERIFY:");
for (const r of await run(true)) console.log(`  ${r.ok ? "OK  " : "FAIL"} [${r.fragment.slice(0, 46)}] -> ${JSON.stringify(r.chosen)}`);
process.exit(0);
