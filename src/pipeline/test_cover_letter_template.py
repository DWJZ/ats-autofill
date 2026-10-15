#!/usr/bin/env python3
"""Tests for the cover-letter template and its two guards.

Every cover letter this project sent before this file was written ad hoc, which made each one a fresh chance to state
something unbacked. The template fixes half of that (the sentences are fixed) and the module fixes the other half (the
facts are filled by name from canonical data). These tests are what stops either half from drifting back.

THREE OF THEM COME FROM MISTAKES MADE WHILE BUILDING IT, and those are the ones worth having:

  1. THE BANNED-TERM CHECK MUST BE WORD-BOUNDED. The first version used `term.lower() in haystack` and reported `Java`
     inside the word **JavaScript** - a confirmed skill, and the language the candidate actually writes. `Java` is in
     `do_not_claim`; `JavaScript` is not a claim about Java. A guard that fires on a legitimate skill gets switched
     off rather than fixed, so this test asserts the boundary from both sides.
  2. A PLACEHOLDER WITH NO FACT MUST RAISE, not render a hole. The first render failed on `phone` and `city_state`
     because the contact block is in application_profile.json, not candidate_profile.json - and the failure is the
     reason that letter never went out saying "I am based in ."
  3. SKILLS AND METRICS ARE NOT ZIPPED. The first template paired `skill_1` with `metric_1` and produced "**Go** - 8+
     years of software engineering experience". Both values were true and the sentence was still a claim nobody made.
  4. THE DEGREE IN THE OPENING SENTENCE COMES FROM THE PROFILE. It used to be a literal "I am finishing an M.S. at
     {{school}}" filled from `next((e for e in edu if "M.S." in e["degree"]), edu[0])`: for anyone without a master's
     the fallback fired and the letter said *"I am finishing an M.S. at Toronto Metropolitan University"* on behalf of
     a registered nurse whose only degree from that school is a B.Sc.N. `summary_guard` and `do_not_claim` cannot see
     this one - it is a literal in a template, not a claim in a profile - so the assertion has to be structural:
     nothing the template says about education may be a degree the profile does not hold.

THE ROLE NAME IN THESE TESTS IS DELIBERATELY NEUTRAL, and that is a fix of its own. They used
`"Software Engineer I"`, and a person whose `do_not_claim` legitimately names software engineering - a nurse, a
lawyer, anyone in another field - could not pass the banned-term test with that literal in it. A test that only
passes for one profession is a test the next configuration has to edit instead of obey. The role is an argument the
builder echoes back now, so the fixture no longer picks a profession at all.
"""
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "pipeline"))
sys.path.insert(0, str(ROOT / "src"))

from cover_letter_template import (  # noqa: E402
    OPTIONAL_PLACEHOLDERS,
    TemplateError,
    build_context,
    check_no_banned_terms,
    render,
)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

TEMPLATE = (DATA_DIR / "cover_letter" / "template.txt").read_text(encoding="utf-8")
PROFILE = json.loads((DATA_DIR / "candidate_profile.json").read_text(encoding="utf-8"))
APP = json.loads((DATA_DIR / "application_profile.json").read_text(encoding="utf-8"))

#: A job title that belongs to no field in particular. See the module docstring: the role is data the builder only
#: echoes back, so naming a profession here is what made this file unusable for anybody outside software.
ROLE = "Staff Nurse"
COMPANY = "Twitch"


class TemplateRendersTest(unittest.TestCase):
    def test_the_template_renders_against_real_canonical_data(self):
        # If a fact the template needs is not in canonical data, this is where it shows up - not in a letter that has
        # already gone to an employer.
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        out = render(TEMPLATE, ctx)
        self.assertIn(f"{COMPANY} Hiring Team", out)
        self.assertIn(ROLE, out)
        self.assertIn(ctx["name"], out)
        self.assertNotIn("{{", out, "a placeholder survived into the letter")

    def test_every_placeholder_in_the_template_is_one_the_context_provides(self):
        # The two must not drift: a template edit that adds `{{salary}}` must fail here, not at render time in a round
        # where someone is in a hurry.
        import re

        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        used = set(re.findall(r"\{\{([a-z0-9_]+)\}\}", TEMPLATE))
        self.assertTrue(used, "the template has no placeholders - is it still a template?")
        self.assertEqual(
            sorted(u for u in used if u not in ctx), [],
            "the template asks for facts build_context does not provide",
        )


