/**
 * fill_failures.mjs — what the filler's FAIL lines say, in one place.
 *
 * WHY THIS EXISTS. `refill_until_stable.mjs` read the filler's log with one inline regex,
 *
 *     /FAIL\s+\S+\s+(\S+)\s+option not found:\s*(.+)/
 *
 * which matched exactly ONE of the sentences the filler can write. The drafter and the filler have since grown a
 * second, deliberate refusal - a PLACE TYPEAHEAD that will not commit when the list offers only NAMESAKES (Luma AI,
 * 2026-10-01: the bare city query committed `Springfield, Newfoundland and Labrador` and the picker called it
 * COMMITTED; greenhouse board 8279799, 2026-10-14: `Toronto` offered `Toronto, Ohio, United States`). That refusal
 * is the CORRECT outcome - a wrong city committed silently is worse than an honest FAIL - and it says why, and how
 * many rows it was offered, in its own sentence:
 *
 *     FAIL select  id:candidate-location         typeahead did not commit a place naming newfoundland and
 *                                                labrador. Tried "Toronto": 3 row(s), none naming ... . The list
 *                                                offered: Toronto, Ontario, Canada | Toronto, Ohio, United States
 *
 * Not one of those words matched the inline regex, so the loop - whose whole job is to report what a fill could not
 * do - said nothing at all about a field it had failed to fill in every round. A refusal that repeats until the loop
 * gives up is exactly the outcome a person has to be told about, and it was the one outcome the parser could not see.
 *
 * WHY IT IS A MODULE AND NOT A WIDER REGEX. A lesson in this repository becomes a test (hard rule 1 of AGENTS.md),
 * and an inline parser cannot be tested without a home: this one now has one, and
 * `src/forms/test_fill_failures.mjs` asserts BOTH sentences - the old one and the new one - against logs written
 * the way the filler writes them. Extending the regex in place would have been the same defect one round later: a
 * rule that is believed rather than executed.
 *
 * AND IT CLASSIFIES RATHER THAN ONLY MATCHING. The loop needs two different things out of these lines, and they are
 * not the same thing: an option the control never offered can be retried with `answer_structured_option.mjs` (which
 * derives a filter from the value and verifies by equality), while a typeahead refusal cannot be repaired by any
 * tool - the list was asked, and it does not contain the place. Inlining them under one match would have handed the
 * retry tool a place name for a value.
 */

/** `  FAIL <kind> <ref, padded to 34 columns> <message>` — see apply_form_spec.mjs's log printer. */
const FAIL_LINE = /^\s*FAIL\s+(\S+)\s+(.*)$/;

/** The column `apply_form_spec.mjs` pads the ref to (`l.ref.padEnd(34)`) before writing one space and the message. */
const REF_COLUMNS = 34;

/** The option the control never offered: `<the option text>`, and it can be retried with a value. */
const OPTION_NOT_FOUND = /^option not found:\s*(.+)$/;

/** The deliberate typeahead refusal. It names what it was aiming at and what the list DID offer, not a value. */
const TYPEAHEAD_REFUSED = /^typeahead did not commit a place naming /;

/**
 * Where the ref field ends and the filler's message begins.
 *
 * A ref may itself contain spaces (`role:Country`, `label:Location (City)`, `group:Education 2`), so the boundary
 * is the REF COLUMN rather than the first space: `ref.padEnd(34)` followed by one space leaves a run of two or
 * more spaces after any ref of 33 columns or fewer, and that run is the split. A ref that fills the column or runs
 * past it has no such run - the padding is nothing - so the split falls back to the first single space, which is the
 * reading the inline regex made before this module existed: nothing that worked then is worse off now, and the whole
 * line is reported either way. A ref that is both long AND double-spaced inside is the one shape this cannot tell
 * apart, and it is why `line` is carried.
 */
function splitRefField(rest) {
  const run = /\s{2,}/.exec(rest);
  if (run && run.index < REF_COLUMNS) return { ref: rest.slice(0, run.index), message: rest.slice(run.index).trimStart() };
  const space = rest.indexOf(" ");
  if (space === -1) return { ref: rest, message: "" };
  return { ref: rest.slice(0, space), message: rest.slice(space + 1) };
}

/**
 * One FAIL line, as a record: `{ref, kind, reason, value, message, line}`.
 *
 * `ref` is BARE - a leading `id:` is stripped - because that is the key this loop looks controls up by
 * (`byRef` is built the same way), and a parser that returned the printed form would hand every caller the same
 * one-line transformation to get wrong.
 *
 * `value` is the option text ONLY where the sentence carries one; it is "" otherwise, and a caller must not invent
 * one. `message` and `line` are the filler's own words, kept verbatim so that a reader - or a grep - can check the
 * classification rather than trust it.
 */
function record(line) {
  const m = FAIL_LINE.exec(line);
  if (!m) return null;
  const kind = m[1];
  const { ref, message } = splitRefField(m[2]);
  const bare = ref.replace(/^id:/, "");
  const found = OPTION_NOT_FOUND.exec(message);
  if (found) return { ref: bare, kind, reason: "option_not_found", value: found[1].trim(), message, line };
  if (TYPEAHEAD_REFUSED.test(message)) return { ref: bare, kind, reason: "typeahead_refused", value: "", message, line };
  return { ref: bare, kind, reason: "other", value: "", message, line };
}

/**
 * Every failure the filler reported, in the order it reported them.
 *
 * @param {string} stdout - the filler's own stdout (`apply_form_spec.mjs`), as the loop captured it.
 * @returns {Array<{ref: string, kind: string, reason: string, value: string, message: string, line: string}>}
 */
export function parseFillFailures(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    const row = record(line);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The report lines for every failure NOTHING DOWNSTREAM WILL RETRY.
 *
 * `handled` is the set of refs a later step drives a tool for (the loop's remote-list section); a failure outside it
 * is one the reader has to act on. The loop's conclusion - "stable", i.e. no NEW controls - is not a statement about
 * the form, and this is what stops it being read as one: a field refused in every round used to end a run in
 * silence.
 *
 * THE RENDERING LIVES HERE SO THAT IT CAN BE TESTED. The shape it was written for - a place picker refusing every
 * namesake - cannot be produced by the fixture corpus; on the fixtures every failure is an option a tool retries, so
 * a renderer left inside the loop would never be executed by anything until the live form that needed it. A report
 * that has never run is a report that is believed.
 *
 * `round` is added by the caller (`refill_until_stable.mjs` records the last round that refused the field); a record
 * without one prints `?` rather than `undefined`.
 *
 * @param {Iterable<object>} failures - records from `parseFillFailures`, each with the loop's `round`.
 * @param {Set<string>} handled - bare refs a tool is being driven for.
 * @returns {string[]} lines to print, or an empty array when there is nothing to say.
 */
export function refusalReportLines(failures, handled = new Set()) {
  const refused = [...(failures || [])].filter(f => f && !handled.has(f.ref));
  if (!refused.length) return [];
  return [
    `\n--- ${refused.length} field(s) the fill asked for and did NOT get; no tool here repairs these ---`,
    // THE WHOLE SENTENCE, NOT A PREFIX. Its last clause is `The list offered: …` - the rows that make the refusal
    // correct rather than lazy - and a prefix would cut exactly the part a reader has to check. The filler prints
    // the same sentence in full.
    ...refused.flatMap(r => [
      `  ${r.ref}  (${r.kind}, refused in round ${r.round ?? "?"})  ${r.reason}`,
      `     ${r.message || ""}`,
    ]),
    "  Each one is a field the form still wants. Nothing was guessed.",
  ];
}
