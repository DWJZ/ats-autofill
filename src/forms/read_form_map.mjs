/**
 * read_form_map.mjs — print every control on an open ATS form with its question text and committed value.
 *
 *
 * ABSORBED `ashby_question_map` (2026-10-07). That tool printed one line per QUESTION with its committed
 * value, which is the shape the pre-submit review wants (docs/RULES.md, rule 5), and it existed because
 * `inspect_ats_form.mjs` labels a radio/checkbox group by its OPTION text ("Man", "No") rather than by the
 * question ("Race and ethnicity") - so on Bubble the race group, the orientation combobox and the submission
 * agreement were all left untouched while the review sheet looked complete. Its only caller was the deleted
 * `fill_and_review`, and the naming rule below is the same fix, so the two are one tool now. Read the question
 * column here for that review; there is no separate review sheet to reach for.
 *
 * WHY THIS IS A SETTLED TOOL. Reading a form's question map was hand-rolled in nearly every round, and the
 * hand-rolled versions kept repeating two mistakes: (1) they filtered out `type=checkbox`, which made a required
 * CHECKBOX GROUP (OKX's "What language(s) are you fluent in?", forty options) invisible to three separate scans; and
 * (2) they walked up from the control and broke on the FIRST ancestor with text, which on Lever is the option list
 * itself ("Select... Yes No"), so the question never appeared. Both are fixed here: no control type is excluded,
 * and the question text is read from the tightest ancestor that does NOT consist only of the control's own options.
 * AND THREE WAYS A LABEL ITSELF MISLEADS, all seen on real forms (2026-10-03/05):
 *   - A READER THAT TRUNCATES THE LABEL MAKES EXACT MATCHING IMPOSSIBLE. The arbitration acknowledgement on one
 *     form could not be ticked by exact label text because the reader cut the label at 52 characters and the real
 *     text is longer; the distinctive substring `arbitration` found it at once. Prefer a distinctive substring
 *     over the whole string whenever the label is long.
 *   - A REQUIRED FIELD CAN BE LABELLED WITH A BARE NUMBER. Prompt's refusal read `Missing entry for required
 *     field: 1` - the label renders as `1`, so nothing a reader looks for looks like a question. A refusal quoting
 *     a numeral is naming a control by POSITION, and the control still has to be found.
 *   - PHONE AND LOCATION ARE THE TWO ASHBY STANDARD FIELDS AN INVENTORY USUALLY MISSES. Confluent, RevenueCat
 *     and Horizon3 all had both required and neither visible to the first scan.
 *
 * On a Lever tenant the reliable source is `li.application-question > div.application-label > div.text`; this tool
 * falls back to that structure explicitly before the generic walk.
 *
 * Usage:
 *   node src/forms/read_form_map.mjs <url-substring> [--cdp http://127.0.0.1:9223]
 */
import { chromium } from "playwright-core";

const frag = process.argv[2];
if (!frag) {
  console.error("usage: read_form_map.mjs <url-substring> [--cdp http://127.0.0.1:9223]");
  process.exit(2);
}
const cdpIndex = process.argv.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? process.argv[cdpIndex + 1] : "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => (p.url() || "").includes(frag));
if (!page) {
  console.error(`no open tab whose URL contains ${JSON.stringify(frag)}`);
  process.exit(1);
}

