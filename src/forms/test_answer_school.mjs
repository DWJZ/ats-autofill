/**
 * test_answer_school.mjs — the two decisions that can be wrong in silence, without a browser.
 *
 * `answer_school.mjs` drives a real control over CDP, so it cannot be unit-tested. Its two inputs can, and they are
 * the ones with history:
 *
 *   - THE SHORT QUERY. `Lakeside State University, Full` returned an EMPTY option list on Stripe while `Fairview`
 *     returned the row after ~2 seconds (driving-widgets.md item 2). A query that is too long is not a slow picker,
 *     it is no picker.
 *
 *   - THE PATTERN MUST NOT MATCH A DIFFERENT SCHOOL. This is the whole reason the pattern is not `/fairview/`:
 *     "Fairview College" is a real institution, and answering it for a LSU application is a FALSE CREDENTIAL. The
 *     project has already paid for that once - a loose read-back called "Fairview College" a success for
 *     "Lakeside State University - Fairview" on a school picker and reported it OK.
 *
 * Both are pins on decisions, not on a page: if someone "simplifies" either one, these fail here rather than in an
 * application that has already been submitted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nameTolerantRegex, shortQuery } from "./school_query.mjs";

test("the query is the part after the last comma - the short word a remote list filters on", () => {
  assert.equal(shortQuery("Lakeside State University, Fairview"), "Fairview");
  // The other degree in canonical data has no comma, so the whole name is the query - wrong for a list, but it is
  // the honest input, and answer_school.mjs lets --query override it rather than inventing a fragment.
  assert.equal(shortQuery("Metropolitan Institute of Technology"), "Metropolitan Institute of Technology");
  assert.equal(shortQuery(""), "");
});

test("the pattern matches the SAME name however the list spells the separator", () => {
  const re = new RegExp(nameTolerantRegex("Lakeside State University, Fairview"));
  // The profile's spelling, and the three the lists actually use - the hyphen is the one that cost the rounds.
  for (const spelling of [
    "Lakeside State University, Fairview",
    "Lakeside State University - Fairview",
    "Lakeside State University -Fairview",
    "Lakeside State University – Fairview",
  ]) {
    assert.ok(re.test(spelling), `should match ${JSON.stringify(spelling)}`);
  }
});

test("the pattern does NOT match a different school that shares the word", () => {
  // THE POINT OF THE WHOLE FILE. A loose /fairview/ answers Fairview College for a LSU application.
  const re = new RegExp(nameTolerantRegex("Lakeside State University, Fairview"));
  for (const other of [
    "Fairview College",
    "Lakeside State University - Bayside",
    "Lakeside State University, Hillcrest",
    "Lakeside State University - Fairview Extension",
    "University of Lakeside, Fairview",
  ]) {
    assert.ok(!re.test(other), `must NOT match ${JSON.stringify(other)}`);
  }
});

test("the pattern escapes regex metacharacters in a school name", () => {
  // "(Cal Poly)" and "A&M" are real namings; an unescaped name would change the pattern's meaning.
  const re = new RegExp(nameTolerantRegex("California Polytechnic State University (Cal Poly), San Luis Obispo"));
  assert.ok(re.test("California Polytechnic State University (Cal Poly) - San Luis Obispo"));
  // A dot must stay a literal dot rather than matching any character.
  assert.ok(!new RegExp(nameTolerantRegex("St. Mary's College")).test("StX Mary's College"));
});

test("an empty school produces no pattern rather than a pattern that matches anything", () => {
  // "" must never become // or /^$/-with-nothing, either of which a caller could press.
  assert.equal(nameTolerantRegex(""), "");
  assert.equal(shortQuery("   "), "");
});
