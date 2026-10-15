/**
 * test_field_state.mjs — the audit must not call a placeholder an answer.
 *
 * The bug this pins, seen live on the Twitch form on 2026-10-10:
 *
 *     ok   opt race   text   Please identify your race   = Select...
 *
 * The audit's emptiness test knew only an empty string and `[unchecked]`, and it was handed the react-select
 * placeholder `Select...` - so a required, visibly-empty field counted as answered and the report was clean. That
 * direction of wrong is the expensive one: it says "done" for a field the employer will refuse the submission over.
 *
 * The cases are split in two, because the risk runs BOTH ways: a placeholder must not read as an answer, and a real
 * answer must not read as a placeholder. A check that only did the first would flag every correctly-set control, and
 * one that only did the second is the bug itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isEmptyDisplayed, isBlankRow } from "./field_state.mjs";

test("the placeholder a react-select shows when nothing is chosen is NOT an answer", () => {
  for (const placeholder of [
    "Select...",          // the exact string the Twitch race field showed while reported ok
    "Select",
    "Select an option",
    "Please select",
    "Choose...",
    "Choose an option",
    "None selected",
    "--",
    "—",
    "N/A",
  ]) {
    assert.ok(isEmptyDisplayed(placeholder), `should count as empty: ${JSON.stringify(placeholder)}`);
  }
});

test("Select… with a single-character ellipsis is the same placeholder", () => {
  // A tenant may ship U+2026 instead of three dots; the audit must not depend on which.
  assert.ok(isEmptyDisplayed("Select\u2026"));
  assert.ok(isEmptyDisplayed("  select\u2026  "));
});

test("nothing at all, and an unticked box, are still empty", () => {
  assert.ok(isEmptyDisplayed(""));
  assert.ok(isEmptyDisplayed("   "));
  assert.ok(isEmptyDisplayed(null));
  assert.ok(isEmptyDisplayed(undefined));
  assert.ok(isEmptyDisplayed("[unchecked]"));
});

test("a REAL answer is never mistaken for a placeholder", () => {
  // The other direction, and the reason the placeholder list is short and literal. Every value here is one this
  // project has actually put into a field.
  for (const real of [
    "East Asian",             // the standing answer for the race field this bug was found on
    "No",
    "Yes",
    "I am not a protected veteran",
    "Springfield, Illinois, United States",
    "Lakeside State University - Fairview",
    "China",
    "5+ years",
    "Male",
    "Heterosexual",
    "United States +1",
    "[checked]",
    "September",
  ]) {
    assert.ok(!isEmptyDisplayed(real), `should NOT count as empty: ${JSON.stringify(real)}`);
  }
});

test("a value that merely STARTS with a placeholder word is a real answer", () => {
  // "None of the above" is an option text, not a placeholder - a substring test would have swallowed it.
  assert.ok(!isEmptyDisplayed("None of the above"));
  assert.ok(!isEmptyDisplayed("Selects and drives"));
});

test("isBlankRow reads the row shape the audit builds", () => {
  assert.ok(isBlankRow({ displayed: "Select..." }));
  assert.ok(!isBlankRow({ displayed: "East Asian" }));
  assert.ok(isBlankRow(null));
});