class MissingFactTest(unittest.TestCase):
    def test_a_placeholder_with_no_fact_raises_instead_of_rendering_a_hole(self):
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        del ctx["phone"]
        with self.assertRaises(TemplateError) as e:
            render(TEMPLATE, ctx)
        self.assertIn("phone", str(e.exception))

    def test_an_empty_fact_counts_as_missing(self):
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        ctx["company"] = "   "
        with self.assertRaises(TemplateError):
            render(TEMPLATE, ctx)


class DegreeComesFromTheProfileTest(unittest.TestCase):
    """DEFECT: THE LETTER STATED A DEGREE THE APPLICANT DOES NOT HOLD.

    `examples/cover_letter_template.example.txt:5` - the file `setup-examples.sh` copies to
    `data/cover_letter/template.txt` - said "I am finishing an M.S. at {{school}}", and `build_context` filled
    `{{school}}` from `next((e for e in edu if "M.S." in e["degree"]), edu[0] if edu else {})`. Rendered for Łukasz
    Żółkiewski - a registered nurse in Toronto with a B.Sc.N. from Toronto Metropolitan University and no master's -
    the printed sentence was:

        I am applying for the Registered Nurse, Emergency Department role. I am finishing an M.S. at Toronto
        Metropolitan University, and I have 9 years of acute care nursing experience ...

    Every fact in it came from canonical data, which is exactly why `summary_guard.py` and `do_not_claim` did not
    catch it: the falsehood was a literal in the template, and the lookup only supplied the school. These assertions
    are structural for that reason - they test the SHAPE of what the template claims about education, not one string.
    """

    #: A profile that holds a bachelor's degree and nothing above it, in the shape `build_context` reads.
    BACHELOR_ONLY = {
        "candidate": {"name": "Test Person"},
        "confirmed_skills": ["Triage"],
        "safe_metrics": ["9 years of acute care nursing experience"],
    }
    BACHELOR_ONLY_APP = {
        "candidate": {
            "email": "person@example.com",
            "phone": {"formatted": "+1 416 555 0182"},
            "address": {"city": "Toronto", "state": "Ontario"},
        },
        "education": [{"school": "Toronto Metropolitan University", "degree": "B.Sc.N.",
                       "resume_degree": "B.Sc.N. in Nursing", "status": "completed",
                       "resume_date": "Jun 2014"}],
    }
    MASTERS_STILL_IN_SCHOOL = {
        "candidate": {"name": "Test Person"},
        "confirmed_skills": ["Go"],
        "safe_metrics": ["9+ years of software engineering experience"],
    }
    MASTERS_STILL_IN_SCHOOL_APP = {
        "candidate": {
            "email": "person@example.com",
            "phone": {"formatted": "+1 555 0100"},
            "address": {"city": "Springfield", "state": "Illinois"},
        },
        "education": [{"school": "Lakeside State University", "degree": "M.S.",
                       "resume_degree": "M.S. in Example Field of Study", "status": "expected",
                       "resume_date": "Expected May 2026"},
                      {"school": "Metropolitan Institute of Technology", "degree": "B.S.",
                       "resume_degree": "B.S. in Example Field of Study", "status": "completed",
                       "resume_date": "Jun 2015"}],
    }

    def context(self, profile, app):
        return build_context(profile, app, COMPANY, ROLE)

    def test_the_degree_in_the_letter_is_the_one_the_profile_holds(self):
        # The incident: a B.Sc.N. holder, and a lookup that went looking for a master's degree.
        ctx = self.context(self.BACHELOR_ONLY, self.BACHELOR_ONLY_APP)
        self.assertEqual(ctx["degree"], "B.Sc.N. in Nursing")
        self.assertEqual(ctx["school"], "Toronto Metropolitan University")

    def test_the_template_asserts_no_degree_of_its_own(self):
        # THE STRUCTURAL HALF. No shipped template may name a degree: the degree is a fact about the person, and a
        # template is the one file that cannot know it. A later edit that writes "M.S." (or "B.S.", or "Ph.D.") back
        # into the wording fails here rather than in somebody's letter.
        example = (ROOT / "examples" / "cover_letter_template.example.txt").read_text(encoding="utf-8")
        self.assertIn("{{degree}}", example, "the template must take the degree from the profile")
        for literal in ("M.S.", "B.S.", "Ph.D.", "master's", "Master's"):
            self.assertNotIn(literal, example, f"the template asserts {literal!r} about the applicant")

    def test_a_bachelor_only_applicant_never_reads_as_a_masters_student(self):
        # What the letter SAID, against what the profile says. The old wording rendered from a template that had the
        # literal, so the assertion is made against the shipped example template here - the same file
        # `setup-examples.sh` installs - and not against a copy this test wrote for itself.
        example = (ROOT / "examples" / "cover_letter_template.example.txt").read_text(encoding="utf-8")
        out = render(example, self.context(self.BACHELOR_ONLY, self.BACHELOR_ONLY_APP))
        self.assertNotIn("M.S.", out)
        self.assertIn("B.Sc.N. in Nursing", out)
        self.assertIn("Toronto Metropolitan University", out)

    def test_study_still_in_progress_is_described_in_the_present_tense(self):
        # The one preference worth keeping out of the old lookup, and it is not a preference for a DEGREE: a person
        # mid-degree is introduced by the degree they are finishing even when the profile lists a finished one too.
        ctx = self.context(self.MASTERS_STILL_IN_SCHOOL, self.MASTERS_STILL_IN_SCHOOL_APP)
        self.assertEqual(ctx["degree"], "M.S. in Example Field of Study")
        self.assertEqual(ctx["school"], "Lakeside State University")

    def test_a_finished_degree_is_not_described_as_being_finished(self):
        # A completed entry must not be read as in progress either: `status: completed` is the profile saying so.
        ctx = self.context(self.BACHELOR_ONLY, self.BACHELOR_ONLY_APP)
        self.assertEqual(ctx["school"], "Toronto Metropolitan University")

    def test_the_article_matches_the_degree_phrase(self):
        # "I am {{article}} {{degree}}" has to read as English for every branch: "an M.S.", "a B.Sc.N.".
        self.assertEqual(self.context(self.BACHELOR_ONLY, self.BACHELOR_ONLY_APP)["article"], "a")
        self.assertEqual(self.context(self.MASTERS_STILL_IN_SCHOOL, self.MASTERS_STILL_IN_SCHOOL_APP)["article"], "an")

    def test_a_profile_with_no_education_refuses_rather_than_inventing_one(self):
        # The other direction: the guard must not be softened into a sentence with a hole in it. No education entry
        # means no degree fact, which is a refusal - never "I am a  from .".
        app = dict(self.BACHELOR_ONLY_APP, education=[])
        with self.assertRaises(TemplateError) as e:
            render("I am {{article}} {{degree}} from {{school}}.", self.context(self.BACHELOR_ONLY, app))
        self.assertIn("degree", str(e.exception))