const rows = await page.evaluate(() => {
  const ALL = "input,textarea,select";
  const out = [];
  for (const e of document.querySelectorAll(ALL)) {
    const type = (e.type || e.tagName).toLowerCase();
    if (["hidden", "submit", "button", "file"].includes(type)) continue;
    if (e.offsetParent === null) continue;

    // 1) the platform's own label association
    let q = "";
    if (e.labels && e.labels[0]) q = (e.labels[0].innerText || "").trim();

    // 1b) A SHORT LABEL ON A RADIO/CHECKBOX IS THE OPTION, NOT THE QUESTION (fixed 2026-10-07, Palantir/Lever).
    //     Lever renders each choice inside its own <label>, so `e.labels[0]` answers "Yes", "No" or "English (ENG)"
    //     and path 2 below never ran, because q was already non-empty. The map then showed four bare Yes/No rows with
    //     no question at all - the one thing a pre-submit review must never see: the options were visible but there
    //     was no way to tell which question each answer belonged to. When the label is too short to be a question,
    //     the enclosing card is consulted instead.
    if (/^(radio|checkbox)$/i.test(e.type || "")) {
      const card = e.closest(".application-question, li.application-question, [class*='application-question']")
        || e.closest("fieldset");
      if (card) {
        const node = card.querySelector(".application-label .text, legend, .application-label");
        const cardText = node ? (node.innerText || "").replace(/\s+/g, " ").trim() : "";
        if (cardText.length > q.length) q = cardText;
      }
    }

    // 2) Lever: the question lives in the application-question list item
    if (!q) {
      const li = e.closest("li.application-question");
      if (li) {
        const label = li.querySelector(".application-label .text");
        if (label) q = (label.innerText || "").trim();
      }
    }

    // 3) generic walk, but SKIP ancestors whose text is only this control's own options, AND skip any ancestor that
    //    aggregates OTHER controls. Hex's Ashby form exposed the second failure mode: several controls reported the
    //    same "question" - a long string reading "Name Email Resume Example_Candidate_Hex_..._Resume.pdf Replace or drag and
    //    drop here" - because the walk climbed into a container holding the whole form, and every rule that matched on
    //    question text then bound its answer to the wrong element (the LinkedIn URL landed in "How did you hear about
    //    Hex?"). A container that holds more than one visible control is not a question; it is the form.
    if (!q) {
      const ownOptions = [...e.options || []].map((o) => (o.textContent || "").trim()).filter(Boolean);
      const controlsInside = (node) => [...node.querySelectorAll("input,textarea,select")]
        .filter((x) => (x.type || "").toLowerCase() !== "hidden" && x.offsetParent !== null).length;
      let w = e;
      for (let k = 0; k < 8 && w; k++) {
        const t = (w.innerText || "").replace(/\s+/g, " ").trim();
        const onlyOptions = ownOptions.length > 0 && ownOptions.every((o) => t.includes(o)) &&
          t.replace(/Select\.\.\./g, "").length < ownOptions.join(" ").length + 24;
        const aggregates = k > 0 && controlsInside(w) > 1;   // k=0 is the control's own wrapper; deeper ones must not
        if (t.length > 12 && t.length < 400 && !onlyOptions && !aggregates) { q = t; break; }
        w = w.parentElement;
      }
    }

    const key = (e.name || e.id || "") + q.slice(0, 20);
    if (out.some((r) => r.key === key)) continue;

    let cur = (e.value || "").slice(0, 30);
    if (type === "checkbox" || type === "radio") cur = e.checked ? "CHECKED" : "";
    if (e.tagName === "SELECT") cur = (e.options[e.selectedIndex] || {}).textContent || "";
    if ((e.className || "").toString().includes("select__input")) {
      let w = e, c = null;
      for (let k = 0; k < 9 && w; k++) { if (w.classList && w.classList.contains("select__control")) { c = w; break; } w = w.parentElement; }
      // READ BOTH. A react-select that takes ONE value commits into [class*=select__single-value]; one that takes
      // MANY commits into [class*=select__multi-value__label] and leaves `single-value` empty. Reading only the
      // first reports every multi-select as unanswered: on Fellow's form three required EEO controls labelled "How
      // would you describe your ... (mark all that apply)" read back EMPTY twice in a row after their clicks had
      // landed, so the filler refilled correct answers while this audit kept inventing a problem. (2026-10-05)
      const sv = c ? c.querySelector("[class*=select__single-value]") : null;
      const mv = c ? [...c.querySelectorAll("[class*=select__multi-value__label]")].map((n) => n.textContent.trim()).filter(Boolean) : [];
      cur = mv.length ? mv.join(", ") : (sv ? sv.textContent.trim() : "");
    }

    out.push({
      key,
      // Print id and name SEPARATELY. The old single field was `e.name || e.id`, which showed an id under the name
      // column - and on DoorDash that led straight to `[name="candidate-location"]` against a control whose name
      // attribute is EMPTY. The locator matched nothing, the click fell through to the phone country selector, and
      // two rounds were spent concluding the tenant's location widget was broken. A reader must never blur the two.
      id: (e.id || "").slice(0, 44),
      name: (e.name || "").slice(0, 44),
      tag: e.tagName.toLowerCase(),
      type,
      req: !!(e.required || e.getAttribute("aria-required") === "true"),
      cur: String(cur).trim().slice(0, 30),
      // 74 characters cut the real Lever consent questions off mid-sentence ("As part of our interview process, we
      // may use AI notetakers to transcribe c..."), and a truncated question cannot be reviewed or answered. Raised
      // 2026-10-07 with the card-question fix above: the point of this column is that the reviewer reads it.
      q: q.replace(/\s+/g, " ").slice(0, 200) || "(no question text found)",
    });
  }
  return out;
});

console.log(`${rows.length} visible controls on ${page.url().slice(-60)}`);
for (const r of rows) {
  const mark = r.req ? "REQ" : "opt";
  console.log(`   ${mark} [${r.tag}/${r.type}] id=${JSON.stringify(r.id).padEnd(30)} name=${JSON.stringify(r.name).padEnd(26)} cur=${JSON.stringify(r.cur).padEnd(14)} :: ${r.q}`);
}
process.exit(0);
