#!/usr/bin/env node
/**
 * set_radio.mjs — set radio groups by the browser's OWN label association, never by coordinates.
 *
 * Two earlier attempts mis-selected options on Snowflake's Ashby form (choosing 'citizen of Cuba, Iran, North Korea
 * or Syria' for the U.S.-person question, 'Yes - previously worked at PwC', and later flipping Race to Native
 * Hawaiian) because they clicked labels by position/substring. This version removes the guesswork:
 *
 *   1. find each radio input in the target group;
 *   2. resolve the option text through the input's OWN association - label[for=id], else a wrapping label that
 *      contains exactly this one input, else aria-label - so input and text cannot drift apart;
 *   3. click the INPUT itself (radios respond to a native click; no coordinates involved);
 *   4. read `checked` back and report the group's final answer.
 *
 * USAGE
 *   node tmp/set_radio.mjs <cdp> <url-part> '[["<group label regex>","<exact option text>"], ...]'
 */
import { chromium } from "playwright-core";
import { DEFAULT_WAIT_MS, boundedPage } from "./bounded_waits.mjs";

// Typographic-character normalisation (added 2026-10-03). Fluidstack's non-compete question uses a NON-BREAKING HYPHEN
// (U+2011) in "non-compete", so a regex written with an ASCII hyphen matched nothing and the question went unanswered -
// it was submitted with the wrong value. Normalise dashes, non-breaking spaces and smart quotes on BOTH sides of every
// comparison, and apply the same normalisation to the pattern's own literal characters.
function normText(s) {
  return String(s || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"');
}


const [cdp, urlPart, specJson] = process.argv.slice(2);
if (!cdp || !urlPart || !specJson) {
  console.error('usage: set_radio.mjs <cdp> <url-part> \'[["<group regex>","<option text>"]]\'');
  process.exit(2);
}
const spec = JSON.parse(specJson);

const b = await chromium.connectOverCDP(cdp);
const page = b.contexts()[0].pages().find((p) => p.url().includes(urlPart));
if (!page) { console.log("tab missing"); process.exit(0); }
// The one `bounded.evaluate` here resolves the whole radio group, so a renderer that stops answering would
// otherwise block this tool forever - and its caller reads that as a process with no output and no exit.
const bounded = boundedPage(page, "set_radio", Number(process.env.ATS_FORM_TIMEOUT_MS || DEFAULT_WAIT_MS));

const apply = async (spec, verifyOnly) =>
  await bounded.evaluate(
    ({ spec, verifyOnly }) => {
      const optionTextFor = (r) => {
        const byFor = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
        if (byFor && (byFor.innerText || "").trim()) return (byFor.innerText || "").replace(/\s+/g, " ").trim();
        const wrapLab = r.closest("label");
        if (wrapLab && wrapLab.querySelectorAll('input[type="radio"]').length === 1) return (wrapLab.innerText || "").replace(/\s+/g, " ").trim();
        return (r.getAttribute("aria-label") || r.value || "").replace(/\s+/g, " ").trim();
      };
      const results = [];
      for (const [groupRe, wanted] of spec) {
        const gre = new RegExp(groupRe, "i");
        let handled = false;
        // Candidate groups: the standard wrappers, PLUS radios grouped by their shared `name` attribute. Lever puts
        // bare radios sharing a name in a list item with no fieldset or data-field-path, so the standard scan alone
        // reported every Lever radio as "group not found" (2026-10-05).
        const candidates = [...document.querySelectorAll("[data-field-path], fieldset")];
        const byName = new Map();
        for (const r of document.querySelectorAll('input[type="radio"]')) {
          if (!r.name) continue;
          if (!byName.has(r.name)) byName.set(r.name, []);
          byName.get(r.name).push(r);
        }
        for (const [nm, rs] of byName) {
          if (rs.length < 2) continue;
          const covered = candidates.some((c) => {
            try { return c.querySelector(`input[type="radio"][name="${CSS.escape(nm)}"]`); } catch { return false; }
          });
          if (covered) continue;
          let host = rs[0].closest("li, .application-question, .application-field, .posting-question, div");
          for (let i = 0; i < 6 && host; i += 1) {
            if ((host.innerText || "").trim().length > 15) break;
            host = host.parentElement;
          }
          if (!host) continue;
          host.__nameGroup = nm;
          candidates.push(host);
        }
        for (const wrap of candidates) {
          let radios = [...wrap.querySelectorAll('input[type="radio"]')];
          if (wrap.__nameGroup) radios = radios.filter((r) => r.name === wrap.__nameGroup);
          if (radios.length < 2) continue;
          const groupLabel = (wrap.innerText || "").replace(/\s+/g, " ").trim();
          if (!gre.test(groupLabel)) continue;
          const options = radios.map((r) => ({ r, text: optionTextFor(r) }));
          const hit = options.find((o) => o.text.toLowerCase() === wanted.toLowerCase())
            || options.find((o) => o.text.toLowerCase().startsWith(wanted.toLowerCase()))
            || options.find((o) => o.text.toLowerCase().includes(wanted.toLowerCase()));
          if (!hit) {
            results.push({ group: groupLabel.slice(0, 44), ok: false, why: "option not found", options: options.map((o) => o.text.slice(0, 44)) });
            handled = true;
            break;
          }
          if (!verifyOnly) {
            hit.r.scrollIntoView({ block: "nearest" });
            // ALWAYS press, even when the DOM already shows this option checked. A desynced radio (property set, React
            // state empty) is exactly the case this tool exists for, and skipping the click there makes the desync
            // permanent: the tool would report OK, the verifier would agree with the DOM, and the server would keep
            // rejecting the submission. When the option already looks checked, press a DIFFERENT option first so two
            // real change events reach the framework and the final state is the wanted one.
            if (hit.r.checked) {
              const other = options.find((o) => o.r !== hit.r);
              if (other) {
                other.r.click();
                if (!other.r.checked) {
                  const olab = other.r.id ? document.querySelector(`label[for="${CSS.escape(other.r.id)}"]`) : null;
                  if (olab) olab.click();
                }
              }
            }
            hit.r.click();
            if (!hit.r.checked) {
              const lab = hit.r.id ? document.querySelector(`label[for="${CSS.escape(hit.r.id)}"]`) : null;
              if (lab) lab.click();
            }
          }
          const chosen = options.find((o) => o.r.checked);
          results.push({
            group: groupLabel.slice(0, 44),
            requested: wanted.slice(0, 40),
            ok: Boolean(chosen && chosen.text.toLowerCase().includes(wanted.toLowerCase().slice(0, 16))),
            chosen: chosen ? chosen.text.slice(0, 56) : null,
          });
          handled = true;
          break;
        }
        if (!handled) results.push({ group: groupRe, ok: false, why: "group not found" });
      }
      return results;
    },
    { spec, verifyOnly },
  );

console.log("SET:");
for (const r of await apply(spec, false)) {
  console.log(`  ${r.ok ? "OK  " : "FAIL"} | ${r.group} -> ${JSON.stringify(r.chosen)}${r.why ? "  (" + r.why + ")" : ""}`);
  if (r.options) console.log(`        options: ${JSON.stringify(r.options)}`);
}
await page.waitForTimeout(1200);
console.log("VERIFY:");
for (const r of await apply(spec, true)) {
  console.log(`  ${r.ok ? "OK  " : "FAIL"} | ${r.group} -> ${JSON.stringify(r.chosen)}`);
}
process.exit(0);
