/**
 * test_structured_query.mjs — the query a long-list control needs, pinned without a browser.
 *
 * The two failure modes this file exists for are both silent, which is why the decisions live in a pure module:
 *
 *   - A QUERY THAT DOES NOT FILTER. Typing the whole value, or the country, opens the control onto a list that still
 *     does not contain the row - and on a remote list that means an EMPTY panel, which reads the same as "no such
 *     option". The school picker's own history has this: the Fairview query filtered the list down to one row, and
 *     the `Other` fallback that lived outside that row could not be found at all.
 *   - A QUERY THAT FILTERS TOO LITTLE, which on a 197-option country list is the same as not filtering.
 *
 * The values below are the real ones: the two canonical strings this project actually puts into these fields.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { firstSegment, queryCandidates, segmentCount } from "./structured_query.mjs";

test("an address filters on the city, which is the FIRST segment", () => {
  // application_profile.json -> candidate.address, in the form the option text takes.
  assert.equal(firstSegment("Springfield, Illinois, United States"), "Springfield");
  assert.equal(queryCandidates("Springfield, Illinois, United States")[0], "Springfield");
});

test("a school name filters on the part after the LAST comma", () => {
  // Lakeside State University, Fairview - the class of value that made this project build a school tool.
  const candidates = queryCandidates("Lakeside State University, Fairview");
  assert.ok(candidates.includes("Fairview"), `expected Fairview among ${JSON.stringify(candidates)}`);
  // And the first segment is still offered, because a wrong candidate costs one attempt rather than a wrong answer.
  assert.equal(candidates[0], "Lakeside State University");
});

test("the whole value is the last resort, and duplicates never appear", () => {
  assert.deepEqual(queryCandidates("Engineering"), ["Engineering"], "a single-segment value is its own query");
  assert.deepEqual(queryCandidates("Springfield, Illinois"), ["Springfield", "Illinois", "Springfield, Illinois"]);
});

test("an empty value yields NO candidates rather than one empty query", () => {
  // A query of "" opens the control with no filter - the exact state that fails on a remote list - so it must never be
  // handed to the driver as if it were a query.
  assert.deepEqual(queryCandidates(""), []);
  assert.deepEqual(queryCandidates("   "), []);
  assert.deepEqual(queryCandidates(null), []);
  assert.deepEqual(queryCandidates(undefined), []);
});

test("segments are counted on the trimmed parts, not the raw commas", () => {
  assert.equal(segmentCount("Springfield, Illinois, United States"), 3);
  assert.equal(segmentCount("Engineering"), 1);
  assert.equal(segmentCount("a, , b"), 2, "an empty segment is not a segment");
});
