#!/usr/bin/env python3
"""Pin the pair of questions that a persisted rule confused: H-1B HISTORY is not SPONSORSHIP.

The misstatement, found on the Esri form on 2026-10-10:

    Will you now or in the future require visa sponsorship from Esri for employment (e.g., H-1B visa)?
    = No

The candidate requires sponsorship. What answered was persisted rule [5], written for "have you held H-1B status", whose
pattern included a bare `h-1b (status|petition|visa)` - and "e.g., **H-1B visa**" is a substring of the SPONSORSHIP
question. Persisted rules run before the built-in table, so `sponsor_future = Yes` was never reached.

These two questions appear on the same page, they are one line apart, and they have DIFFERENT honest answers for this
candidate: he has never held H-1B status (No) and he will require sponsorship (Yes). A test that pins only one of them
would have passed while the form said the opposite of the truth, so both are asserted, plus the two neighbouring
questions that a widened pattern has already threatened once - the `authorized` question, which an earlier widening for
`need` nearly swallowed.
"""
import importlib.util
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "src" / "forms" / "draft_form_spec.py"
_spec = importlib.util.spec_from_file_location("draft_form_spec_h1b", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)


def require_h1b_history_rule() -> None:
    """Skip when the installed rule file has no H-1B-history rule.

    The pair this file exists for is H-1B HISTORY versus SPONSORSHIP, and the history rule is per-tenant
    configuration: `data/form_specs/answer_rules.json` is a hand-written table for this project's own forms, and
    the file `scripts/setup-examples.sh` installs carries three invented rules and no H-1B one at all. The
    regression - a greedily written `h-1b (status|petition|visa)` pattern taking the sponsorship question away
    from the canonical answer - is a property of THAT rule's pattern, so with no such rule here there is nothing
    for the two tests below to assert. `test_a_sponsorship_question_is_never_answered_by_the_h1b_history_rule`
    still runs: it asserts the sponsorship question is answered from the canonical table, which holds whatever
    the rule file contains, and it is the one that would have caught the original misstatement.
    """
    rules = drafter.load_answer_rules()
    if not any(re.search(r"h-?1-?b", str(rule.get("questionRe", "")), re.I) for rule in rules):
        raise unittest.SkipTest(
            "the installed answer_rules.json carries no H-1B-history rule (the example file has three invented "
            "rules): the persisted rule this pair of tests is about is per-tenant configuration and is not part "
            "of this checkout")

TABLE = {"sponsor_now": "Yes", "sponsor_future": "Yes", "authorized": "Yes"}

# Verbatim from the Esri embed form and the Twitch form, 2026-10-10.
ESRI_SPONSORSHIP = ("Will you now or in the future require visa sponsorship from Esri for employment "
                    "(e.g., H-1B visa)?")
TWITCH_SPONSORSHIP = ("Your response is mandatory when applying for a U.S.-based position. Do you need, or will you "
                      "need in the future, any immigration related support or sponsorship from Amazon in order to "
                      "begin or continue employment with Amazon? *")
H1B_HISTORY = ("Have you held H-1B status, or had an H-1B petition approved on your behalf, within the preceding 6 "
               "years for an employer other than a cap exempt institution? *")


class HistoryIsNotSponsorshipTest(unittest.TestCase):
    def test_a_sponsorship_question_is_never_answered_by_the_h1b_history_rule(self):
        # THE REGRESSION. The rule file runs first, so a match here is what silenced the correct answer.
        rules = drafter.load_answer_rules()
        for q in (ESRI_SPONSORSHIP, TWITCH_SPONSORSHIP):
            key, answer = drafter.pick_answer(q, TABLE, "select", rules)
            self.assertEqual(answer, "Yes", f"{q[:60]!r} must be Yes: the candidate requires sponsorship")
            self.assertNotEqual(key, "@rule:5", "the H-1B history rule claimed a sponsorship question")
            self.assertIn(key, ("sponsor_now", "sponsor_future"), f"got {key!r}")

    def test_the_history_question_still_gets_its_own_answer(self):
        # The other coat: narrowing for the sponsorship question must not stop the rule firing on the one it is for.
        require_h1b_history_rule()
        key, answer = drafter.pick_answer(H1B_HISTORY, {}, "select", drafter.load_answer_rules())
        self.assertEqual(key, "@rule:5", "the H-1B history rule stopped answering its own question")
        self.assertEqual(answer, "No", "he has never held H-1B status")

    def test_the_four_immigration_questions_stay_four_different_answers(self):
        # They sit within a few lines of each other on an Amazon-owned form and each has its own truth. A rule widened
        # for one has twice now threatened another: `authorized` nearly swallowed by a `need` widening, and the
        # sponsorship question swallowed by this one.
        require_h1b_history_rule()
        rules = drafter.load_answer_rules()
        got = {
            "esri_sponsorship": drafter.pick_answer(ESRI_SPONSORSHIP, TABLE, "select", rules)[0],
            "h1b_history": drafter.pick_answer(H1B_HISTORY, TABLE, "select", rules)[0],
            "authorized": drafter.pick_answer("Are you legally authorized to work in the United States?", TABLE,
                                              "select", rules)[0],
        }
        self.assertIn(got["esri_sponsorship"], ("sponsor_now", "sponsor_future"))
        self.assertEqual(got["h1b_history"], "@rule:5")
        self.assertEqual(got["authorized"], "authorized")


if __name__ == "__main__":
    unittest.main()
