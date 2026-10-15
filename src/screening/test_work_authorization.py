#!/usr/bin/env python3
"""A work-authorisation requirement is a bar for SOMEONE, not for everyone.

WHY THIS EXISTS. `daily_screen.py` classified a posting's wording and then DROPPED the posting whenever it
named citizenship, a green card or a clearance. Each of those is a wall for the applicant this was built
for - someone on a student visa who needs sponsorship - and an open door for someone else, and because the
screen drops rather than labels, the applicant never learned what had been removed. A citizen never saw the
postings that are most open to them; a green-card holder never saw the ones that name a green card.

The requirement is a fact about the POSTING and stays in the patterns. Whether it disqualifies is a fact
about the APPLICANT, and that is `candidate.standard_answers.work_authorization`.

THE CASES ARE SENTENCES, and the two marked `regression` are ones this work found mis-classified:
"we are unable to sponsor or take over sponsorship of an employment visa" - a sentence the repository's own
`test_screen_patterns.py` already carries as a BAR against `screen_urls.BAD` - came back `likely_accepts`
from this module, which says the employer WILL sponsor, about one that had just said it would not.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = pathlib.Path(__file__).with_name("daily_screen.py")
sys.path.insert(0, str(MODULE.parent))

spec = importlib.util.spec_from_file_location("daily_screen", MODULE)
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


class ARequirementIsABarForSomebodyTest(unittest.TestCase):
    """The matrix, one posting at a time. `kept` is not "no requirement" - it is "you meet it"."""

    #: (the sentence as a posting writes it, who is excluded from it)
    CASES = [
        # A CITIZENSHIP REQUIREMENT IS MET BY A CITIZEN, and by nobody else. This is the case that used to
        # drop the posting for everyone.
        ("must be a U.S. citizen",
         {"permanent_resident", "authorized_no_sponsorship_needed", "requires_sponsorship"}),
        ("This position requires U.S. citizenship due to federal contract requirements",
         {"permanent_resident", "authorized_no_sponsorship_needed", "requires_sponsorship"}),
        # A CLEARANCE already held is a wall for everyone - nothing in the profile supplies one. Obtaining
        # one, though, is something a citizen can do, and the two read the same to a keyword screen.
        ("Clearance: Active final DoD Secret clearance required",
         {"us_citizen", "permanent_resident", "authorized_no_sponsorship_needed", "requires_sponsorship"}),
        ("Ability to obtain and maintain a U.S. security clearance (Secret, Top Secret, TS/SCI) if required",
         {"permanent_resident", "authorized_no_sponsorship_needed", "requires_sponsorship"}),
        # ITAR's "U.S. person" is defined to include a permanent resident, and does NOT include a student on
        # an F-1 visa.
        ("You must have ITAR eligibility as a U.S. Person",
         {"authorized_no_sponsorship_needed", "requires_sponsorship"}),
        # The whole no-sponsorship family: a wall for the one applicant who needs it, and for nobody else.
        ("We are unable to sponsor or take over sponsorship of an employment visa",
         {"requires_sponsorship"}),
        ("This role is not eligible for sponsorship at this time",
         {"requires_sponsorship"}),
        ("We will not be able to sponsor a work visa",
         {"requires_sponsorship"}),
    ]

    def test_the_matrix_holds_for_every_sentence(self):
        everyone = ("us_citizen", "permanent_resident",
                    "authorized_no_sponsorship_needed", "requires_sponsorship")
        wrong = []
        for sentence, excluded in self.CASES:
            status, reason = daily.classify_auth(sentence)
            if status not in ("hard_block", "no_sponsorship"):
                wrong.append(f"{sentence[:60]!r} classified {status!r}, so it is never treated as a bar")
                continue
            for who in everyone:
                applies = daily.requirement_applies(reason, who)
                expected = who in excluded
                if applies != expected:
                    wrong.append(f"{sentence[:44]!r} for {who}: "
                                 f"{'excluded' if applies else 'kept'}, expected "
                                 f"{'excluded' if expected else 'kept'}")
        self.assertEqual(wrong, [], "the requirement/disqualification matrix disagrees with the sentences")

    def test_an_unstated_status_filters_nothing(self):
        # THE SAFE DIRECTION, and the reason this is configuration rather than a constant. A posting dropped
        # by mistake is invisible and cannot be recovered by reading harder; a posting kept by mistake costs
        # one reading.
        for applicant in (None, "", "  ", "<one of: us_citizen | permanent_resident | ...>", "martian"):
            for reason in daily.REQUIREMENT_MET_BY:
                self.assertFalse(daily.requirement_applies(reason, applicant),
                                 f"{reason!r} excluded a posting for an applicant status of {applicant!r}")

    def test_an_unrecognised_reason_is_treated_as_a_bar(self):
        # The other direction: a requirement this table has never heard of is NOT waved through, because
        # "unknown" that means "safe" is how a bar stops being enforced.
        self.assertTrue(daily.requirement_applies("requires_something_new", "us_citizen"))

    def test_every_reason_the_patterns_can_return_is_in_the_table(self):
        # A reason with no entry would take the "unrecognised" path above and be treated as a bar for
        # everyone - which is today's behaviour creeping back in one pattern at a time.
        for _, reason in daily.HARD_BLOCK_PATTERNS + daily.NO_SPONSOR_PATTERNS:
            self.assertIn(reason, daily.REQUIREMENT_MET_BY,
                          f"{reason!r} would be a bar for every applicant")


class TheSponsorshipFamilyIsRecognisedTest(unittest.TestCase):
    """Every way an employer says "we will not sponsor", including the two that were missed."""

    BARS = [
        "We do not offer visa sponsorship for this position",
        "We are unable to sponsor or take over sponsorship of an employment visa",   # regression
        "We will not be able to sponsor a work visa",                                # regression
        "This role is not eligible for sponsorship at this time",
        "Sponsorship is not available for this role",
        "Please note: we are unable to sponsor at this time",
        "Employment sponsorship is not offered for this role",
    ]

    #: The negative controls. A screen that matches everything skips roles for nothing, and only a negative
    #: case can catch that.
    CLEAN = [
        "You'll be helping us scale towards stateRAMP and fedRAMP compliance",
        "citizenship, medical condition, marital or domestic partner status",
        "We are able to sponsor visas for this role",
    ]

    def test_every_wording_is_states_no_sponsorship(self):
        wrong = [(s, daily.classify_auth(s)[0]) for s in self.BARS
                 if daily.classify_auth(s)[0] != "no_sponsorship"]
        self.assertEqual(wrong, [], "a way of refusing to sponsor was not recognised")

    def test_nothing_clean_is_read_as_a_refusal(self):
        wrong = [(s, daily.classify_auth(s)[0]) for s in self.CLEAN
                 if daily.classify_auth(s)[0] == "no_sponsorship"]
        self.assertEqual(wrong, [], "a sentence with no refusal in it was read as one")


if __name__ == "__main__":
    unittest.main()
