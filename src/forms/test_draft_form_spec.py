#!/usr/bin/env python3
"""Regression tests for the option resolver in draft_form_spec.py.

The resolver once mapped "Male" onto the tenant option "Transgender woman", because it matched
the substring "man" inside "wo-man". These tests pin the word-boundary behaviour.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("draft_form_spec.py")
spec = importlib.util.spec_from_file_location("draft_form_spec", MODULE_PATH)
drafter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drafter)


class ResolveOptionTest(unittest.TestCase):
    def test_male_never_matches_woman(self):
        options = ["Cisgender woman", "Cisgender man", "Transgender woman", "Transgender man",
                   "Non-binary", "Two-spirit", "My gender identity is not listed", "I don't wish to answer"]
        self.assertEqual(drafter.resolve_option("Male", options)[0], "Cisgender man")
        self.assertEqual(drafter.resolve_option("male", options)[0], "Cisgender man")
        self.assertEqual(drafter.resolve_option("Man", options)[0], "Cisgender man")

    def test_female_maps_to_the_woman_option(self):
        options = ["Cisgender woman", "Cisgender man", "Transgender woman", "Transgender man"]
        self.assertEqual(drafter.resolve_option("Female", options)[0], "Cisgender woman")

    def test_exact_and_simple_options_still_work(self):
        self.assertEqual(drafter.resolve_option("No", ["Yes", "No"]), ("No", True))
        self.assertEqual(drafter.resolve_option("East Asian", ["Black/of African origin", "East Asian"])[0], "East Asian")
        self.assertEqual(drafter.resolve_option("Man", ["Man", "Woman", "Non-binary or third gender"])[0], "Man")
        self.assertEqual(drafter.resolve_option("Asian", ["American Indian or Alaskan Native", "Asian"])[0], "Asian")

    def test_unknown_answer_returns_none_rather_than_guessing(self):
        self.assertEqual(drafter.resolve_option("Male", ["Purple", "Green"])[0], None)

    def test_defensive_options_do_not_capture_other_answers(self):
        options = ["Woman", "Non-binary"]
        self.assertEqual(drafter.resolve_option("Male", options)[0], None)


class MatcherTableTest(unittest.TestCase):
    """What the label matchers answer, measured against the saved inventories.

    The table is a hand-written whitelist, so a wording nobody wrote down fails silently into
    `needs_review`. These are the wordings the real corpus showed were missing: reading all 906 saved
    inventories, a bare "Name" alone was 406 fields and it is Ashby's REQUIRED system field.
    """
    TABLE = {
        "full_name": "Example Candidate", "first_name": "Example", "last_name": "Candidate",
        "current_company": "Example Company One", "how_heard": "Company careers page",
        "school_ats": "Lakeside State University - Fairview", "field": "Software Engineering",
    }

    def key(self, label, kind="text"):
        return drafter.pick_answer(label, self.TABLE, kind)[0]

    def test_a_bare_name_is_the_full_name(self):
        for label in ["Name", "Name*", "name", "Full Name", "Full Name*", "Your Name", "Legal Name"]:
            self.assertEqual(self.key(label), "full_name", label)

    def test_a_bare_name_never_steals_a_more_specific_field(self):
        # The pattern is anchored at both ends for exactly these; a prefix rule would have taken them.
        for label in ["First Name", "Last Name", "Company Name", "Name of School", "User Name",
                      "Name of Emergency Contact", "School Name"]:
            self.assertNotEqual(self.key(label), "full_name", label)
        self.assertEqual(self.key("First Name"), "first_name")
        self.assertEqual(self.key("Last Name"), "last_name")

    def test_current_company_in_its_plain_wording(self):
        for label in ["Current Company", "Current Company*", "Current Employer", "Most Recent Employer"]:
            self.assertEqual(self.key(label), "current_company", label)

    def test_how_did_you_hear_works_on_a_select_too(self):
        # 23 saved inventories spell this on a react-select, and the matcher only covered kind=text -
        # so the one question this project has a standing answer for fell through unanswered.
        for kind in ("text", "select"):
            self.assertEqual(self.key("How did you hear about us?*", kind), "how_heard", kind)
            self.assertEqual(self.key("How did you hear about this role?", kind), "how_heard", kind)
            self.assertEqual(self.key("How did you hear about us?", kind), "how_heard", kind)

    def test_a_form_that_says_learn_instead_of_hear_still_reaches_the_answer(self):
        """A FORM THAT SAYS "LEARN", and the verb this table had no pattern for.

        A greenhouse board, 2026-10-15, driven in a headless Chrome on the CDP port. Its required select
        reads - with the employer's own name, which is why the label below is anonymised:

            How did you first learn about <Company> as an employer? *

        `pick_answer` matches the LABEL, and every pattern for this question matched "hear" - so the field
        came back `no profile mapping` in needs_review while `standing_answers.how_did_you_hear` held an
        answer for exactly that question. THE TEMPTING FIX WAS THE WRONG ONE: a rule in answer_rules.json
        answers it, but those rules are tried FIRST, so it would have taken this question away from the
        built-in matcher for every other tenant's wording - which is what
        `test_how_did_you_hear_works_on_a_select_too` above exists to catch. The gap was in the matcher.

        WHY THE TENANT IS NOT NAMED HERE. The wording is what the pattern must cover, and the pattern does
        not care which employer asked it. The tenant, the requisition id and the applicant this was found on
        are facts about a real person's job search, and this is a file in a repository - see
        `canonical_citizenship()`, which reads one person's nationality from the profile rather than pinning
        it here for the same reason.
        """
        for label in ("How did you first learn about <Company> as an employer? *",
                      "How did you first learn about us?",
                      "How did you learn about this role?",
                      "Where did you learn about our company?",
                      "Where did you hear about this position?"):
            for kind in ("text", "select"):
                with self.subTest(label=label, kind=kind):
                    self.assertEqual(self.key(label, kind), "how_heard", label)

    def test_a_learn_pattern_does_not_capture_a_different_question(self):
        # `learn` is a loose word and appears in questions about training and adaptability, which are a
        # different question with no standing answer. The matcher requires the DISCOVERY wording around
        # it - "how/where + hear/learn + about + object" - which is what keeps these out.
        for label in ("What do you want to learn in this role?",
                      "Are you willing to learn new technologies?",
                      "Describe a time you had to learn something quickly",
                      "How do you learn best?"):
            with self.subTest(label=label):
                self.assertNotEqual(self.key(label), "how_heard", label)

    def test_school_and_field_work_on_a_plain_text_input_too(self):
        for label in ["School", "School*", "University", "College"]:
            self.assertEqual(self.key(label), "school_ats", label)
        for label in ["Discipline", "Discipline*", "Field of Study", "Major"]:
            self.assertEqual(self.key(label), "field", label)

    def test_the_text_school_matchers_stay_anchored(self):
        # A text field is typed into verbatim: an unanchored pattern would write the school name into
        # whatever box happened to contain the word, and nothing downstream would report it.
        for label in ["School or University", "College Board ID", "University of Phoenix campus"]:
            self.assertNotEqual(self.key(label), "school_ats", label)

    def test_a_label_with_no_matcher_still_returns_nothing(self):
        for label in ["Additional Information", "Anything else?", "What's your favorite junk food?"]:
            self.assertIsNone(self.key(label), label)


class RefFallbackTest(unittest.TestCase):
    """When the question could not be read, the control's own name/id still identifies the field.

    SmartRecruiters and Workable render whole blocks with no label in the DOM; the saved corpus has
    362 such controls, and their `name` attribute says exactly what they are. This runs only after a
    label produced nothing, which is what makes it safe for the entries that overlap the label table.
    """
    TABLE = {"email": "a@b.c", "full_name": "Example Candidate", "first_name": "Example",
             "linkedin": "https://linkedin.com/in/x", "veteran_protected": "No military service",
             "gender": "Male", "city_full": "Springfield, Illinois, United States"}

    def test_a_ref_names_the_field_when_the_label_is_blank(self):
        for ref, key in [("name:email", "email"), ("name:name", "full_name"),
                         ("id:firstname", "first_name"), ("name:urls[LinkedIn]", "linkedin"),
                         ("name:eeo[veteran]", "veteran_protected"), ("name:eeo[gender]", "gender"),
                         ("id:location-input", "city_full")]:
            self.assertEqual(drafter.pick_answer_from_ref(ref, self.TABLE)[0], key, ref)

    def test_an_opaque_ref_yields_nothing_rather_than_a_guess(self):
        # A tenant's own question carries a uuid and no meaning: `cards[<uuid>][field0]` is 60 of the
        # blank-label controls, and they are genuinely unknown.
        for ref in ["name:cards[c4795398-31a6-468e-aab8-449b8fd3ec81][field0]", "input:7", ""]:
            self.assertIsNone(drafter.pick_answer_from_ref(ref, self.TABLE)[0], ref)

    def test_a_key_with_no_canonical_answer_stays_unanswered(self):
        # `twitter` is reachable by ref and has no value anywhere in the project: the ref says which
        # field this is, never what to write in it.
        self.assertIsNone(drafter.pick_answer_from_ref("name:urls[Twitter]", self.TABLE)[0])

    def test_a_ref_never_overrides_a_label_that_answered(self):
        # The fallback lives after pick_answer in the pipeline; at the unit level the guarantee is that
        # a labelled field takes the label's answer even when its ref says something else.
        self.assertEqual(drafter.pick_answer("Email", self.TABLE, "text")[0], "email")

    def test_the_ref_is_normalised_before_matching(self):
        self.assertEqual(drafter.ref_hint("name:urls[LinkedIn]"), "urls[linkedin]")
        self.assertEqual(drafter.ref_hint("id:location-input"), "location-input")
        self.assertEqual(drafter.ref_hint("NAME:Email"), "email")


class KeyScopedSynonymsTest(unittest.TestCase):
    """One answer value, several questions: the option list has to be chosen by the question.

    On 57 saved fields the answer was the bare string "Yes" while the tenant offered
    "Acknowledge/Confirm", "I am authorized to work for any employer ..." and "I require/will require
    <tenant>'s sponsorship ..." on the same form. Keying the synonyms by question is what separates
    them; the value-level table stays the fallback for everything else.
    """

    def test_one_yes_finds_the_consent_wording(self):
        options = ["Acknowledge/Confirm", "Decline"]
        self.assertEqual(drafter.resolve_option("Yes", options, "consent")[0], "Acknowledge/Confirm")

    def test_authorization_and_sponsorship_are_told_apart(self):
        options = [
            "I am authorized to work for any employer in the country in which this position is based.",
            "I require/will require Lyft's sponsorship to obtain work authorization in the country in which this position is based.",
        ]
        self.assertEqual(drafter.resolve_option("Yes", options, "authorized")[0], options[0])
        self.assertEqual(drafter.resolve_option("Yes", options, "sponsor_now")[0], options[1])

    def test_willing_and_unwilling_relocation_do_not_cross(self):
        options = ["I am willing to relocate before starting employment.",
                   "I am not willing to relocate before starting employment."]
        self.assertEqual(drafter.resolve_option("Yes", options, "will_relocate")[0], options[0])

    def test_a_key_specific_wording_never_leaks_to_another_question(self):
        options = ["Acknowledge/Confirm"]
        for key in ("authorized", "sponsor_now", "will_relocate", "gender", "race_east_asian"):
            self.assertIsNone(drafter.resolve_option("Yes", options, key)[0], key)

    def test_the_value_table_still_answers_when_no_key_is_passed(self):
        # Existing callers pass no key; the old behaviour has to survive untouched.
        self.assertEqual(drafter.resolve_option("No", ["Yes", "No"]), ("No", True))
        self.assertEqual(drafter.resolve_option("Male", ["Cisgender man", "Cisgender woman"])[0], "Cisgender man")


class GroupAnswerTest(unittest.TestCase):
    """A radio/checkbox group is answered from its QUESTION, not from each option's own text.

    A group arrives as one field per option, and every row's `label` is the option ("Male"), so the
    group used to be unanswerable no matter how well known the question was. The scanner now reports
    `group_label`; these drive the real `main()` over a synthetic inventory to prove it lands.
    """
    def draft(self, fields):
        # A NAMED DIRECTORY THAT THE CASE REMOVES, and both halves are the point. A bare `mkdtemp()` left 16
        # directories per run - this helper is called from tests in two classes - and it had no name for a
        # sweep to match on, which is how it outlived the sweep that found the families beside it. The prefix
        # is what `scripts/run-contract-tests.sh` watches; `addCleanup` is what removes it, on every way out of
        # a test rather than only on the one that returns.
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="draft-spec-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        inventory = tmp / "fields.json"
        produced = tmp / "spec.json"
        inventory.write_text(json.dumps({"url": "https://example.test/apply", "fields": fields}), encoding="utf-8")
        with mock.patch.object(sys, "argv", ["draft_form_spec.py", str(inventory), "--out", str(produced)]), \
                contextlib.redirect_stdout(io.StringIO()):
            drafter.main()
        review = json.loads(produced.with_name(produced.stem + ".needs_review.json").read_text(encoding="utf-8"))
        return json.loads(produced.read_text(encoding="utf-8")), review["needs_review"]

    def group(self, question, options, kind="radio", group_id="grp"):
        return [{"ref": f"id:{group_id}_{i}", "type": kind, "option_group": group_id, "label": text,
                 "group_label": question, "required": True, "value": "[unchecked]"} for i, text in enumerate(options)]

    def test_a_radio_group_is_answered_from_its_question(self):
        spec, review = self.draft(self.group("Are you legally authorized to work in the United States?",
                                             ["Yes", "No"]))
        self.assertEqual(len(spec["radios"]), 1)
        self.assertEqual(spec["radios"][0]["option"], "Yes")
        self.assertEqual(spec["radios"][0]["ref"], "id:grp_0")
        self.assertEqual(review, [])

    def test_the_group_is_decided_once_not_once_per_option(self):
        # Eight options used to mean eight review rows; they must not become eight radio entries.
        spec, _ = self.draft(self.group("Veteran Status",
                                        ["I identify as one or more of the classifications of protected veteran listed above",
                                         "I am not a protected veteran",
                                         "I decline to self-identify for protected veteran status"]))
        self.assertEqual(len(spec["radios"]), 1)
        self.assertEqual(spec["radios"][0]["option"], "I am not a protected veteran")

    def test_an_unrecognised_question_still_goes_to_review(self):
        spec, review = self.draft(self.group("Do you like pineapples on pizza?", ["Yes", "No"]))
        self.assertEqual(spec["radios"], [])
        self.assertEqual(len(review), 1, "one review row for the group, not one per option")
        self.assertIn("pick the option", review[0]["note"])

    def test_a_group_that_is_not_required_stays_untouched(self):
        fields = self.group("Do you like pineapples on pizza?", ["Yes", "No"])
        for row in fields:
            row["required"] = False
        spec, review = self.draft(fields)
        self.assertEqual(spec["radios"], [])
        self.assertEqual(review, [], "an optional group nobody can answer is not a blocker")

    def test_a_consent_RADIO_group_is_answered_never_checked(self):
        # THE BUG THIS PINS. The consent shortcut ran for `ftype in ("checkbox", "radio")` while
        # `seen_checks` is keyed by ref - and every option of a radio group has its own ref - so one
        # `{"checked": true}` was emitted per option. The filler applies checks in order and on a radio
        # group the LAST one wins, so this exact shape committed "I do not acknowledge" on a required
        # field. A radio group is decided, not checked, so the answer path resolves "Yes" onto the
        # option that actually says it.
        spec, review = self.draft(self.group("I acknowledge that I have read the privacy notice",
                                            ["I acknowledge", "I do not acknowledge"]))
        self.assertEqual(spec["checks"], [], "a radio group was emitted as a check")
        self.assertEqual(len(spec["radios"]), 1)
        self.assertEqual(spec["radios"][0]["option"], "I acknowledge",
                         "the acknowledgement resolved onto the option that does not acknowledge")
        self.assertEqual(review, [])

    def test_no_radio_option_is_ever_emitted_as_a_check(self):
        # The general form, so a future word added to the consent regex cannot reintroduce it for a
        # group whose question happens to contain it. Each of these questions contains one of the five
        # words the shortcut keys on, and a radio group carries one row per option.
        for question in ("Voluntary Demographic Information: Gender",
                         "Do you agree to the terms and conditions?",
                         "Privacy notice acknowledgement",
                         "Consent to process my application"):
            with self.subTest(question=question):
                spec, _ = self.draft(self.group(question, ["Yes", "No", "Decline to self-identify"]))
                self.assertEqual(spec["checks"], [],
                                 f"a radio option was emitted as a check for {question!r}")
                self.assertLessEqual(len(spec["radios"]), 1)

    def test_a_consent_CHECKBOX_is_still_checked_directly(self):
        # The other half, so restricting the shortcut to checkboxes did not disable it. A lone consent
        # checkbox has no options to resolve onto - checking it IS the answer.
        spec, _ = self.draft(self.group("I agree to the terms and conditions", ["I agree"],
                                        kind="checkbox", group_id="cb"))
        self.assertEqual(spec["checks"], [{"ref": "id:cb_0", "checked": True}])
        self.assertEqual(spec["radios"], [])

        # The consent path is unchanged: it checks the box rather than trying to answer a question.
        spec, _ = self.draft([{"ref": "id:consent", "type": "checkbox", "label": "I agree",
                               "group_label": "Privacy notice", "required": True, "value": "[unchecked]"}])
        self.assertEqual(spec["checks"], [{"ref": "id:consent", "checked": True}])


class EducationYearMatchersTest(unittest.TestCase):
    """The four-control education block: month fields AND year fields, each with its own label."""

    TABLE = {"degree_start_year": "2025", "degree_end_year": "2026", "bachelor_end_year": "2016"}

    def test_the_year_fields_map_to_the_education_dates(self):
        # Both kinds, because the inventory reports these as `type: number` and the drafter's kind must not decide
        # whether a real question gets answered.
        for kind in ("text", "number"):
            self.assertEqual(
                drafter.pick_answer("Start date year", self.TABLE, kind)[1], "2025",
                f"kind={kind}: the start year is in the table but nothing mapped it",
            )
            self.assertEqual(drafter.pick_answer("End date year", self.TABLE, kind)[1], "2026")

    def test_a_graduation_year_is_an_end_year(self):
        self.assertEqual(drafter.pick_answer("Graduation year", self.TABLE, "text")[1], "2026")

    def test_the_pattern_does_not_swallow_a_years_of_experience_question(self):
        # THE GUARD. "How many years of professional software development experience" is a different question with a
        # different answer (a count, not a calendar year), and 2025 in that field would be a false statement.
        for label in (
            "How many years of professional software development experience do you have?",
            "Years of experience with Python",
            "Years of industry experience*",
        ):
            key, _ = drafter.pick_answer(label, self.TABLE, "select")
            self.assertNotIn(key, ("degree_start_year", "degree_end_year"), f"{label!r} matched an education year")


class NoAnswerIsInventedTest(unittest.TestCase):
    """Every value in the answer table comes from the profile, or is left empty and reported.

    THE INVARIANT THE WHOLE MODULE RESTS ON, and the one it kept breaking quietly: a literal here is
    not a default, it is a statement about a person that the person never made. On work authorisation
    and sponsorship that is a false statement to an employer; on `will_relocate` it is a commitment
    nobody agreed to; on `how_heard` it is a claim about the applicant's own behaviour.
    """

    #: Values that mean "no answer". A key holding one of these is reported as a gap, not filled.
    EMPTY = ("", None, [], {})

    def test_an_empty_profile_produces_no_answers_at_all(self):
        # THE LOAD-BEARING CASE. It is what found `city_full` and `how_heard`, which a source reading
        # had missed: both filled themselves in with nothing to read, one from a literal inside a join
        # and one from a fallback after an `or`.
        table = drafter.build_answer_table({}, {})
        invented = {k: v for k, v in table.items() if v not in self.EMPTY}
        self.assertEqual(
            invented, {},
            f"these answers were produced from an EMPTY profile, so nothing states them: {invented}")

    def test_every_former_literal_follows_the_profile(self):
        # The eleven keys that were literals, checked in both directions: the profile's value is used,
        # and a profile that states nothing leaves them empty. A regression to a default fails one of
        # the two halves whichever direction it drifts.
        profile = {
            "name": "Example Candidate",
            "standard_answers": {
                "us_work_authorized": "Yes",
                "sponsorship_required": "No",
                "restrictive_agreement": "No",
                "previously_worked_here": "No",
                "referred_by_employee": "No",
            },
            "standing_answers": {
                "relocation": "No",
                "office_commuting": "No",
                "required_consent_and_agreement": "Yes",
                "how_did_you_hear": {"first_choice": "The company's own careers page"},
            },
        }
        app = {
            "candidate": {"address": {"city": "Springfield", "state": "Illinois",
                                      "country": "United States of America"}},
            "education": [{"degree": "M.S.", "school": "Example State University"},
                          {"degree": "B.S.", "school": "Metropolitan Institute of Technology"}],
        }
        table = drafter.build_answer_table(profile, app)

        # The profile's own values, not a nearby constant.
        self.assertEqual(table["country"], "United States of America")
        self.assertEqual(table["city_full"], "Springfield, Illinois, United States of America")
        self.assertEqual(table["how_heard"], "The company's own careers page")
        self.assertEqual(table["consent"], "Yes")
        # No for a profile that answers No. This is the pair that used to be hardcoded Yes, and
        # `will_relocate` is the fallback for EVERY relocation question - the worst one to guess.
        self.assertEqual(table["will_relocate"], "No")
        self.assertEqual(table["onsite_ok"], "No")
        self.assertEqual(table["no_current_agreement"], "No")
        self.assertEqual(table["not_worked_here"], "No")
        self.assertEqual(table["not_referred"], "No")
        # Derived from the degree the education entries name, in the ATS's own spelling.
        self.assertEqual(table["degree"], "Master's Degree")
        self.assertEqual(table["bachelor_degree"], "Bachelor's Degree")

        # And the other half: a profile that states none of them leaves each one empty rather than
        # falling back to the value this file used to carry.
        bare = drafter.build_answer_table({"name": "X"}, {})
        for key in ("country", "city_full", "consent", "will_relocate", "onsite_ok",
                    "no_current_agreement", "not_worked_here", "not_referred",
                    "degree", "bachelor_degree", "how_heard",
                    "authorized", "sponsor_now", "sponsor_future"):
            self.assertEqual(bare[key], "", f"{key} answered itself with no profile to read")

    def test_an_unrecognised_degree_spelling_is_not_guessed_at(self):
        # The mapper resolves the profile's spelling onto the ATS's option text, and stops there: a
        # degree it does not recognise leaves the control empty rather than picking the nearest one.
        self.assertEqual(drafter.degree_option("M.S."), "Master's Degree")
        self.assertEqual(drafter.degree_option("Bachelor of Science"), "Bachelor's Degree")
        self.assertEqual(drafter.degree_option("Diploma in Applied Whatever"), "")
        self.assertEqual(drafter.degree_option(""), "")
        self.assertEqual(drafter.degree_option(None), "")

    def test_a_placeholder_is_not_an_answer(self):
        # The shipped examples use placeholders that read as values. `<the option text your form
        # offers>` must not travel into a form as though it were the applicant's answer.
        for value in ("<Yes or No>", "Example: your own words here", "TBD", "  "):
            self.assertEqual(drafter.yes_no(value), "", f"{value!r} was accepted as a Yes/No answer")
        self.assertEqual(drafter.yes_no("Yes"), "Yes")
        self.assertEqual(drafter.yes_no("no"), "No")


class CitizenshipIsNotResidenceTest(unittest.TestCase):
    """Two answers that a differently-shaped applicant got wrong, and that no test could see.

    Both were found by running the drafter against an applicant deliberately unlike the one this was
    written for: a US CITIZEN LIVING IN TORONTO, whose education is a B.Sc.N. and a diploma. Neither
    defect is visible with a US-resident master's holder, which is why an audit that reads the code
    found neither.
    """

    #: `citizenship` is the country of citizenship; the address is where they live. They are the same
    #: for most applicants, which is exactly why answering one with the other goes unnoticed.
    PROFILE = {"name": "Łukasz Żółkiewski", "citizenship": "United States of America",
               "standing_answers": {}}
    APP = {
        "candidate": {"address": {"city": "Toronto", "state": "Ontario", "country": "Canada"}},
        "education": [
            {"school": "Toronto Metropolitan University", "degree": "B.Sc.N.",
             "field_of_study_workday": "Nursing", "resume_field_of_study": "Nursing",
             "start": "09/2018", "end": "06/2022", "start_year": "2018", "end_year": "2022"},
            {"school": "George Brown College", "degree": "Diploma",
             "field_of_study_workday": "Practical Nursing", "start": "09/2016", "end": "06/2018",
             "start_year": "2016", "end_year": "2018"},
        ],
    }

    def table(self):
        return drafter.build_answer_table(self.PROFILE, self.APP)

    def test_a_citizenship_question_gets_the_citizenship(self):
        # THE DEFECT. `country` was matched by `^country|...`, anchored to the START of the label, so
        # "Country of citizenship" matched the RESIDENCE key and a US citizen declared Canadian
        # citizenship on a legal-eligibility control. On a right-to-work question that is not a
        # formatting mistake.
        table = self.table()
        for label in ("Country of citizenship", "What country are you a citizen of?",
                      "Citizenship status", "Country of Citizenship"):
            key, _ = drafter.pick_answer(label, table, "select")
            self.assertEqual(key, "citizenship", f"{label!r} did not reach the citizenship answer")
            self.assertEqual(table[key], "United States of America")

    def test_a_residence_question_still_gets_the_residence(self):
        # The other half: narrowing `country` must not cost it the questions it was written for.
        table = self.table()
        for label in ("Country of residence", "Country", "What country are you located in?",
                      "Country/Region"):
            key, _ = drafter.pick_answer(label, table, "select")
            self.assertEqual(key, "country", f"{label!r} no longer reaches the residence answer")
            self.assertEqual(table[key], "Canada")

    def test_an_unstated_citizenship_is_left_for_a_person(self):
        # Empty, like every other identity value here - not the residence country standing in for it.
        table = drafter.build_answer_table({"name": "X", "standing_answers": {}}, self.APP)
        self.assertEqual(table["citizenship"], "")

    def test_every_education_field_is_filled_without_a_masters(self):
        # THE OTHER DEFECT. `master`/`bachelor` were chosen by looking for "M.S." and "B.S." in the
        # degree text and every education key read one of them, so this applicant had school, degree,
        # field and both dates EMPTY - with a required School/Degree select on the form.
        table = self.table()
        self.assertEqual(table["school"], "Toronto Metropolitan University")
        self.assertEqual(table["degree"], "Bachelor's Degree")
        self.assertEqual(table["field"], "Nursing")
        self.assertEqual(table["degree_start_year"], "2018")
        self.assertEqual(table["degree_end_year"], "2022")
        # The second entry is the one that is not the first, whatever it is called.
        self.assertEqual(table["bachelor_school"], "George Brown College")

    def test_the_higher_degree_is_still_preferred_when_there_is_one(self):
        # The preference the two spellings were standing in for has to survive: a profile listing the
        # bachelor first still wants the master's on the School/Degree controls.
        app = dict(self.APP)
        app["education"] = [
            {"school": "Metropolitan Institute", "degree": "B.S.", "start_year": "2012",
             "end_year": "2016"},
            {"school": "Lakeside State University", "degree": "M.S.", "start_year": "2025",
             "end_year": "2026"},
        ]
        table = drafter.build_answer_table(self.PROFILE, app)
        self.assertEqual(table["school"], "Lakeside State University")
        self.assertEqual(table["degree"], "Master's Degree")
        self.assertEqual(table["bachelor_school"], "Metropolitan Institute")
        self.assertEqual(table["bachelor_degree"], "Bachelor's Degree")


class CurrentCompanyMustBeACurrentEmployerTest(unittest.TestCase):
    """`current_company` answered "Current Company" with an employer the person had already left.

    THE CASE THAT PAID FOR THIS. A greenhouse board, 2026-10-15, driven in a headless Chrome on the CDP port.
    The profile's owner had left the employer its `work_experience` lists first sixteen months earlier and had
    been a full-time master's student since. The drafter read `work_experience[0].company` - the first entry, on
    the assumption that a profile lists the present job first - and produced, in the spec the gate is written
    against:

        id:question_...   Current Company (optional) = <the employer the applicant had left>

    That is a claim of PRESENT EMPLOYMENT at a company the applicant no longer works for. It is worse than a
    blank, and it is INVISIBLE in `needs_review`: an auto-answered field is only listed when the drafter could
    not answer it, so the one field that says something false about the applicant is the one field the review
    list does not mention. It was found by reading the drafted spec field by field.

    A profile whose list starts with the CURRENT job keeps the old behaviour - that shape is why the
    assumption was written, and it is the common shape.
    """

    #: The role the profile lists first, and the one that produced the false statement. The employer is a
    #: PLACEHOLDER, not the real one: which company this happened at is a fact about a person's employment
    #: history, and the defect is about a DATE, not about a tenant. `PAST_ROLE` ends before "today" in the
    #: tests that pass a fixed `today`, which is the whole of what this fixture has to establish.
    PAST_ROLE = {"company": "Example Company One", "job_title": "Senior Software Engineer",
                 "from": "01/2025", "to": "06/2025"}

    def table(self, entries):
        return drafter.build_answer_table({"name": "Example Candidate"}, {"work_experience": list(entries)})

    def test_a_role_that_ended_in_the_past_is_not_the_current_employer(self):
        table = self.table([self.PAST_ROLE])
        self.assertEqual(table["current_company"], "",
                         "a role that ended in the past was drafted as the CURRENT employer")
        self.assertEqual(table["current_title"], "")

    def test_a_role_ending_this_month_or_later_is_still_current(self):
        # The boundary, in both directions, so the fix cannot be "always answer empty" - that would lose
        # the current employer of every applicant who is actually employed, which is most of them.
        today = datetime.date(2026, 10, 15)
        for end, expected in (("10/2026", True), ("11/2026", True), ("09/2026", False)):
            with self.subTest(end=end):
                entry = {"company": "Employer", "job_title": "Engineer", "to": end}
                self.assertEqual(drafter.role_is_current(entry, today), expected)

    def test_an_end_date_this_function_cannot_parse_is_not_evidence_the_role_ended(self):
        # The safe direction. A spelling it does not recognise keeps the old behaviour: worst case one
        # blank field a person fills in by hand, never an employer they have left.
        for unparsed in ("2027.03", "sometime next year", "Q1 2027"):
            with self.subTest(to=unparsed):
                self.assertTrue(drafter.role_is_current({"to": unparsed}, datetime.date(2026, 10, 15)))

    def test_an_open_ended_or_present_tense_role_stays_current(self):
        # These are the three ways a profile writes "still here", and none of them may clear the answer.
        for entry in ({"company": "E", "job_title": "T"},
                      {"company": "E", "job_title": "T", "to": ""},
                      {"company": "E", "job_title": "T", "to": "Present"},
                      {"company": "E", "job_title": "T", "to": "Current"}):
            with self.subTest(entry=entry.get("to", "<absent>")):
                table = self.table([entry])
                self.assertEqual(table["current_company"], "E")
                self.assertEqual(table["current_title"], "T")

    def test_a_student_with_no_current_employer_gets_a_blank_not_a_guess(self):
        # What the real form got after the fix: the first entry is a past role and the second is older
        # still, so no entry answers "Current Company" and the field is reported. A blank a person fills
        # in is the correct outcome; the failure this test prevents is the invented employer.
        entries = [
            self.PAST_ROLE,
            {"company": "Example Company Two", "job_title": "Senior Software Engineer",
             "from": "07/2020", "to": "01/2025"},
        ]
        table = self.table(entries)
        self.assertEqual(table["current_company"], "")
        self.assertEqual(table["current_title"], "")


class LocationTypeaheadDraftingTest(unittest.TestCase):
    """A place whose list does not exist until a query is typed is not described as an option list.

    THE CASE THAT PAID FOR THIS. greenhouse board, posting 8279799 (`Technical Support Specialist`), 2026-10-14,
    driven in a headless Chrome on port 9333. `Location (City)*` is `input#candidate-location`: a react-select
    combobox with `role="combobox"`, `aria-autocomplete="list"` and no listbox in the DOM until something is
    typed. The scanner's open pass read NO options for it while the same page's `Country*` control reported 244,
    so the drafter had nothing to resolve against, `resolve_option` handed the address straight back, and the spec
    asked the control for the option `Toronto, Ontario, Canada` - which it can never offer:

        step7_fill.log:10  FAIL select id:candidate-location  option not found: Toronto, Ontario, Canada

    The field is now drafted as what it is: the place to commit (the profile's own address), from which the query
    to type and the acceptance test a committed row must satisfy are both derived by
    `src/forms/location_place.mjs`. The inventory rows below are the live scan's own, trimmed to the fields that
    matter (the full row is `tmp/greenhouse_tss_fields.json` in the cold-start smoke run).
    """

    #: The phantom react-select `<input required aria-hidden class="…-requiredInput">` sits inside the same shell
    #: and reads as a second, ref-less react-select. The drafter never drafts a ref-less field, and it must not
    #: draft one of THESE as a typeahead either.
    LOCATION_ROW = {
        "ref": "id:candidate-location", "key": "id:candidate-location", "tag": "input", "type": "text",
        "role": "combobox", "react_select": True, "label": "Location (City)*", "help": "*", "required": True,
        "value": "", "option_group": "candidate-location", "group_label": "",
        "widget_evidence": {"selectControl": True, "selectedDisplay": False, "listbox": False, "toggle": False,
                            "nativeMultiple": False, "multiSelect": False},
        "options": [],
        "widget": {"kind": "react_select", "fingerprint": "widget/v1/react_select/standard", "options": [],
                   "optionsStatus": "not_observed", "verificationStatus": "observable"},
    }
    PHANTOM_ROW = {
        "ref": "", "key": "input:8", "tag": "input", "type": "", "role": "", "react_select": False,
        "label": "Location (City)*", "help": "*", "required": True, "value": "", "option_group": "",
        "group_label": "", "options": [],
        "widget_evidence": {"selectControl": True, "selectedDisplay": False, "listbox": False, "toggle": False},
        "widget": {"kind": "react_select", "fingerprint": "widget/v1/react_select/standard", "options": [],
                   "optionsStatus": "not_observed", "verificationStatus": "observable"},
    }

    def draft(self, fields):
        # The second copy of the helper above, and it leaked the same 16 directories: same prefix so the
        # guard can see it, same `addCleanup` so the removal does not depend on the test returning.
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="draft-spec-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        inventory = tmp / "fields.json"
        produced = tmp / "spec.json"
        inventory.write_text(json.dumps({"url": "https://job-boards.greenhouse.io/greenhouse/jobs/8279799",
                                         "fields": fields}), encoding="utf-8")
        with mock.patch.object(sys, "argv", ["draft_form_spec.py", str(inventory), "--out", str(produced)]), \
                contextlib.redirect_stdout(io.StringIO()):
            drafter.main()
        review = json.loads(produced.with_name(produced.stem + ".needs_review.json").read_text(encoding="utf-8"))
        return json.loads(produced.read_text(encoding="utf-8")), review["needs_review"]

    def profile_address(self) -> dict:
        """The address the drafter itself will read, so this test holds for any configuration.

        Read straight from the profile and NOT through the module under test: a test that needed a helper to exist
        before it could report that the helper's OUTPUT is wrong would error instead of failing, and the failure
        message is the half that tells the next reader what broke. Hardcoding "Springfield, Illinois, United States
        of America" would be worse still - it would pass only on the shipped examples, and the run that matters is
        the one against a real profile.
        """
        app = json.loads((drafter.DATA_DIR / "application_profile.json").read_text(encoding="utf-8"))
        address = (app.get("candidate") or {}).get("address") or {}
        return {k: str(address.get(k) or "").strip() for k in ("city", "state", "country")}

    def test_the_live_location_control_is_drafted_as_a_typeahead(self):
        spec, review = self.draft([dict(self.LOCATION_ROW)])
        parts = self.profile_address()
        self.assertEqual(len(spec["selects"]), 1)
        entry = spec["selects"][0]
        self.assertEqual(entry["ref"], "id:candidate-location")
        self.assertIn("typeahead", entry,
                      "a place picker whose list does not exist yet must be described as a typeahead, not as an "
                      "option list - the option it was described with could never be offered")
        self.assertEqual(entry.get("typeahead"), parts,
                         "the entry must carry the address PARTS the place rule derives the query from")
        self.assertEqual(entry["option"], ", ".join(p for p in (parts["city"], parts["state"], parts["country"]) if p))
        self.assertIn("typeahead", entry["note"])
        self.assertEqual(review, [], "a drafted typeahead is not a gap - it must not be listed for review")

    def test_a_place_on_a_fixed_list_keeps_the_ordinary_option_path(self):
        # The same question and the same place on a control that DID report its list: the field is an option
        # again, and `option not found` is then the right outcome if the place is not on the tenant's list.
        parts = self.profile_address()
        place = ", ".join(p for p in (parts["city"], parts["state"], parts["country"]) if p)
        row = dict(self.LOCATION_ROW)
        row["options"] = [place, "Somewhere Else, Nowhere"]
        row["widget"] = dict(self.LOCATION_ROW["widget"], options=row["options"], optionsStatus="observed")
        spec, _ = self.draft([row])
        self.assertEqual(len(spec["selects"]), 1)
        self.assertNotIn("typeahead", spec["selects"][0])
        self.assertEqual(spec["selects"][0]["option"], place)

    def test_a_question_that_is_not_the_profile_place_is_untouched(self):
        # The rule must not swallow every option-less control on the page: the same shape with a question the
        # profile does not answer stays exactly as it was (here: an unanswered question, so it is reported).
        row = dict(self.LOCATION_ROW)
        row["ref"], row["key"] = "id:question_1", "id:question_1"
        row["label"] = "Do you like pineapples on pizza?*"
        spec, review = self.draft([row])
        self.assertEqual([s for s in spec["selects"] if "typeahead" in s], [])
        self.assertEqual(len(review), 1)

    def test_a_preference_is_not_drafted_as_the_home_address(self):
        # `desired_location` answers "preferred work location" from a ranked preference list. It is a place, but
        # it is not the address, and typing it into a control as if it were the home address is a claim about the
        # candidate that the profile did not make: the rule fires on the ANSWER matching the profile's joined
        # address, not on the answer merely looking like a place.
        row = dict(self.LOCATION_ROW)
        row["ref"], row["key"] = "id:preferred", "id:preferred"
        row["label"] = "Which office would you work from?*"
        spec, _ = self.draft([row])
        for entry in spec["selects"]:
            self.assertNotIn("typeahead", entry)

    def test_the_ref_less_phantom_control_is_never_drafted(self):
        # The live page carries a second, ref-less react-select inside the same shell (react-select's own
        # `requiredInput`), and it reads on the scan as a second `Location (City)*` with no options. It has no ref
        # to type into, so it must be skipped - and it must not be reported as a gap for a person either, which is
        # the behaviour it already had.
        spec, review = self.draft([dict(self.PHANTOM_ROW), dict(self.LOCATION_ROW)])
        self.assertEqual([s["ref"] for s in spec["selects"]], ["id:candidate-location"])
        self.assertEqual(review, [])


if __name__ == "__main__":
    unittest.main()