class OptionalFactTest(unittest.TestCase):
    """The other half of the same guard: an OPTIONAL fact may be empty, and a particular person has to be able to get
    a letter. The people this project writes for are not all on LinkedIn - the second profile used to test this toolkit
    is a registered nurse with no LinkedIn and no GitHub - and `the template needs facts that canonical data does not
    provide: ['linkedin']` was the error a letter died on for them. The fix was NOT to weaken the guard: a required
    fact that is missing still raises (see MissingFactTest). It was to say which two placeholders are a fact about
    whether the person has an account rather than a fact about the data."""

    def test_a_person_without_linkedin_or_github_gets_a_letter(self):
        template = "Dear {{company}},\nI am {{name}}.\n{{email}} · {{phone}}{{linkedin}}{{github}}\n"
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        ctx["linkedin"] = ""
        ctx["github"] = ""
        out = render(template, ctx)
        self.assertIn(ctx["name"], out)
        self.assertNotIn("{{", out)

    def test_an_optional_placeholder_that_is_absent_is_not_a_missing_fact(self):
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        ctx.pop("linkedin")
        out = render("{{name}} · {{linkedin}}", ctx)
        self.assertEqual(out, f"{ctx['name']} · ")

    def test_a_required_placeholder_is_still_required(self):
        # The distinction is the whole reason OPTIONAL_PLACEHOLDERS exists; a fix that made every placeholder optional
        # would delete the guard the suite above tests.
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        ctx["email"] = ""
        with self.assertRaises(TemplateError) as e:
            render("{{name}} - {{email}}", ctx)
        self.assertIn("email", str(e.exception))

    def test_the_optional_set_names_the_two_accounts_a_person_may_not_have(self):
        # Named one by one on purpose - a set that grows without being read is how the guard gets weakened by
        # accident. These two are the only facts in the context whose absence is a fact about the PERSON.
        self.assertEqual(OPTIONAL_PLACEHOLDERS, frozenset({"linkedin", "github"}))


