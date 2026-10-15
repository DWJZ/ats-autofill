#!/usr/bin/env python3
"""Tests for the persisted answer rules (`data/form_specs/answer_rules.json`).

WHY THIS EXISTS. On one tenant's form `draft_form_spec.py` reported 12 questions as `no profile mapping`, and most
were not unmappable: the canonical profile holds the answers (citizenship, visa status, outside-employment history)
and the built-in table simply has no pattern for the wording that tenant uses. The answers were worked out by hand per
application and forgotten when that job's spec was done.

The rules now live in a data file. These tests pin the three ways that file can go wrong:

  1. a rule that does not fire on the wording it was written for (the whole point is that it fires),
  2. a rule that fires on something it should NOT - the persisted rules are tried BEFORE the built-in table, so a
     greedy pattern can take a question away from the canonical answer,
  3. a rule that changes the SAFETY guard's behaviour - the Asana short-field refusal must not be bypassable by data.

The wording used in the assertions is copied from the real Twitch form's `needs_review` list, not invented.
"""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

MODULE_PATH = pathlib.Path(__file__).with_name("draft_form_spec.py")
_spec = importlib.util.spec_from_file_location("draft_form_spec_rules", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)

RULES_FILE = DATA_DIR / "form_specs" / "answer_rules.json"
EXAMPLE_RULES_FILE = ROOT / "examples" / "answer_rules.example.json"


def rules_are_the_shipped_example(rules: list) -> bool:
    """Is the installed rule table the untouched example?

    `data/form_specs/answer_rules.json` carries rules written by hand for ONE person's recurring wordings -
    Twitch's and Amazon's, named in the notes below. `scripts/setup-examples.sh` installs a file with three
    invented rules instead, and that file is what a fresh checkout has.

    The check compares the RULES, not the file bytes (so reformatting is not mistaken for a real table), and it
    is deliberately not derived from whether the assertions below pass: a real table whose rules have stopped
    firing must still fail this test rather than skip it.
    """
    try:
        example = json.loads(EXAMPLE_RULES_FILE.read_text(encoding="utf-8")).get("rules")
    except (OSError, ValueError):
        return False
    return bool(example) and rules == example

# Label -> the answer the rule file must produce. Every label here was copied out of a real needs_review entry.
REAL_WORDINGS = {
    "Have you previously been employed by Amazon or any Amazon subsidiary? *": "No",
    "Are you a current employee with Amazon or any Amazon subsidiary (outside of Twitch)?*": "No",
    "Have you previously applied to Amazon or any Amazon subsidiary?*": "No",
    "Are you subject to a non-competition agreement or other agreement that would prevent you from working here?": "No",
    "If offered employment by Amazon, would you be legally eligible to begin employment?": "Yes",
    "Have you held H-1B status, or had an H-1B petition approved on your behalf?": "No",
    "Since obtaining your most recent citizenship, did you afterwards become a permanent resident?": "No",
}


