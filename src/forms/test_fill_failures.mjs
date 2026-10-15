/**
 * test_fill_failures.mjs — the loop must SEE a refusal, not only the one sentence it used to match.
 *
 * The bug this pins. `refill_until_stable.mjs` read the filler's log with a single inline regex that matched
 * `option not found:` and nothing else, so the refusal below - a place typeahead that will not commit when the
 * list offers only NAMESAKES - was invisible to the one tool whose job is to report what a fill could not do:
 *
 *     FAIL select  id:candidate-location  typeahead did not commit a place naming newfoundland and labrador …
 *
 * A field refused in every round, with the loop then reporting that it had reached a stable point, is the reading
 * that costs an application: the loop said "nothing left to do" about a required field it never filled. The
 * sentence is CORRECT and deliberate - the alternative is committing `Toronto, Ohio, United States` for a candidate
 * in Ontario (Luma AI, 2026-10-01: the bare city query committed `Springfield, Newfoundland and Labrador` and the
 * picker called it COMMITTED; greenhouse board 8279799 `Technical Support Specialist`, 2026-10-14) - so it is not
 * the refusal that changes here, only whether the loop can read it.
 *
 * BOTH SENTENCES ARE ASSERTED, because the old one is the one the loop depends on for its retry path
 * (`answer_structured_option.mjs` is driven with the option text) and the new one carries no option text at all: a
 * parser that matched the new sentence by loosening the old pattern would hand that tool a place description for a
 * value. The lines below are written by the same format the filler prints (`  FAIL <kind, 7> <ref, 34> <message>`),
 * so a change to the printer's columns fails here rather than silently mis-splitting every ref.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseFillFailures, refusalReportLines } from "./fill_failures.mjs";

/** One line exactly as `apply_form_spec.mjs` prints it (see its log printer). */
const failLine = (kind, ref, message) => `  FAIL ${kind.padEnd(7)} ${ref.padEnd(34)} ${message}`;

/** The refusal as it came out of a real run on 2026-10-14, one line, trimmed of nothing (see the file header). */
const TYPEAHEAD_MESSAGE =
  "typeahead did not commit a place naming newfoundland and labrador | , nl | nowhere. " +
  'Tried "Toronto, Newfoundland and Labrador, Nowhere": 8 row(s), none naming newfoundland and labrador | , nl | nowhere; ' +
  '"Toronto, Newfoundland and Labrador": 8 row(s), none naming newfoundland and labrador | , nl | nowhere; ' +
  '"Toronto, NL": 8 row(s), none naming newfoundland and labrador | , nl | nowhere; ' +
  '"Toronto": 8 row(s), none naming newfoundland and labrador | , nl | nowhere. ' +
  "The list offered: Toronto, Ontario, Canada | Toronto, Ohio, United States | Toronto, Kansas, United States";

test("the sentence the retry path needs is still read as an option the control never offered", () => {
  // `step7_fill.log:10`, greenhouse board 8279799, 2026-10-14: `Location (City)*` is a react-select whose listbox
  // does not exist until a query is typed, so the drafter described it as an option list and the filler asked for an
  // option. This is the line the loop has always understood, and it is the one that carries a VALUE.
  const log = failLine("select", "id:candidate-location", "option not found: Toronto, Ontario, Canada");
  const rows = parseFillFailures(log);
  assert.equal(rows.length, 1, `one FAIL line, one record:\n${JSON.stringify(rows)}`);
  assert.equal(rows[0].ref, "candidate-location", "the id: prefix is stripped - that is the key the loop looks up by");
  assert.equal(rows[0].kind, "select");
  assert.equal(rows[0].reason, "option_not_found");
  assert.equal(rows[0].value, "Toronto, Ontario, Canada", "the option text the retry tool is driven with");
});

test("a typeahead refusal is seen, and it is NOT given a value", () => {
  const log = failLine("select", "id:candidate-location", TYPEAHEAD_MESSAGE);
  const rows = parseFillFailures(log);
  assert.equal(rows.length, 1, `the loop could not see this line at all before:\n${JSON.stringify(rows)}`);
  assert.equal(rows[0].reason, "typeahead_refused");
  assert.equal(rows[0].value, "",
    "the sentence names what it aimed at, not an option the control offered: handing this to the retry tool would " +
    "be a place description used as a value");
  assert.match(rows[0].message, /The list offered: Toronto, Ontario, Canada \| Toronto, Ohio, United States/,
    "the rows the list DID offer stay on the record - they are why the refusal is correct, and the next reader " +
    "must not have to re-derive them");
});