class BannedTermTest(unittest.TestCase):
    def test_java_inside_javascript_is_not_a_claim_about_java(self):
        # THE BUG THIS FILE EXISTS FOR. A confirmed skill and a banned term, one inside the other.
        check_no_banned_terms("I write JavaScript and TypeScript daily.", ["Java"])  # must not raise

    def test_a_real_java_claim_is_still_caught(self):
        for text in ("I have five years of Java.", "Java, Spring Boot and Kafka.", "experience: java"):
            with self.assertRaises(TemplateError, msg=text):
                check_no_banned_terms(text, ["Java"])

    def test_the_plus_and_hash_boundaries_hold(self):
        # `bounded_contains` carries `+#` in its boundaries for exactly this. Note what the first draft of this test
        # got wrong: it asserted that "I used C and C++ together." does not claim C - but that sentence names C on its
        # own, so the guard was right and the assertion was wrong. The question the boundaries answer is whether
        # `C++` alone trips a ban on `C`.
        check_no_banned_terms("I used C++ in production.", ["C"])       # must not raise
        check_no_banned_terms("I have written C# services.", ["C"])      # must not raise
        with self.assertRaises(TemplateError):
            check_no_banned_terms("I used C++ in production.", ["C++"])
        with self.assertRaises(TemplateError):
            check_no_banned_terms("C and Python together.", ["C"])       # a real claim on C is still caught

    def test_the_real_letter_passes_the_real_list(self):
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        check_no_banned_terms(render(TEMPLATE, ctx), PROFILE.get("do_not_claim"))


class SkillsAndMetricsAreNotPairedTest(unittest.TestCase):
    def test_a_skill_is_never_rendered_next_to_an_unrelated_metric(self):
        # The first template zipped the two lists together and rendered a skill next to a figure as if the data
        # said they belonged together. The relationship was invented: nothing in the data pairs an achievement
        # with a skill.
        #
        # The assertion is about the PAIRING, not about co-occurrence. A metric in the opening sentence ("I have 8+
        # years ...") is a fact stated once; the failure being pinned is a line that JOINS a skill to a metric with a
        # dash, which is what asserts the relationship. The first draft of this test flagged the opening sentence too,
        # and a test that cannot tell those apart would be deleted rather than obeyed.
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        out = render(TEMPLATE, ctx)
        skills = [s.strip().lower() for s in ctx["skills_line"].split(",") if s.strip()]
        metrics = [m for m in (PROFILE.get("safe_metrics") or []) if isinstance(m, str)]
        for line in out.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            has_skill = any(s and s in stripped.lower() for s in skills)
            has_metric = any(m in stripped for m in metrics)
            paired = has_skill and has_metric and (" - " in stripped or " — " in stripped)
            self.assertFalse(paired, f"a skill was paired with an unrelated metric: {line!r}")

    def test_the_context_exposes_the_two_lists_separately(self):
        ctx = build_context(PROFILE, APP, COMPANY, ROLE)
        self.assertIn("skills_line", ctx)
        self.assertIn("metrics_lines", ctx)
        self.assertNotIn("skill_1", ctx, "the zipped placeholders are back")
        self.assertNotIn("metric_1", ctx, "the zipped placeholders are back")


if __name__ == "__main__":
    unittest.main()