def canonical_citizenship() -> str:
    """The expected answer to a citizenship question, read from the profile rather than written here.

    A hardcoded one is not merely stale in someone else's checkout - in a public repo it publishes a
    fact about the one person the tests were originally written against. The wording stays pinned
    below; the answer comes from the configuration the checkout actually has.
    """
    try:
        profile = json.loads(
            (DATA_DIR / "candidate_profile.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    candidate = profile.get("candidate") or {}
    answers = candidate.get("standard_answers") or {}
    return candidate.get("citizenship") or answers.get("citizenship") or ""


class AnswerRulesFileTest(unittest.TestCase):
    def test_the_file_exists_and_is_loadable(self):
        # A silently-empty rule file would make every test below pass by falling through to the built-in table.
        self.assertTrue(RULES_FILE.exists(), f"{RULES_FILE} is missing - the rules were never persisted")
        data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(data.get("version", 0), 1)
        self.assertTrue(data.get("rules"), "no rules in the file")

    def test_every_rule_carries_a_note_naming_its_source(self):
        # An entry that cites nothing cannot be told apart from a guess - and because it MATCHES, it will never appear
        # in needs_review again. That is the failure the contract's rule 11 is written against.
        for r in json.loads(RULES_FILE.read_text(encoding="utf-8"))["rules"]:
            self.assertTrue(r.get("note", "").strip(), f"rule {r.get('questionRe')!r} has no note")
            self.assertGreater(len(r["note"]), 30, f"rule {r.get('questionRe')!r} has a note that says nothing")

    def test_the_loaded_rules_are_the_ones_in_the_file(self):
        rules = drafter.load_answer_rules(RULES_FILE)
        self.assertEqual(len(rules), len(json.loads(RULES_FILE.read_text(encoding="utf-8"))["rules"]))

    def test_a_broken_pattern_does_not_take_the_other_rules_down(self):
        # One bad regex must not silently disable the whole file.
        blob = {"version": 1, "rules": [
            {"questionRe": "([unclosed", "answer": "X", "note": "broken on purpose"},
            {"questionRe": "do you like tests", "answer": "Yes", "note": "a note long enough to look deliberate"},
        ]}
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "r.json"
            p.write_text(json.dumps(blob), encoding="utf-8")
            rules = drafter.load_answer_rules(p)
        self.assertEqual(len(rules), 1, "the broken rule should be dropped and the good one kept")
        self.assertEqual(rules[0]["answer"], "Yes")

    def test_a_missing_file_is_not_fatal(self):
        self.assertEqual(drafter.load_answer_rules(pathlib.Path("/nonexistent/answer_rules.json")), [])


class PersistedRulesFireTest(unittest.TestCase):
    def test_each_real_wording_gets_its_persisted_answer(self):
        # EVERY WORDING BELOW WAS COPIED OUT OF A REAL `needs_review` LIST and the rules that answer them were
        # written for that one person's forms - the notes name Twitch and Amazon. A checkout with the example
        # rule file installed has a different, invented table, so there is nothing here for these wordings to
        # fire from; that case skips rather than reporting eight misses nobody configured. It still FAILS on a
        # real table, which is the state it exists to protect.
        rules = drafter.load_answer_rules(RULES_FILE)
        self.assertTrue(rules)
        if rules_are_the_shipped_example(rules):
            raise unittest.SkipTest(
                f"{RULES_FILE} is still the example rule file shipped by scripts/setup-examples.sh: the rules "
                "that answer the wordings below were written per tenant for this project's own forms and are "
                "not part of this checkout")
        # The citizenship wording is pinned too, but its expected answer comes from the profile: a literal
        # here would be one person's nationality sitting in a public test file.
        cases = dict(REAL_WORDINGS)
        citizenship = canonical_citizenship()
        if citizenship:
            cases["In which country/region do you have citizenship?*"] = citizenship
        for label, expected in cases.items():
            key, answer = drafter.pick_answer(label, {}, "select", rules)
            self.assertIsNotNone(key, f"no rule fired for {label!r} - it would go to needs_review again")
            self.assertTrue(str(key).startswith("@rule:"), f"{label!r} was answered by {key!r}, not a persisted rule")
            self.assertEqual(answer, expected, label)

    def test_the_key_says_which_rule_answered(self):
        # Provenance is the point: a spec must be able to show that an answer came from the rule file and which one.
        # The rule is supplied inline so the case states its own premise: the SUBJECT is the `<key>` `pick_answer`
        # returns for a persisted rule, and none of this depends on which rules the installed file happens to hold.
        rules = [{"questionRe": r"have you held h-?1-?b status", "answer": "No", "note": "inline fixture"}]
        key, _ = drafter.pick_answer("Have you held H-1B status?", {}, "select", rules)
        self.assertRegex(str(key), r"^@rule:\d+$")

    def test_a_rule_with_a_kind_only_fires_for_that_kind(self):
        rules = [{"questionRe": "favourite colour", "answer": "Blue", "kind": "select", "note": "test"}]
        self.assertIsNotNone(drafter.pick_answer("favourite colour", {}, "select", rules)[0])
        self.assertIsNone(drafter.pick_answer("favourite colour", {}, "text", rules)[0])

    def test_the_built_in_table_still_answers_what_the_rules_do_not(self):
        # The rules are an addition, not a replacement: an identity field must still resolve the ordinary way.
        table = {"first_name": "Example"}
        key, answer = drafter.pick_answer("First Name", table, "text")
        self.assertEqual((key, answer), ("first_name", "Example"))


class PersistedRulesDoNotBreakTheGuardTest(unittest.TestCase):
    def test_a_long_answer_cannot_be_forced_into_a_short_field_by_a_rule(self):
        # THE ASANA GUARD, and data must not be able to move it: a sentence in a name/pronoun field is a false
        # statement in a submitted application, whoever wrote the rule that put it there.
        long_answer = "x" * 140
        rules = [{"questionRe": "preferred full name", "answer": long_answer, "note": "a rule trying to break the guard"}]
        key, answer = drafter.pick_answer("Preferred Full Name", {}, "text", rules)
        self.assertIsNone(key, "the short-field guard was bypassed by a persisted rule")
        self.assertIsNone(answer)

    def test_a_long_answer_is_still_allowed_where_the_field_can_hold_it(self):
        # The guard is about the FIELD, not about length as such - an essay question must still be answerable.
        long_answer = "x" * 140
        rules = [{"questionRe": "tell us about yourself", "answer": long_answer, "note": "essay answer, long on purpose"}]
        key, answer = drafter.pick_answer("Tell us about yourself", {}, "textarea", rules)
        self.assertIsNotNone(key)
        self.assertEqual(answer, long_answer)


if __name__ == "__main__":
    unittest.main()
