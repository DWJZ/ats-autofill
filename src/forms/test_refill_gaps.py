#!/usr/bin/env python3
"""Tests for the three rule gaps a BLANK-FORM refill exposed.

Every one of these was found by emptying the Twitch form and re-drafting it, and every one was reported as a missing
ANSWER rather than a missing RULE:

    Start date month   | optional, no profile mapping      <- the year rules existed; the month ones did not
    Website            | optional, no profile mapping      <- `github` was in canonical data all along
    ... sponsorship?   | no profile mapping                <- the sponsor rules wanted `require`; Amazon says `need`

The last two tests are the ones that keep the sponsorship widening honest: an honest reading of "authorized to work" and
a question about needing sponsorship are DIFFERENT questions with different answers on this candidate (Yes and Yes), and
a rule widened to catch `need` must not start answering the wrong one.
"""
import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("draft_form_spec.py")
_spec = importlib.util.spec_from_file_location("draft_form_spec_gaps", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)

TABLE = {
    "degree_start_month": "September", "degree_end_month": "December",
    "degree_start_year": "2025", "degree_end_year": "2026",
    "github": "https://github.com/example-candidate", "sponsor_now": "Yes", "sponsor_future": "Yes", "authorized": "Yes",
}

# The Amazon wording, copied from the live Twitch form.
AMAZON_SPONSOR = (
    "Your response is mandatory when applying for a U.S.-based position. Do you need, or will you need in the "
    "future, any immigration related support or sponsorship from Amazon in order to begin or continue employment "
    "with Amazon? *"
)


class RefillGapRulesTest(unittest.TestCase):
    def test_the_month_half_of_the_education_block_is_mapped(self):
        self.assertEqual(drafter.pick_answer("Start date month", TABLE, "select")[1], "September")
        self.assertEqual(drafter.pick_answer("End date month", TABLE, "select")[1], "December")
        # The year halves must keep working - the refill showed both at once.
        self.assertEqual(drafter.pick_answer("Start date year", TABLE, "number")[1], "2025")

    def test_the_month_names_come_from_the_profile_not_from_a_guess(self):
        profile = {"education": [{"school": "X", "degree": "M.S.", "start": "09/2024", "end": "05/2026"}]}
        table = drafter.build_answer_table({}, profile)
        self.assertEqual(table["degree_start_month"], "September")
        # The dates above are this test's own premise, so the expected month is derived from THEM and not
        # from whatever the example profile happens to carry - that is the property under test.
        self.assertEqual(table["degree_end_month"], "May")
        # An absent or unparseable date must produce an EMPTY month rather than a plausible one.
        table2 = drafter.build_answer_table({}, {"education": [{"school": "Y", "degree": "B.S."}]})
        self.assertEqual(table2["degree_start_month"], "")

    def test_website_maps_to_the_canonical_github(self):
        self.assertEqual(drafter.pick_answer("Website", TABLE, "text")[1], "https://github.com/example-candidate")
        self.assertEqual(drafter.pick_answer("Personal website", TABLE, "text")[1], "https://github.com/example-candidate")

    def test_the_sponsorship_wording_that_uses_need(self):
        key, answer = drafter.pick_answer(AMAZON_SPONSOR, TABLE, "select")
        self.assertEqual(key, "sponsor_now")
        self.assertEqual(answer, "Yes")

    def test_widening_for_need_did_not_steal_the_authorization_question(self):
        # THE GUARD ON THE WIDENING. These two questions are adjacent on every Amazon form and have DIFFERENT honest
        # answers for this candidate; a rule that catches `need` must not also catch `authorized`.
        key, _ = drafter.pick_answer("Are you legally authorized to work in the United States?", TABLE, "select")
        self.assertEqual(key, "authorized")
        key, _ = drafter.pick_answer(
            "Will you now or in the future require sponsorship for employment visa status?", TABLE, "select")
        self.assertIn(key, ("sponsor_now", "sponsor_future"), f"got {key!r} for a sponsorship question")


if __name__ == "__main__":
    unittest.main()
