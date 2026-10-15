#!/usr/bin/env python3
"""Tests for build_cover_letter.py and for the resume's education block.

THREE DEFECTS, each one a sentence the toolkit stated about an applicant that the applicant's own
profile did not say. None of them is visible in the canonical example, which is the fictional person
every example file describes - a master's degree, a LinkedIn, a GitHub, an ASCII name - so the
fixtures below are built to be somebody else:

  * Łukasz Żółkiewski, a registered nurse in Toronto. B.Sc.N. only, no master's; no LinkedIn; no
    GitHub; a name with two diacritics in it.

1. ONE APPLICATION, TWO FILE STEMS. `letter_stem` built its words with `re.findall(r"[A-Za-z0-9]+")`
   while the resume's stem comes from `slugify` in generate_tailored_resume.py. For Łukasz the pair was

       resume:  Łukasz_Żółkiewski_Toronto_General_Hospital_..._Resume.docx
       letter:  Ukasz_Kiewski_Toronto_General_Hospital_..._Cover_Letter.docx

   - the same application filed under two different people's names, because the ASCII filter dropped
   exactly the letters that make `Łukasz Żółkiewski` his name. A name in Chinese came out as `_X_Y`.
   The test asserts the two stems agree, so it fails for any future tokenizer that is not the one
   naming the candidate.

2. AN ABSENT OPTIONAL KEY CRASHED THE LETTER. `candidate['github'].replace(...)` raised on a profile
   without a GitHub account - the normal state for most applicants - and `candidate['linkedin']` did
   the same for the contact line. Both are folded to `""` the way every other optional fact in this
   project is (`IDENTITY` in src/forms/ashby_finish_form.mjs, `greenhouse_scaffold` in the pipeline).
   With the keys PRESENT the letter then died on an unresolved `{{linkedin}}`, which is the template
   guard doing its job - and the fix for that half was in the template, not in the guard (see
   test_cover_letter_template.py's OptionalFactTest).

3. THE EDUCATION SECTION. `build_resume.build` guards the EDUCATION block with `if master.get(...)`.
   The claim under test is the one that matters to the person reading their own resume: an applicant
   who holds a bachelor's degree and no master's gets their education printed. It is asserted for the
   degree they hold, in the shape their profile actually has it, and for a profile whose entries are
   missing the `resume_*` display keys - none of which may empty the section.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src" / "pipeline"))
sys.path.insert(0, str(ROOT / "src"))

import build_resume  # noqa: E402
from build_cover_letter import contact_lines, contact_value, letter_stem  # noqa: E402
from generate_tailored_resume import slugify  # noqa: E402

from src.paths import DATA_DIR  # noqa: E402


def resume_stem(name: str, company: str, role: str) -> str:
    """The stem the resume is built with, taken from generate_tailored_resume.py's own default."""
    return f"{slugify(name)}_{slugify(company)}_{slugify(role)}_Resume"