test("a whole log is read: the failures are picked out and everything else is left alone", () => {
  // The sections a real fill prints, in their order. Nothing here may be mistaken for a failure - the loop's report
  // is built from what this returns, and a false record sends a person to a field that was never asked for.
  const log = [
    "=== fill log ===",
    "  OK   text    id:_systemfield_name                Roundtrip Candidate",
    "  OK   text    id:_systemfield_email               candidate@example.com  [reformatted]",
    failLine("select", "id:candidate-location", TYPEAHEAD_MESSAGE),
    failLine("select", "id:country", "option not found: Canada +1"),
    "",
    "=== still blank ===", "3",
    "  REQ country                    Country",
    "  opt phone                      Phone",
    "",
    "=== controls the spec never mentioned (re-scan and re-draft) ===", "1",
    "  ?   cr_revealed                Please identify your race",
    "",
    "=== attached ===", "[]",
    "=== aria-invalid ===", "0",
  ].join("\n");
  const rows = parseFillFailures(log);
  assert.deepEqual(rows.map(r => [r.ref, r.reason]), [
    ["candidate-location", "typeahead_refused"],
    ["country", "option_not_found"],
  ], `only FAIL lines are failures:\n${JSON.stringify(rows, null, 2)}`);
});

test("a ref that contains a space is split at the ref column, not at its own space", () => {
  // `label:`, `role:` and `group:` refs are addressed by text, and the text has spaces in it. Splitting on the first
  // space - the reading the inline regex made - keeps the ref readable only when it has none.
  const rows = parseFillFailures(failLine("text", "label:Location (City)", "option not found: Toronto, Ontario, Canada"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "label:Location (City)", "the ref is one field up to the column the printer pads to");
  assert.equal(rows[0].value, "Toronto, Ontario, Canada");
});

test("a failure this module does not know is recorded rather than dropped", () => {
  // The loop's report is the only place a fill failure is written down; a parser that returns only the sentences it
  // recognises is the bug this file exists for, one round further on.
  const rows = parseFillFailures(failLine("radio", "id:eeoc_vet", "group not found"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "other");
  assert.equal(rows[0].ref, "eeoc_vet");
  assert.equal(rows[0].message, "group not found");
});

test("nothing at all is not a failure", () => {
  for (const empty of ["", "\n", "   ", "=== fill log ===\n  OK   text    id:x   y", "no FAIL here"]) {
    assert.deepEqual(parseFillFailures(empty), [], `should find nothing in ${JSON.stringify(empty)}`);
  }
});

test("a refusal nothing retries reaches the loop's report", () => {
  // THE READING THAT COSTS AN APPLICATION. The loop's conclusion is "stable" - no NEW controls - and a run used to
  // say exactly that about a field refused in every round, because its parser read one sentence and this was not it.
  // `round` is the loop's own addition: the last round that refused the field.
  const records = parseFillFailures(failLine("select", "id:candidate-location", TYPEAHEAD_MESSAGE))
    .map(r => ({ ...r, round: 2 }));
  const lines = refusalReportLines(records, new Set(["country"]));
  const text = lines.join("\n");
  assert.match(text, /1 field\(s\) the fill asked for and did NOT get/);
  assert.match(text, /candidate-location\s+\(select, refused in round 2\)\s+typeahead_refused/,
    `the field and the round it was refused in must be in the report:\n${text}`);
  assert.match(text, /The list offered: Toronto, Ontario, Canada/,
    `and the reason must travel with it, so the next reader can judge the refusal:\n${text}`);
});

test("a failure the loop IS driving a tool for is not reported twice", () => {
  // The other direction: the report is what is LEFT, not a second copy of the retry section. `country` is handled
  // (the loop drives `answer_structured_option.mjs` for it), so only the refusal is left over.
  const records = [
    ...parseFillFailures(failLine("select", "id:candidate-location", TYPEAHEAD_MESSAGE)).map(r => ({ ...r, round: 1 })),
    ...parseFillFailures(failLine("select", "id:country", "option not found: Canada +1")).map(r => ({ ...r, round: 1 })),
  ];
  const text = refusalReportLines(records, new Set(["country"])).join("\n");
  assert.match(text, /candidate-location/);
  assert.doesNotMatch(text, /^ {2}country {2}\(/m, `a handled field must not be listed as unrepaired:\n${text}`);
});

test("a run with nothing left over prints nothing extra", () => {
  // "An unconfigured run behaves as today": a clean loop's output must not grow a section that says nothing.
  assert.deepEqual(refusalReportLines([], new Set()), []);
  assert.deepEqual(refusalReportLines(undefined, new Set()), []);
  const handled = parseFillFailures(failLine("select", "id:country", "option not found: Canada +1"));
  assert.deepEqual(refusalReportLines(handled, new Set(["country"])), []);
});
