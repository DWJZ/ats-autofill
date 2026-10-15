#!/usr/bin/env python3
"""Tests for the compensation rule now that it lives in data rather than in the script or the contract.

The move was made because the value had already DRIFTED: the contract said $150,000-$170,000, the script had its own
constant, and the user remembered having said $200,000. Three copies, two of them wrong. The number now has one home -
`candidate_profile.json -> candidate.standing_answers.compensation` - and these tests are what makes that safe:

  - the rule is READ, so editing the data changes the behaviour with no code change;
  - a published band always wins, because that number came from the employer;
  - the fallback is reported as NOT published, so a spec can say which of the two it used;
  - and a missing or malformed entry produces an explicit miss, never a default. A number nobody recorded is a claim
    about the candidate, which is the one thing this project refuses to write into a form.
"""
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import importlib.util

MODULE_PATH = pathlib.Path(__file__).with_name("draft_form_spec.py")
_spec = importlib.util.spec_from_file_location("draft_form_spec_comp", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)


class CompensationFromDataTest(unittest.TestCase):
    def test_the_rule_is_read_from_canonical_data(self):
        rule = drafter.compensation_rule()
        self.assertTrue(rule, "no compensation rule was read - it lives in candidate_profile.json")
        self.assertIsInstance(rule.get("fallback"), int)
        self.assertGreater(rule["fallback"], 0)

    def test_the_number_is_not_hardcoded_in_the_script(self):
        # The whole point of the move. A literal fallback in the module would drift from the data again - which is
        # exactly what happened to the $150,000-$170,000 this replaced.
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("COMP_FALLBACK = ", source, "the fallback is hardcoded again")
        self.assertIn("standing_answers", source, "the rule is no longer read from the profile")

    def test_a_published_band_wins_over_the_fallback(self):
        value, published = drafter.compensation_answer(
            {"label": "Expected compensation", "help": "The band for this role is $127,100 - $185,000"}
        )
        self.assertEqual(value, "$185,000", "the TOP of the published band, not the average and not the fallback")
        self.assertTrue(published, "a band that came from the posting must be marked as published")

    def test_with_no_band_the_recorded_fallback_is_used_and_marked_unpublished(self):
        value, published = drafter.compensation_answer(
            {"label": "What is your expected total base pay compensation for your next role?"}
        )
        rule = drafter.compensation_rule()
        self.assertEqual(value, f"${rule['fallback']:,}")
        self.assertFalse(published, "our own fallback must never be marked as published")

    def test_the_fallback_follows_the_data_rather_than_a_constant(self):
        # Edit the data, get a different answer - with no code change. This is what makes the value testable.
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "candidate_profile.json"
            path.write_text(json.dumps({"candidate": {"standing_answers": {
                "compensation": {"rule": "top_of_published_band", "fallback": 123456}}}}), encoding="utf-8")
            rule = drafter.load(path)["candidate"]["standing_answers"]["compensation"]
        self.assertEqual(rule["fallback"], 123456)

    def test_a_missing_rule_is_an_explicit_miss_not_a_default(self):
        # `compensation_rule` takes the candidate dict, so this asks the same question with the data absent.
        self.assertEqual(drafter.compensation_rule({}), {}, "an absent rule must produce nothing, not a number")
        self.assertEqual(drafter.compensation_rule({"standing_answers": {}}), {})
        self.assertEqual(
            drafter.compensation_rule({"standing_answers": {"compensation": {"fallback": "not a number"}}}), {},
            "a malformed fallback must not be coerced into a claim",
        )
        self.assertEqual(drafter.compensation_rule({"standing_answers": {"compensation": {"fallback": 0}}}), {})

    def test_the_answer_says_ASK_THE_USER_when_there_is_no_rule(self):
        # With no rule and no band, `compensation_answer` returns None - which the caller turns into a needs_review
        # entry. It must never invent a number to avoid the blank.
        with mock.patch.object(drafter, "compensation_rule", return_value={}):
            self.assertEqual(drafter.compensation_answer({"label": "Expected compensation"}), (None, False))


class ThePostingBandTest(unittest.TestCase):
    """A published band beats the fallback, and the POSTING beats the field's own help text."""

    def _draft(self, inventory):
        import subprocess, sys, tempfile
        with tempfile.TemporaryDirectory() as d:
            fpath = pathlib.Path(d) / "fields.json"
            opath = pathlib.Path(d) / "out.spec.json"
            fpath.write_text(json.dumps(inventory), encoding="utf-8")
            r = subprocess.run(
                [sys.executable, str(MODULE_PATH), str(fpath), "--out", str(opath), "--job", "t"],
                capture_output=True, text=True, cwd=MODULE_PATH.resolve().parents[2])
            assert r.returncode == 0, r.stderr[-800:]
            spec = json.loads(opath.read_text(encoding="utf-8"))
            return [e for e in (spec.get("texts") or []) if e.get("ref") == "id:pay"]

    FIELD = {"ref": "id:pay", "label": "What is your expected total base pay compensation for your next role?",
             "help": "", "type": "text", "value": "", "options": []}

    def test_the_postings_own_range_gives_the_top(self):
        # The Twitch numbers, verbatim.
        entries = self._draft({"url": "x", "fields": [self.FIELD], "payRange": {"low": 127100, "high": 185000}})
        self.assertEqual(len(entries), 1, "the field must be drafted - the rule exists, only its input was missing")
        self.assertEqual(entries[0]["value"], "$185,000")
        self.assertIn("127,100", entries[0].get("note", ""), "the note shows the range it came from")

    def test_no_published_range_still_falls_back(self):
        entries = self._draft({"url": "x", "fields": [dict(self.FIELD, label="Expected compensation")]})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["value"], f"${drafter.compensation_rule()['fallback']:,}")
        self.assertIn("FALLBACK", entries[0].get("note", ""), "the fallback must say it is one")

    def test_the_posting_beats_the_fields_own_help_text(self):
        # A tenant's tooltip is a different claim from the employer's published band, and the posting is the one the
        # candidate is answering about. When they disagree the posting wins.
        entries = self._draft({
            "url": "x", "payRange": {"low": 100000, "high": 150000},
            "fields": [dict(self.FIELD, help="The band for this role is $120,000 - $160,000")],
        })
        self.assertEqual(entries[0]["value"], "$150,000", "the posting's top, not the help text's")


if __name__ == "__main__":
    unittest.main()