def applicant_part(stem: str) -> str:
    """Everything in a stem except the `_Resume` / `_Cover_Letter` suffix that tells the two documents apart.

    That suffix is the one difference that is SUPPOSED to be there - it is how a reader tells the letter from the
    resume - so the equality being asserted is over the part that names the application.
    """
    for suffix in ("_Cover_Letter", "_Resume"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    raise AssertionError(f"stem carries no document suffix: {stem!r}")


COMPANY = "Toronto General Hospital"
ROLE = "Registered Nurse, Emergency Department"


class OneApplicationTwoStemsTest(unittest.TestCase):
    def test_the_letter_and_the_resume_are_filed_under_the_same_name(self):
        # The incident, in the words of the file names it produced:
        #     resume:  Łukasz_Żółkiewski_Toronto_General_Hospital_..._Resume.docx
        #     letter:  Ukasz_Kiewski_Toronto_General_Hospital_..._Cover_Letter.docx
        name = "Łukasz Żółkiewski"
        self.assertEqual(
            applicant_part(letter_stem(name, COMPANY, ROLE)),
            applicant_part(resume_stem(name, COMPANY, ROLE)),
        )

    def test_the_stem_keeps_the_name_the_person_is_called(self):
        self.assertTrue(letter_stem("Łukasz Żółkiewski", COMPANY, ROLE).startswith("Łukasz_Żółkiewski"))

    def test_a_name_that_is_not_written_in_latin_letters_still_names_the_file(self):
        # `re.findall(r"[A-Za-z0-9]+")` produced `_Toronto_General_Hospital_...` for this person: a file named after
        # nobody. `slugify` keeps the name, and the two must still agree.
        name = "张 伟"
        stem = letter_stem(name, COMPANY, ROLE)
        self.assertTrue(stem.startswith("张_伟_"), stem)
        self.assertEqual(applicant_part(stem), applicant_part(resume_stem(name, COMPANY, ROLE)))

    def test_a_company_name_is_split_the_same_way_as_the_resume_splits_it(self):
        # The other half of the same disagreement: "Électricité de France" was `..._De_France_...` for the letter and
        # `..._de_France_...` for the resume, because one side capitalised every word and the other did not.
        for company in ("Toronto General Hospital", "ClickHouse", "3M", "Électricité de France", "Acme: Inc."):
            self.assertEqual(
                applicant_part(letter_stem("Test Person", company, ROLE)),
                applicant_part(resume_stem("Test Person", company, ROLE)),
                f"the two documents disagree about {company!r}",
            )

    def test_the_stem_carries_no_path_separator_or_reserved_character(self):
        # WHY `\w` AND NOTHING LOOSER. The stem was already the candidate's own name before this fix, so the tokenizer
        # is also the sanitizer: a role written "Senior/Staff Engineer, Applied AI" must not put a `/` in a filename,
        # and a company with a colon in it must not produce a name macOS rewrites for you.
        stem = letter_stem("Test Person", "Acme: Inc.", "Senior/Staff Engineer, Applied AI (Remote)")
        for bad in ("/", "\\", ":", "*", "?", '"', "<", ">", "|", "."):
            self.assertNotIn(bad, stem, f"{bad!r} in a filename: {stem!r}")
        self.assertTrue(stem.endswith("_Cover_Letter"))


class OptionalContactKeyTest(unittest.TestCase):
    """The absent-key half of the contact block, tested on the shapes the profiles actually have."""

    def test_a_missing_github_key_reads_as_empty_and_not_as_an_error(self):
        # The incident: `candidate['github'].replace('https://', '')` on a profile with no github key raised
        # KeyError/AttributeError before a word of the letter was rendered.
        self.assertEqual(contact_value({"linkedin": "https://linkedin.com/in/x"}, "github"), "")

    def test_an_empty_value_reads_the_same_as_a_missing_key(self):
        # Both are the same fact about the person, and the code must not tell them apart - the empty string is what a
        # profile holds when its author filled the field in and had nothing to put in it.
        self.assertEqual(contact_value({"github": ""}, "github"), contact_value({}, "github"))

    def test_a_present_value_is_returned(self):
        self.assertEqual(contact_value({"github": "https://github.com/x"}, "github"), "https://github.com/x")

    def test_the_contact_block_of_a_person_without_accounts_has_no_empty_segment(self):
        # The rendered header, from the pieces this person really has. A leftover " | " is the header claiming a link
        # that is not there, and this is the exact profile shape that used to raise instead of printing.
        lines = contact_lines({
            "address": {"city": "Toronto", "state": "Ontario"},
            "email": "person@example.com",
            "phone": {"formatted": "+1 416 555 0182"},
            "linkedin": "",
            "github": "",
        })
        self.assertEqual(lines, ["Toronto, Ontario | person@example.com | +1 416 555 0182"])
        for line in lines:
            self.assertFalse(line.strip().endswith("|"), line)
            self.assertNotIn("|  |", line)

    def test_the_contact_block_drops_the_keys_the_profile_does_not_have_at_all(self):
        # Same assertion with the keys REMOVED rather than emptied - the state a profile is in when its author never
        # had the account and never wrote the field. `contact_value` is what makes the two states one.
        lines = contact_lines({
            "address": {"city": "Toronto", "state": "Ontario"},
            "email": "person@example.com",
            "phone": {"formatted": "+1 416 555 0182"},
        })
        self.assertEqual(lines, ["Toronto, Ontario | person@example.com | +1 416 555 0182"])

    def test_the_contact_block_still_prints_the_accounts_a_person_does_have(self):
        # The other direction, so the fix cannot degenerate into printing nothing.
        lines = contact_lines({
            "address": {"city": "Springfield", "state": "Illinois"},
            "email": "person@example.com",
            "phone": {"formatted": "+1 555 0100"},
            "linkedin": "https://www.linkedin.com/in/example-candidate",
            "github": "https://github.com/example",
        })
        self.assertEqual(lines, [
            "Springfield, Illinois | person@example.com | +1 555 0100",
            "https://www.linkedin.com/in/example-candidate | github.com/example",
        ])


class EducationSectionTest(unittest.TestCase):
    """The resume prints an education section whenever the profile holds education.

    IT NEEDS A MASTER DOCX, SO IT SKIPS WITHOUT ONE. `build_resume` is template-driven and stops with
    "Master resume template not found" when none is installed - the normal state of a checkout that has
    run `scripts/setup-examples.sh` and not `make_master_resume.py`. Erroring there would make the
    README's "a plain `npm test` reports OK (skipped=22)" false, and would read as a broken test rather
    than an unconfigured one. `npm run test:contract` generates the template and runs all five.
    """

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
        from src.pipeline import build_resume
        if not build_resume.TEMPLATE.is_file():
            raise unittest.SkipTest(
                f"no master resume template at {build_resume.TEMPLATE} - run "
                f"`python3 src/pipeline/make_master_resume.py`, or use `npm run test:contract`, "
                f"which generates one for the run")

    """The resume's EDUCATION block, for a profile whose degree is not a master's.

    The guard is `if master.get('education')` at src/pipeline/build_resume.py:281, where `master` is the whole resume
    view built by `load_master` - `education` is the list of education entries the profile holds, turned into the four
    fields the layout prints. What must never happen is the section disappearing for somebody who holds a degree, and
    the shapes that could plausibly do it are the ones asserted here: a bachelor's-only profile, a diploma-only
    profile, and entries that are missing the `resume_*` display keys.
    """

    BACHELOR_AND_DIPLOMA = [
        {"school": "Toronto Metropolitan University", "degree": "B.Sc.N.",
         "resume_degree": "B.Sc.N. in Nursing", "resume_location": "Toronto, Ontario",
         "resume_date": "Jun 2014", "status": "completed"},
        {"school": "George Brown College", "degree": "Diploma",
         "resume_degree": "Diploma in Practical Nursing", "resume_location": "Toronto, Ontario",
         "resume_date": "Jun 2010", "status": "completed"},
    ]

    def profile(self, education, *, drop_key: bool = False) -> pathlib.Path:
        """The application profile as a file on disk, which is what `load_master` opens.

        Written into a fresh temporary directory rather than a fixed path: two test runners in the same checkout -
        which is what this repository looks like while several agents work in it - must not share a fixture file.
        """
        directory = pathlib.Path(tempfile.mkdtemp(prefix="cover-letter-education-"))
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        path = directory / "application_profile.json"
        profile = {"candidate": {"name": "Test Person", "resume_contact_lines": []},
                   "resume": {"summary": "I am a test person.", "skills": []},
                   "work_experience": [], "projects": []}
        if not drop_key:
            profile["education"] = education
        path.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
        return path

    def rendered(self, education, *, drop_key: bool = False) -> list[str]:
        master = build_resume.load_master(self.profile(education, drop_key=drop_key))
        return [p.text for p in build_resume.build(master, None).paragraphs if p.text.strip()]

    def test_a_bachelors_degree_alone_still_prints_the_education_section(self):
        # THE INCIDENT. The applicant holds a B.Sc.N. and no master's; their resume must not lose the section that
        # says so. Assert the DEGREE is on the page, not merely the heading - a heading over nothing is the same
        # defect wearing a different hat.
        text = "\n".join(self.rendered(self.BACHELOR_AND_DIPLOMA))
        self.assertIn("EDUCATION", text)
        self.assertIn("B.Sc.N. in Nursing", text)
        self.assertIn("Toronto Metropolitan University", text)

    def test_the_higher_degree_leads_when_the_profile_holds_two(self):
        # The layout's own preference, kept: whichever entry the profile puts first leads the section, so a master's
        # holder sees the master's first. Nothing here searches for a degree by name - the profile's order decides.
        text = "\n".join(self.rendered(self.BACHELOR_AND_DIPLOMA))
        self.assertLess(text.index("Toronto Metropolitan University"), text.index("George Brown College"))

    def test_a_profile_whose_entries_lack_the_resume_display_keys_still_prints(self):
        # The `resume_*` keys are display overrides; an entry without them still has a school and a degree to print.
        # `load_master` falls back to `degree`, so the section must render with those values and not with blanks.
        entries = [{k: v for k, v in entry.items() if not k.startswith("resume_")}
                   for entry in self.BACHELOR_AND_DIPLOMA]
        text = "\n".join(self.rendered(entries))
        self.assertIn("EDUCATION", text)
        self.assertIn("B.Sc.N.", text)

    def test_a_diploma_with_no_degree_beside_it_still_prints(self):
        text = "\n".join(self.rendered(self.BACHELOR_AND_DIPLOMA[1:]))
        self.assertIn("EDUCATION", text)
        self.assertIn("Diploma in Practical Nursing", text)

    def test_no_education_in_the_profile_prints_no_education_section(self):
        # The guard's real job, and the only case where dropping the section is right: an empty section heading is a
        # claim that the applicant listed no education, which is a different statement from "the profile holds none".
        text = "\n".join(self.rendered([]))
        self.assertNotIn("EDUCATION", text)


if __name__ == "__main__":
    unittest.main()
