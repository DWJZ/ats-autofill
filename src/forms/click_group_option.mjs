/**
 * click_group_option.mjs — the settled way to answer ONE option of a radio or checkbox group on an ATS form.
 *
 * WHY THIS TOOL EXISTS. The spec generator deliberately refuses radio and checkbox controls, because on Ashby every
 * OPTION is rendered as its own `input` whose "question" is the option label - so a question matcher will happily write
 * an answer into a group that never asked (it did: a LinkedIn URL landed in a "How did you hear about us?" group). That
 * refusal is correct, but it left groups unanswerable by tooling. This is the missing half: one option, chosen by the
 * group's QUESTION and the option's EXACT visible text, clicked with a real mouse.
 *
 * IT FINDS THE OPTION BY TEXT, NOT BY INDEX OR ID. Option ids and order drift between renders; the visible label is
 * what a human would click, and matching it is what "never transcribe a shortened identifier" means in practice.
 *
 * USAGE
 *   node src/forms/click_group_option.mjs --tab "<url fragment>" --question "how did you hear" \
 *     --option "Company Website" [--index N] [--cdp http://127.0.0.1:9223]
 *
 *   --index N  chooses the Nth matching group when several share a question fragment (rare; reported when it happens).
 *
 * EXIT: 0 when the option is checked afterwards; 3 when it is not (and says why).
 */
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const get = (f, d = "") => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const cdp = get("--cdp", "http://127.0.0.1:9223");
const tab = get("--tab");
const question = get("--question");
const option = get("--option");
const index = Number(get("--index", "0"));
if (!tab || !question || !option) {
  console.error('usage: click_group_option.mjs --tab <frag> --question "<fragment>" --option "<exact text>" [--index N]');
  process.exit(2);
}

const b = await chromium.connectOverCDP(cdp);
const p = b.contexts()[0].pages().find((x) => (x.url() || "").includes(tab));
if (!p) { console.log(`no tab matching ${tab}`); process.exit(2); }

// Find every option whose visible label matches exactly, grouped by the ancestor that carries the question text.
const found = await p.evaluate(([q, o]) => {
  // THE OPTION'S OWN TEXT, in the two ways a form renders one.
  //
  // (a) A real label association - `label[for]` or a wrapping, which is what `e.labels` gives.
  // (b) NO label at all. Ashby's radio groups nest the option text in plain divs/spans with nothing binding them
  //     to the input, which is the whole reason `click_radio_plan.mjs` pressed them by id instead. Measured
  //     2026-10-07 against src/forms/fixtures/ats_widgets.html: this function returned `matches: 0` for such a
  //     group while the id route found it, so the two tools were not interchangeable and the merge the audit
  //     proposed would have broken the live path (verify_and_submit -> click_radio_plan).
  //
  // The text IS in the DOM either way. For (b), take it from the TIGHTEST ancestor that holds this control and
  // no other one: a wrapper around a single option can only contain that option's text. Requiring
  // `inputs === 1` is what stops the walk at the option and keeps it from climbing into the group, whose text is
  // every option at once. This is the same shape of rule read_form_map.mjs uses to find the question.
  const labelOf = (e) => {
    const bound = e.labels && e.labels[0] ? (e.labels[0].innerText || "").trim() : "";
    if (bound) return bound;
    let w = e;
    for (let k = 0; k < 6 && w; k++) {
      w = w.parentElement;
      if (!w) break;
      const inside = w.querySelectorAll("input[type=radio], input[type=checkbox]").length;
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (inside === 1 && t) return t;
    }
    return "";
  };
  const opts = [];
  for (const e of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
    const lab = labelOf(e);
    if (lab !== o) continue;
    // Walk up looking for the question: the first ancestor whose text is long enough and mentions the fragment.
    let w = e, qtext = "", depth = 0;
    for (let k = 0; k < 12 && w; k++) {
      const t = (w.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 12 && new RegExp(q, "i").test(t)) { qtext = t.slice(0, 110); depth = k; break; }
      w = w.parentElement;
    }
    if (!qtext) continue;
    opts.push({ id: e.id || "", name: e.name || "", type: e.type, label: lab, qtext, depth });
  }
  return opts;
}, [question, option]);

console.log(`matches for option ${JSON.stringify(option)} under a question matching ${JSON.stringify(question)}: ${found.length}`);
for (const f of found) console.log(`   [${f.type}] ${f.id} | ${f.qtext}`);

if (!found.length) {
  console.log("NOT FOUND - the option text or the question fragment does not match this page. Nothing was clicked.");
  process.exit(3);
}
const target = found[Math.min(index, found.length - 1)];
if (found.length > 1) console.log(`choosing match #${Math.min(index, found.length - 1)}`);

const box = target.id ? p.locator(`[id="${target.id}"]`).first() : null;
if (!box || !(await box.count())) { console.log("the chosen option has no addressable id - cannot click it"); process.exit(3); }
await box.scrollIntoViewIfNeeded().catch(() => {});
const lab = p.locator(`label[for="${target.id}"]`).first();
if (await lab.count()) await lab.click({ timeout: 12000 }).catch(() => {});
await p.waitForTimeout(400);
let checked = await box.isChecked().catch(() => false);
if (!checked) { await box.click({ timeout: 8000, force: true }).catch(() => {}); await p.waitForTimeout(400); checked = await box.isChecked().catch(() => false); }
console.log(`checked after click: ${checked}`);
process.exit(checked ? 0 : 3);
