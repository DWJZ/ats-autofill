/**
 * answer_pair_by_question.mjs — answer ONE Ashby-style yes/no pair by its question text and its exact option text.
 *
 * WHY THIS EXISTS. On OnePay the bulk filler logged "found and clicked Yes" for the work-authorisation and sponsorship
 * pairs while the committed state stayed "no", and the pre-submit gate refused the form twice. The bug was the chooser:
 * inside a container matched by the question text it took the LAST element whose text equalled the option, which was
 * often not the control. The correct pattern, learned by inspecting the DOM, is:
 *
 *   1. The question's NARROWEST container is the LAST matching scope, not the first - the first is an ancestor that
 *      holds the whole form.
 *   2. Inside it, the control is the BUTTON (or label/input) whose OWN inner text is exactly the option - never an
 *      element that merely CONTAINS the option among other text.
 *   3. Ashby mirrors each button pair in a HIDDEN input[type=checkbox], and THAT is what the gate reads. A press is
 *      only real when both agree: aria-pressed="true" on the button and checked:true on the hidden checkbox.
 *
 * So this script presses and then READS BACK BOTH, and exits non-zero when they disagree. It is the pair-driving
 * companion to click_group_option.mjs (which handles multi-option groups).
 *
 * Usage:
 *   node src/forms/answer_pair_by_question.mjs --tab jobs.ashbyhq.com/oneapp \
 *     --question "authorized to work lawfully" --option Yes --cdp http://127.0.0.1:9223
 */
import { chromium } from "playwright-core";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tab = arg("tab");
const question = arg("question");
const option = arg("option");
const cdp = arg("cdp", "http://127.0.0.1:9223");
if (!tab || !question || !option) {
  console.error("usage: --tab <substring> --question <regex> --option <exact text> [--cdp url]");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdp);
const pages = browser.contexts()[0].pages().filter((x) => (x.url() || "").includes(tab));
if (!pages.length) { console.error(`no tab matching ${tab}`); process.exit(3); }
const page = pages[0];

const click = await page.evaluate(({ q, o }) => {
  const rx = new RegExp(q, "i");
  // Narrowest scope last: the first match is usually the whole form.
  const scopes = [...document.querySelectorAll("div,fieldset,section")].filter((el) => {
    const t = (el.innerText || "").replace(/\s+/g, " ");
    return rx.test(t) && t.length < 600;
  });
  const scope = scopes[scopes.length - 1];
  if (!scope) return { ok: false, why: "no scope matched the question" };
  // The control must carry the option as its OWN text.
  let target = null;
  for (const btn of scope.querySelectorAll("button")) if ((btn.innerText || "").trim() === o) { target = btn; break; }
  if (!target) {
    for (const r of scope.querySelectorAll("input[type=radio],input[type=checkbox]")) {
      const lab = r.labels && r.labels[0] ? (r.labels[0].innerText || "").trim() : "";
      const own = (r.parentElement && r.parentElement.innerText || "").trim();
      if (lab === o || own === o) { target = r; break; }
    }
  }
  if (!target) return { ok: false, why: `no control whose own text is exactly "${o}" in the question's scope` };
  target.click();
  return { ok: true, tag: target.tagName, type: target.type || "" };
}, { q: question, o: option });

if (!click.ok) { console.error(`FAIL: ${click.why}`); process.exit(4); }
await page.waitForTimeout(800);

// READ BACK BOTH signals. The hidden checkbox is what the gate reads; aria-pressed is what the UI shows.
const after = await page.evaluate(({ q, o }) => {
  const rx = new RegExp(q, "i");
  const scopes = [...document.querySelectorAll("div,fieldset,section")].filter((el) => {
    const t = (el.innerText || "").replace(/\s+/g, " ");
    return rx.test(t) && t.length < 600;
  });
  const scope = scopes[scopes.length - 1];
  if (!scope) return { ok: false, why: "scope vanished" };
  let pressed = null, hidden = null;
  for (const btn of scope.querySelectorAll("button")) {
    const state = btn.getAttribute("aria-pressed") ?? btn.getAttribute("aria-checked");
    if (state === null) continue;
    if (!(btn.innerText || "").trim()) continue;
    const own = (btn.innerText || "").trim();
    if (own === o) pressed = state;
    if (own !== o && pressed === null) hidden = hidden; // other options are reported by the caller if needed
  }
  for (const cb of scope.querySelectorAll('input[type=checkbox]')) hidden = cb.checked;
  return { ok: true, pressed, hidden };
}, { q: question, o: option });

const good = after.ok && after.pressed === "true" && after.hidden === true;
console.log(JSON.stringify({ question, option, clicked: click.tag, ariaPressed: after.pressed, hiddenCheckbox: after.hidden, verdict: good ? "VERIFIED" : "*** NOT COMMITTED ***" }));
process.exit(good ? 0 : 5);
