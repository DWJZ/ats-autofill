#!/usr/bin/env python3
"""Regression tests for the option resolver in draft_form_spec.py.

The resolver once mapped "Male" onto the tenant option "Transgender woman", because it matched
the substring "man" inside "wo-man". These tests pin the word-boundary behaviour.
"""
import contextlib
import importlib.util
import io
import json
import pathlib
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
        tmp = pathlib.Path(tempfile.mkdtemp())
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


if __name__ == "__main__":
    unittest.main()
