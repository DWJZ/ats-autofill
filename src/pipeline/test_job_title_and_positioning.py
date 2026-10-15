#!/usr/bin/env python3
"""Four things `job_app_assistant.py` decided with literals of its own: the title, the advice, the
header title, and the skill lines.

WHY THIS FILE IS NOT `test_screen_patterns.py`. That file is the home of screening patterns - rows in a
table of titles and what the gates do with them - and none of these four is a screen: one extracts a
title out of a JD, one prints positioning advice for the reader, one resolves the line that goes under
the candidate's name, and one picks the lines that go into the resume's Core Skills section. All four
choose words for one person out of the module the tool actually runs, and the harness here is that
module.

CASE ONE, THE TITLE. `infer_title` fell back on three software phrases ("software engineer", "backend
engineer", "full[- ]stack engineer") when a posting carried no title markup, so a nursing or legal JD
extracted nothing and came back `"Unknown role"`. That is not a cosmetic string: `tailor_resume` takes
`args.role or analysis.title`, so it names the generated `..._profile.json` and the output DOCX, and
`append_tailor_tracker` writes it into the tracker as the title of the application. The words now come
from `title_phrases`, the same field configuration the screening gates on.

CASE TWO, THE POSITIONING. `positioning_for_track` was `if track == "ai_application": ... if track ==
"fullstack": ...` and an else-branch carrying a third paragraph, so a profile with a track called
"bedside" or "litigation" was advised to position itself as an experienced backend engineer with Go,
Redis and Kubernetes. It is the same defect as the `"backend"` fallback this module already fixed in
`default_track_for`, one field further out: the words belong to the profile, and a track that records
none says so rather than borrowing another person's.

CASE THREE, THE HEADER TITLE. `tailor_resume` resolved the line under the candidate's name as
`track_config.get("default_header_title", "Software Engineer")` and then overwrote even a profile's own
value with a second literal - `"Staff Software Engineer | Backend Platform & Data Integration"` -
whenever the role contained "staff" on the profile's ordinary track. So a nurse, a lawyer or a teacher
was handed a job title they do not hold, and an engineer applying to a staff posting was handed a
seniority and a specialisation their profile never claimed. The header is now the profile's
`default_header_title`, or the posting's own title, or a sentence saying neither supplied one; a run
that used to print the literal prints that sentence instead, which is the one behaviour this file
expects to differ from a checkout that came before it. NOTE WHERE THE VALUE GOES, because it changes
what has to be asserted: nothing writes it into a document, so the console is the whole artifact, and
the test below reads the printed line rather than a DOCX paragraph.

CASE FOUR, THE SKILL LINES. `skill_lines_for_tailor` held six skill lines of one person's career and
branched on the track NAMES `fullstack` and `ai_application` to swap three of them, then swapped three
more whenever the posting's wording read senior. Those lines are not advice: `tailor_resume` passes
them to the generator as the role profile's `skills`, and `apply_overrides` REPLACES the resume's own
Core Skills section with them. A track named anything else therefore printed "Go, Python, SQL,
TypeScript, JavaScript" and "AWS, Docker, Kubernetes" and "Qdrant" on a nurse's resume, under her own
name. They now come from `resume_tracks.<track>.skill_lines` (and `skill_lines_senior`), which is where
the text that used to be in the source now ships - `examples/candidate_profile.example.json`.
"""
from __future__ import annotations

import contextlib
import importlib.util
import inspect
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = ROOT / "src" / "pipeline" / "job_app_assistant.py"
EXAMPLE_PROFILE = ROOT / "examples" / "candidate_profile.example.json"

_spec = importlib.util.spec_from_file_location("job_app_assistant_under_test", MODULE)
assistant = importlib.util.module_from_spec(_spec)
# Registered before the load, which the other by-path loads in this repository do not need: this module
# declares `@dataclass`, and `dataclasses` resolves a class's own module through `sys.modules`.
sys.modules[_spec.name] = assistant
_spec.loader.exec_module(assistant)

#: The prose and the phrases as the module carried them, written out so "unchanged" is compared with the
#: text that shipped rather than described. The phrases are whole patterns with their capture group and
#: their `(?i)`, exactly as the five-pattern list in `infer_title` wrote them.
LEGACY_FIELD_PHRASES = [r"(?i)\b(software engineer[^\n|]{0,80})",
                        r"(?i)\b(backend engineer[^\n|]{0,80})",
                        r"(?i)\b(full[- ]stack engineer[^\n|]{0,80})"]
LEGACY_POSITIONING = {
    "ai_application": (
        "Position as a production software engineer who builds AI-powered applications: "
        "RAG, LLM integration, vector search, Python/FastAPI, Qdrant, workflow APIs, and deployment. "
        "Avoid presenting as an ML research or model-training specialist."
    ),
    "fullstack": (
        "Position as an experienced full-stack/product engineer with React/TypeScript plus backend "
        "ownership, reusable frontend architecture, real-time systems, and production AI application experience."
    ),
    "backend": (
        "Position as an experienced backend engineer with Go/Python APIs, platform services, RBAC, "
        "task scheduling, databases, Redis, Docker/Kubernetes, CI/CD, automated testing, and production AI applications as a differentiator."
    ),
}

NURSING_REGISTRY = {"filters": {"field_include": ["registered nurse", "RN", "nurse practitioner", "nurse"]}}
NURSING_JD = ("Registered Nurse - Medical Surgical\n"
              "We are seeking a Registered Nurse for the night shift.\n"
              "Requirements: active RN license, BLS certification.\n")
LEGAL_JD = ("Litigation Associate\n"
            "We are hiring an Associate Attorney for our litigation group.\n"
            "Requirements: JD, California bar admission.\n")
SOFTWARE_JD = ("Senior Backend Engineer\n"
               "We are looking for a backend engineer to own our APIs.\n"
               "Requirements: 3+ years of experience with Go, Postgres and Kubernetes.\n")

NURSING_PROFILE = {
    "resume_tracks": {"bedside": {"label": "Bedside RN",
                                  "keywords": ["registered nurse", "nurse", "RN"]}},
    "do_not_claim": [],
}
LEGAL_PROFILE = {
    "resume_tracks": {"litigation": {"label": "Litigation Associate",
                                     "keywords": ["attorney", "litigation", "counsel"]}},
    "do_not_claim": [],
}

#: The six lines `skill_lines_for_tailor` returned for the example's three tracks, and the three it
#: swapped in when the posting read senior, written out as the module wrote them. Literal here for the
#: same reason as the phrase list above: "unchanged" is then compared with the text that shipped.
PLAIN_JD = "we are hiring an engineer to own our apis, our services and our database."
SENIOR_JD = "we are hiring a staff engineer to own our platform and mentor the team."
LEGACY_SKILL_LINES = {
    "backend": {
        "Languages": "Go, Python, SQL, TypeScript, JavaScript",
        "Backend": "REST APIs, FastAPI, Node.js, RBAC, JWT, Authentication & Authorization, Task Scheduling, API Design",
        "Databases & Data": "MySQL, PostgreSQL, Redis, MongoDB, Qdrant",
        "Cloud & DevOps": "AWS, Docker, Kubernetes, GitLab CI/CD, Linux, Git",
        "AI / LLM": "RAG, LLM Integration, Vector Search, Qwen2",
        "Engineering": "System Design, Automated Testing, CI/CD",
    },
    "fullstack": {
        "Languages": "Go, Python, SQL, TypeScript, JavaScript",
        "Backend": "REST APIs, FastAPI, Node.js, RBAC, JWT, Authentication & Authorization, API Design",
        "Databases & Data": "MySQL, PostgreSQL, Redis, MongoDB, Qdrant",
        "Cloud & DevOps": "AWS, Docker, Kubernetes, GitLab CI/CD, Linux, Git",
        "AI / LLM": "RAG, LLM Integration, Vector Search, Qwen2",
        "Engineering": "System Design, Automated Testing, CI/CD, Code Review",
        "Frontend": "React, TypeScript, Redux, WebSocket, JSON Schema",
    },
    "ai_application": {
        "Languages": "Go, Python, SQL, TypeScript, JavaScript",
        "Backend": "FastAPI, REST APIs, Python Services, RBAC, JWT, Task Scheduling, API Design",
        "Databases & Data": "MySQL, PostgreSQL, Redis, MongoDB, Qdrant",
        "Cloud & DevOps": "AWS, Docker, Kubernetes, GitLab CI/CD, Linux, Git",
        "AI / LLM": "RAG, LLM Integration, Vector Search, Semantic Retrieval, Qdrant, Qwen2",
        "Engineering": "System Design, Data Processing, Automated Testing, CI/CD, Docker Deployment",
    },
}
LEGACY_SENIOR_LINES = {
    "Backend": "REST APIs, FastAPI, Node.js, RBAC, JWT, Authentication & Authorization, Task Scheduling, Workflow Systems, API Design",
    "Databases & Data": "MySQL, PostgreSQL, Redis, MongoDB, Qdrant, Data Processing",
    "Engineering": "System Design, Automated Testing, CI/CD, Technical Design, Code Review, Mentoring",
}
#: The software words that must not appear on anybody else's resume, in one place so each assertion
#: names the same list. The labels are checked too: "AI / LLM" on a nurse's Core Skills section is the
#: same borrowed sentence as its value.
BORROWED_SKILLS = ("Go, Python", "Kubernetes", "Qdrant", "RAG", "React", "AWS", "AI / LLM")


def analysis_for(track: str, title: str = "Registered Nurse - Medical Surgical"):
    """An `Analysis` carrying only what the printed positioning section reads."""
    return assistant.Analysis(title=title, company="Example Health", source="src", eligibility="unclear",
                              eligibility_notes=[], track_scores={track: 3}, recommended_track=track,
                              default_track=track, matched_terms={track: ["nurse"]}, caution_terms=[],
                              seniority_hints=[], summary="")


class ThePostingsOwnTitleComesFromTheApplicantsFieldTest(unittest.TestCase):
    def test_a_nursing_jd_reports_the_nursing_title(self):
        with mock.patch.object(assistant, "load_sources", return_value=NURSING_REGISTRY):
            analysis = assistant.build_analysis(NURSING_JD, "https://example.test/jd", NURSING_PROFILE)
        # `tailor_resume` uses this for the role profile's filename, the output DOCX and the tracker row.
        self.assertEqual(analysis.title, "Registered Nurse - Medical Surgical")

    def test_a_legal_jd_reports_the_legal_title(self):
        registry = {"filters": {"field_include": ["attorney", "litigation associate", "counsel", "lawyer"]}}
        with mock.patch.object(assistant, "load_sources", return_value=registry):
            analysis = assistant.build_analysis(LEGAL_JD, "src", LEGAL_PROFILE)
        self.assertEqual(analysis.title, "Litigation Associate")

    def test_the_profile_supplies_the_field_when_the_registry_names_none(self):
        # `resume_tracks[*].keywords` is where the applicant already wrote what their field is; the same
        # precedence `field_patterns` uses, so the title and the gate cannot disagree about the field.
        with mock.patch.object(assistant, "load_sources", return_value={}):
            analysis = assistant.build_analysis(NURSING_JD, "src", NURSING_PROFILE)
        self.assertEqual(analysis.title, "Registered Nurse - Medical Surgical")

    def test_the_three_software_phrases_are_what_a_run_with_no_field_falls_back_to(self):
        """The other half of the contract: an unconfigured run extracts exactly what it always did."""
        self.assertEqual(assistant.DEFAULT_FIELD_PHRASES, LEGACY_FIELD_PHRASES)
        self.assertEqual(assistant.title_phrases({}, {}), LEGACY_FIELD_PHRASES)
        self.assertEqual(assistant.infer_title(SOFTWARE_JD), "Backend Engineer")
        self.assertEqual(assistant.infer_title(NURSING_JD), "Unknown role")

    def test_the_software_phrases_are_what_failed_on_the_same_two_jds(self):
        """A check on the fixture, not on the code: without the field, these JDs have no title at all."""
        for jd in (NURSING_JD, LEGAL_JD):
            with self.subTest(jd=jd.splitlines()[0]):
                self.assertEqual(assistant.infer_title(jd, LEGACY_FIELD_PHRASES), "Unknown role")

    def test_the_markup_a_page_carries_is_still_tried_first(self):
        # The field phrases are a fallback for a JD with no title of its own, and a page's own `<title>`
        # travels in as "Page Title: ..." (`read_jd`), which must keep winning.
        jd = f"Page Title: Registered Nurse - Surgical ICU\n{NURSING_JD}"
        with mock.patch.object(assistant, "load_sources", return_value=NURSING_REGISTRY):
            analysis = assistant.build_analysis(jd, "https://example.test/jd", NURSING_PROFILE)
        self.assertEqual(analysis.title, "Registered Nurse - Surgical ICU")


class ThePositioningAdviceComesFromTheProfileTest(unittest.TestCase):
    def test_the_example_profiles_tracks_carry_the_paragraphs_that_used_to_be_in_the_source(self):
        """A fresh checkout - `setup-examples.sh` copies this file into `data/` - prints what it printed.

        The paragraphs moved from the module into the profile that is theirs, so this asserts both halves
        at once: the example ships them, and the printer reads them from there.
        """
        example = json.loads(EXAMPLE_PROFILE.read_text(encoding="utf-8"))
        for track, text in LEGACY_POSITIONING.items():
            with self.subTest(track=track):
                self.assertEqual(assistant.positioning_for_track(example, track), text)

    def test_another_field_is_never_advised_to_be_a_backend_engineer(self):
        profile = {"resume_tracks": {"bedside": {"label": "Bedside RN",
                                                 "positioning": "Position as a bedside RN with an active "
                                                                "California licence and BLS certification."}}}
        self.assertIn("bedside RN", assistant.positioning_for_track(profile, "bedside"))
        # NOT CONFIGURED, and this is the case that used to print the else-branch: one person's backend
        # paragraph, at a nurse or a lawyer, about skills they do not have.
        bare = {"resume_tracks": {"litigation": {"label": "Litigation Associate"}}}
        line = assistant.positioning_for_track(bare, "litigation")
        self.assertIn("Litigation Associate", line, "the track's own name, from the profile")
        self.assertIn("positioning", line, "and where to record what should be printed instead")
        for borrowed in ("backend", "Go/Python", "Redis", "React", "TypeScript", "RAG", "Kubernetes"):
            with self.subTest(borrowed=borrowed):
                self.assertNotIn(borrowed, line)

    def test_the_printed_block_is_the_profiles_advice(self):
        # The defect was a printed paragraph, so this drives `print_analysis` rather than the helper.
        profile = {"resume_tracks": {"bedside": {"label": "Bedside RN",
                                                 "positioning": "Position as a bedside RN."}},
                   "do_not_claim": []}
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            assistant.print_analysis(analysis_for("bedside"), profile)
        self.assertIn("Position as a bedside RN.", printed.getvalue())
        self.assertNotIn("Position as an experienced backend engineer", printed.getvalue())

    def test_no_track_name_is_a_literal_in_the_function_that_prints_the_advice(self):
        # The enforced half, scoped to the function this change is about: the two names it keyed on must
        # not come back as CODE. The module's own comment quotes them (that is where the next reader
        # meets them), so this reads the function rather than the file.
        #
        # NOT the whole file: the second copy of the defect - `skill_lines_for_tailor` keying on the same
        # two names to choose skill lines - is guarded by its own test below, which reads that function.
        offenders = [line.strip() for line in inspect.getsource(assistant.positioning_for_track).splitlines()
                     if line.strip().startswith(("if ", "elif ", "return "))
                     and any(name in line for name in ('"ai_application"', '"fullstack"',
                                                       "'ai_application'", "'fullstack'"))]
        self.assertEqual(offenders, [], "a hardcoded track name is back in positioning_for_track")


class TheHeaderTitleComesFromThePostingOrTheProfileTest(unittest.TestCase):
    """The line under the candidate's name, which `tailor_resume` used to fill with a title of its own.

    WHAT BROKE, AND FOR WHOM. The header resolved as `track_config.get("default_header_title",
    "Software Engineer")` - so anybody whose track is not this module's author's was handed a job title
    they do not hold - and a second literal, "Staff Software Engineer | Backend Platform & Data
    Integration", replaced even a profile's own value whenever the role contained "staff" on the
    profile's ordinary track, asserting a seniority and a specialisation nobody had recorded. What is
    resolved now is the profile's `default_header_title`, the posting's own title, or a sentence saying
    neither supplied one.

    WHERE IT GOES, because it decides what can be asserted: the value reaches the console and no
    document (`tailor_resume` prints it and passes it nowhere), so the sentence is the honest ending
    rather than a failed build - and the run-driven test at the end of this file reads the printed line.
    """

    def test_a_nursing_or_legal_profile_gets_the_postings_own_title(self):
        cases = [(NURSING_PROFILE, "bedside", "Registered Nurse - Medical Surgical"),
                 (LEGAL_PROFILE, "litigation", "Litigation Associate")]
        for profile, track, title in cases:
            with self.subTest(track=track):
                resolved = assistant.header_title_for(profile, track, title)
                self.assertEqual(resolved, title)
                for borrowed in ("Software Engineer", "Staff", "Backend", "Platform & Data Integration"):
                    self.assertNotIn(borrowed, resolved)

    def test_a_run_that_supplies_neither_says_so_instead_of_naming_a_title(self):
        # THE ONE BEHAVIOUR THAT DIFFERS FROM THE CHECKOUT THAT CAME BEFORE: this line printed the
        # literal "Software Engineer" whenever the posting supplied no title either. It now names the
        # two inputs that were missing and the two ways to supply one.
        line = assistant.header_title_for(LEGAL_PROFILE, "litigation", assistant.UNKNOWN_ROLE)
        self.assertIn("default_header_title", line, "the missing input, named")
        self.assertIn("litigation", line, "and which track it is missing for")
        for borrowed in ("Software Engineer", "Engineer", "Unknown role"):
            with self.subTest(borrowed=borrowed):
                self.assertNotIn(borrowed, line)

    def test_a_posting_the_extractor_cannot_title_reaches_that_sentence_and_not_a_literal(self):
        """Driven from a JD, because `UNKNOWN_ROLE` is a value `infer_title` produces, not a guess.

        A posting that names none of the profile's own field words: the phrases come from the profile's
        `keywords`, they find nothing in the prose, and the extractor reports that the posting has no
        title - which is the input the header resolver has to refuse rather than dress up.
        """
        profile = {"resume_tracks": {"litigation": {"label": "Litigation Associate",
                                                    "keywords": ["attorney", "counsel"]}},
                   "do_not_claim": []}
        with mock.patch.object(assistant, "load_sources", return_value={}):
            analysis = assistant.build_analysis(
                "We are hiring for our group.\nRequirements: JD, California bar admission.\n", "src", profile)
        self.assertEqual(analysis.title, assistant.UNKNOWN_ROLE)
        line = assistant.header_title_for(profile, "litigation", analysis.title)
        self.assertIn("default_header_title", line)
        self.assertNotIn("Software Engineer", line)

    def test_the_profile_outranks_the_posting_and_the_operator_outranks_both(self):
        # The precedence is the point: a header describes the PERSON, so the profile's own words win over
        # the posting's - and `--header-title` is the operator's decision about this one document.
        profile = {"resume_tracks": {"bedside": {"label": "Bedside RN",
                                                 "default_header_title": "Registered Nurse"}}}
        posting = "Registered Nurse - Medical Surgical"
        self.assertEqual(assistant.header_title_for(profile, "bedside", posting), "Registered Nurse")
        self.assertEqual(assistant.header_title_for(profile, "bedside", posting, "RN | Telemetry"),
                         "RN | Telemetry")

    def test_the_example_checkout_gets_the_postings_title_where_the_literal_used_to_be(self):
        """The other end of the same change, for the profile a checkout is configured from.

        The example records no header title for its tracks - a header is a claim about the person
        configuring from it, and nothing renders one - so the resolved header is the posting's own title
        ("Staff Software Engineer, ..." on a staff posting), where the literal used to be.
        """
        example = json.loads(EXAMPLE_PROFILE.read_text(encoding="utf-8"))
        self.assertNotIn("default_header_title", example["resume_tracks"]["backend"], "the premise")
        self.assertEqual(assistant.header_title_for(example, "backend", "Staff Software Engineer, Backend Platform"),
                         "Staff Software Engineer, Backend Platform")

    def test_no_job_title_is_a_literal_in_the_code_that_resolves_the_header(self):
        # The enforced half, scoped to the resolution path as the positioning guard above is. A literal is
        # matched WITH ITS QUOTES, so the comment above `header_title_for` can still quote what was
        # removed - that is where the next reader meets it.
        #
        # IT USED TO SAY "SCOPED, and not file-wide", because the same two titles were still in the file
        # as MATCH PATTERNS in `set_or_insert_header_title`, the paragraph patcher that recognised a
        # header on a copied template. That function and the three helpers around it were deleted once
        # nothing could reach them, so the two titles are now in the comment above `header_title_for` and
        # nowhere else - and the literal guard covers the resolver, which is the code that still runs.
        removed = ("Software Engineer", "Staff Software Engineer", "Backend Platform & Data Integration")
        for function in (assistant.header_title_for, assistant.tailor_resume):
            offenders = [line.strip() for line in inspect.getsource(function).splitlines()
                         if any(f'"{literal}"' in line or f"'{literal}'" in line for literal in removed)]
            with self.subTest(function=function.__name__):
                self.assertEqual(offenders, [], "a job title is a literal in the header path again")

class TheSeniorityHintsComeFromTheLevelsBlockTest(unittest.TestCase):
    """The "Seniority hints" line, which named software's rungs for every applicant.

    WHAT WAS WRONG, AND FOR WHOM. `SENIORITY_HINTS` held three software rung spellings - "software
    engineer i", "software engineer ii", "ic2" - beside the generic words ("new grad", "entry level").
    A nursing registry could replace every level word the screen ranks by, and this report would still say
    a nursing posting named a software rung nobody had written anywhere. The rung words now come from the
    registry's `levels` block through `level_vocabulary`, which is the same block `level_patterns` reads;
    the generic words stay in the module because "new grad" is not a field's spelling of anything.
    """

    #: The line as the module carried it, written out so "unchanged" is compared with the words that
    #: shipped rather than with a description of them.
    LEGACY_HINTS = ["new grad", "university graduate", "early career", "entry level", "entry-level",
                    "software engineer i", "software engineer ii", "ic2"]
    NURSING_LEVELS = {"junior": ["nurse i", "rn i"], "mid": ["nurse ii", "rn ii"],
                      "senior": ["charge nurse"], "management": ["nurse manager"]}

    def test_a_run_that_configures_nothing_reports_exactly_what_it_reported(self):
        self.assertEqual(assistant.seniority_hints_for({}), self.LEGACY_HINTS)

    def test_a_nursing_registry_is_reported_in_its_own_rungs(self):
        hints = assistant.seniority_hints_for({**NURSING_REGISTRY, "levels": self.NURSING_LEVELS})
        for want in ("nurse i", "rn i", "nurse ii", "rn ii"):
            with self.subTest(word=want):
                self.assertIn(want, hints)
        for borrowed in ("software engineer i", "software engineer ii", "ic2"):
            with self.subTest(word=borrowed):
                self.assertNotIn(borrowed, hints,
                                 "a nursing registry must not be reported in software's rungs")

    def test_the_line_reports_what_the_posting_says_and_not_what_the_vocabulary_holds(self):
        """The words are matched against the JD, so a rung the posting does not name is not reported.

        This is what separates the line from the vocabulary: `level_vocabulary` is what CAN be said, and
        this is what a posting DID say. A posting titled "RN II" reports that one rung; the other words
        the registry configures - including every software spelling - are not hints about it, because the
        JD does not carry them. The rung is read from the POSTING's own text, which is the only place it
        was ever read from.
        """
        registry = {**NURSING_REGISTRY, "levels": self.NURSING_LEVELS}
        posting = NURSING_JD + "This is an RN II position on the night shift.\n"
        with mock.patch.object(assistant, "load_sources", return_value=registry):
            analysis = assistant.build_analysis(posting, "https://example.test/jd", NURSING_PROFILE)
        self.assertIn("Registered Nurse", analysis.title)
        self.assertEqual(analysis.seniority_hints, ["rn ii"])
        for absent in ("nurse i", "rn i", "nurse ii", "software engineer i", "software engineer ii",
                       "ic2"):
            with self.subTest(word=absent):
                self.assertNotIn(absent, analysis.seniority_hints,
                                 "a word the JD does not carry is not a hint about it")


class TheSkillLinesComeFromTheProfileTest(unittest.TestCase):
    """The resume's Core Skills section, which was one person's career written into the source.

    WHAT BROKE, AND FOR WHOM. `skill_lines_for_tailor` held six software lines, keyed two branches on
    the track names `fullstack` and `ai_application` to swap three of them, and swapped three more
    whenever the posting's wording read senior. That dict is not advice: `tailor_resume` hands it to the
    generator as the role profile's `skills`, and `apply_overrides` REPLACES the resume's Core Skills
    section with it - so a nurse's resume printed "Go, Python, SQL, TypeScript, JavaScript", "AWS,
    Docker, Kubernetes" and "Qdrant" under her name, because her track was named `bedside`.
    """

    def test_the_example_profiles_tracks_carry_the_lines_that_used_to_be_in_the_source(self):
        """A checkout configured from the example prints what it printed, on all three tracks.

        The lines moved from the module into the profile that is theirs, so this asserts both halves at
        once: the example ships them, and the resolver reads them from there.
        """
        example = json.loads(EXAMPLE_PROFILE.read_text(encoding="utf-8"))
        for track, expected in LEGACY_SKILL_LINES.items():
            with self.subTest(track=track):
                self.assertEqual(assistant.skill_lines_for_tailor(example, track, PLAIN_JD), expected)

    def test_the_senior_wording_swaps_the_three_lines_it_used_to_swap(self):
        # `skill_lines_senior` is MERGED rather than substituted: the posting's wording decides which
        # labels change, and every line the track does not mention stays where it was.
        example = json.loads(EXAMPLE_PROFILE.read_text(encoding="utf-8"))
        senior = assistant.skill_lines_for_tailor(example, "backend", SENIOR_JD)
        self.assertEqual({label: senior[label] for label in LEGACY_SENIOR_LINES}, LEGACY_SENIOR_LINES)
        self.assertEqual(senior["Languages"], LEGACY_SKILL_LINES["backend"]["Languages"],
                         "the wording changed three lines, not the track's whole record")

    def test_a_nursing_profile_gets_her_own_lines_and_never_a_software_one(self):
        profile = {"resume_tracks": {"bedside": {
            "label": "Bedside RN",
            "skill_lines": {"Clinical": "Med-surg and telemetry nursing, 1:5 ratios",
                            "Certifications": "RN (California), BLS, ACLS"}}}}
        lines = assistant.skill_lines_for_tailor(profile, "bedside", NURSING_JD.lower())
        self.assertEqual(lines, profile["resume_tracks"]["bedside"]["skill_lines"])
        for borrowed in BORROWED_SKILLS:
            with self.subTest(borrowed=borrowed):
                self.assertNotIn(borrowed, json.dumps(lines))

    def test_a_track_that_records_none_contributes_no_override_at_all(self):
        """What this module must never do: speak for a track whose profile records no lines.

        `{}` rather than a default set, and the caller writes no `skills` key for it either - an empty
        dict would reach `apply_overrides`, which reads one as "replace the Core Skills section with
        nothing", and the resume then carries the skills in `application_profile.json`, which are the
        candidate's own. The rendered half of this is asserted on the nursing DOCX at the end of the file.
        """
        bare = {"resume_tracks": {"litigation": {"label": "Litigation Associate"}}}
        self.assertEqual(assistant.skill_lines_for_tailor(bare, "litigation", LEGAL_JD.lower()), {})

    def test_no_track_name_is_a_literal_in_the_function_that_picks_the_skill_lines(self):
        offenders = [line.strip() for line in inspect.getsource(assistant.skill_lines_for_tailor).splitlines()
                     if line.strip().startswith(("if ", "elif ", "return "))
                     and any(name in line for name in ('"ai_application"', '"fullstack"',
                                                       "'ai_application'", "'fullstack'"))]
        self.assertEqual(offenders, [], "a hardcoded track name is back in skill_lines_for_tailor")


class ANursesTailoredResumeIsHersTest(unittest.TestCase):
    """One `tailor` run, read where each of the two values actually lands.

    THE TWO GO TO DIFFERENT PLACES, which is why this drives the CLI and then reads BOTH outputs: the
    header title is printed and written into no document, so the console line is its whole artifact, and
    the skill lines ARE the resume's Core Skills section. A profile that is not software is the case
    both defects reached - a nurse with two tracks, one that records her own skill lines and one that
    records none - and the posting is an ordinary nursing one whose requirements mention mentoring new
    graduates, one of the words the old code read as "show the senior software lines".

    THE RUN IS A SUBPROCESS with `ATS_DATA_DIR` pointed at a temporary tree, the way
    `test_application_pipeline` drives a second person's checkout. The tool reads both profiles and the
    master DOCX by path from the process environment and `src/paths.py` resolves that once per process,
    so a second configuration cannot be installed inside this one - and the temp tree owns the master
    too (`make_master_resume` supplies the scaffold the renderer needs), so nothing here reads the
    checkout's `data/` and nothing skips on a checkout that has no resume.
    """

    NURSE_CANDIDATE_PROFILE = {
        "candidate": {"name": "Example Nurse"},
        "resume_tracks": {
            "bedside": {
                "label": "Bedside RN",
                "keywords": ["registered nurse", "nurse", "rn"],
                "positioning": "Position as a bedside RN with an active California licence and BLS.",
                "template_docx": "data/resume_templates/Example_Candidate_Backend_Resume.docx",
                "resume_files": [],
                "skill_lines": {"Clinical": "Med-surg and telemetry nursing, 1:5 ratios",
                                "Certifications": "RN (California), BLS, ACLS"},
            },
            # NO `skill_lines`, which is every track that has not been reconfigured by hand - the state
            # the fallback has to be right in.
            "clinic": {
                "label": "Clinic RN",
                "keywords": ["clinic nurse", "outpatient"],
                "positioning": "Position as an outpatient clinic RN.",
                "template_docx": "data/resume_templates/Example_Candidate_Backend_Resume.docx",
                "resume_files": [],
            },
        },
        "do_not_claim": [],
    }
    NURSE_APPLICATION_PROFILE = {
        "candidate": {"name": "Example Nurse",
                      "resume_contact_lines": ["Anaheim, California - nurse@example.test"]},
        "resume": {
            "summary": (
                "I am a registered nurse with six years on a medical-surgical unit, most of it on nights, "
                "where I carry five patients, run the unit's telemetry monitoring, and precept the new "
                "graduate nurses who join us each summer. My practice is built on early recognition: I "
                "escalate a changing patient before the numbers are dramatic, and I document what I saw "
                "and what I did rather than what the chart template expects. I have worked Epic and "
                "Cerner deployments from the floor side and trained colleagues through both. What I want "
                "next is a med-surg role on a unit that staffs to acuity and treats precepting as real "
                "work rather than an extra shift."),
            "skills": [{"label": "Charting", "value": "Epic, Cerner"},
                       {"label": "Languages", "value": "English, Spanish"}],
        },
        "work_experience": [],
        "projects": [],
        "education": [],
    }
    NURSING_POSTING = ("Registered Nurse - Medical Surgical\n"
                       "Example Health is hiring a night-shift nurse for its med-surg unit.\n"
                       "Requirements: active RN licence, BLS certification, and mentoring of new "
                       "graduate nurses.\n")

    @classmethod
    def setUpClass(cls):
        # `make_master_resume` and the renderer are imported by bare name across this pipeline, so the
        # directory they live in goes on the path - the same insert `test_application_pipeline` and
        # `test_build_cover_letter` do, for the same reason.
        sys.path.insert(0, str(ROOT / "src" / "pipeline"))
        from make_master_resume import make_master

        cls.directory = pathlib.Path(tempfile.mkdtemp(prefix="nurse-tailor-"))
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        cls.master = cls.directory / "resume_templates" / "Example_Candidate_Backend_Resume.docx"
        cls.master.parent.mkdir()
        make_master("Example Nurse").save(str(cls.master))
        (cls.directory / "candidate_profile.json").write_text(
            json.dumps(cls.NURSE_CANDIDATE_PROFILE), encoding="utf-8")
        (cls.directory / "application_profile.json").write_text(
            json.dumps(cls.NURSE_APPLICATION_PROFILE), encoding="utf-8")
        cls.jd = cls.directory / "registered_nurse.txt"
        cls.jd.write_text(cls.NURSING_POSTING, encoding="utf-8")

        cls.bedside_stdout, cls.bedside_text = cls.tailor("bedside")
        cls.clinic_stdout, cls.clinic_text = cls.tailor("clinic")

    @classmethod
    def tailor(cls, track: str) -> tuple[str, str]:
        """One `tailor --docx-only` run in the temporary tree: (the console, the rendered paragraphs)."""
        from docx import Document

        output = cls.directory / f"{track}.docx"
        result = subprocess.run(
            [sys.executable, str(MODULE), "tailor", "--track", track, "--file", str(cls.jd),
             "--company", "Example Health", "--template", str(cls.master), "--output", str(output),
             "--docx-only"],
            capture_output=True, text=True, timeout=180,
            env=dict(os.environ, ATS_DATA_DIR=str(cls.directory)))
        if result.returncode != 0:
            raise AssertionError(f"tailor --track {track} failed:\n{result.stdout[-1500:]}\n{result.stderr[-1500:]}")
        # The run writes one role profile beside the checkout's other intermediate resumes - it is the
        # file the generator is handed - and it is named by the company and the posting's own title.
        title = next((line.split("Title: ", 1)[1] for line in result.stdout.splitlines()
                      if line.startswith("Title: ")), "")
        leftover = ROOT / "output" / "docx" / f"{assistant.slugify('Example Health')}_{assistant.slugify(title)}_profile.json"
        cls.addClassCleanup(pathlib.Path.unlink, leftover, missing_ok=True)
        paragraphs = [p.text for p in Document(str(output)).paragraphs if p.text.strip()]
        return result.stdout, "\n".join(paragraphs)

    def test_the_printed_header_is_the_postings_own_nursing_title(self):
        # The whole artifact for the header. It used to read "Header title: Software Engineer", for a
        # nurse, because the title was a literal in the module rather than anything about her or the job.
        self.assertIn("Header title: Registered Nurse - Medical Surgical", self.bedside_stdout)
        self.assertNotIn("Software Engineer", self.bedside_stdout)

    def test_the_core_skills_section_is_the_line_her_track_records(self):
        self.assertIn("Clinical Med-surg and telemetry nursing, 1:5 ratios", self.bedside_text)
        self.assertIn("Certifications RN (California), BLS, ACLS", self.bedside_text)
        for borrowed in BORROWED_SKILLS:
            with self.subTest(borrowed=borrowed):
                self.assertNotIn(borrowed, self.bedside_text)

    def test_a_track_that_records_no_skill_lines_keeps_her_own_on_the_page(self):
        # The unconfigured track: the resume's Core Skills section is the one in application_profile.json,
        # which is the candidate's own record - not six software lines borrowed from this module.
        self.assertIn("Charting Epic, Cerner", self.clinic_text)
        self.assertIn("Languages English, Spanish", self.clinic_text)
        for borrowed in BORROWED_SKILLS:
            with self.subTest(borrowed=borrowed):
                self.assertNotIn(borrowed, self.clinic_text)

    def test_the_resume_carries_her_summary_and_no_software_claim_at_all(self):
        """The whole document, not the one section, because that is what an employer reads.

        The paragraphs only: the DOCX's own metadata is not part of this, and one string in it is still
        one person's - `generate_tailored_resume` writes `Tailored software engineering resume for
        <company>` into `core_properties.subject` for every applicant. It is reported rather than fixed
        here, because it is a different file and a different edit.
        """
        for text in (self.bedside_text, self.clinic_text):
            with self.subTest(document=text[:40]):
                self.assertIn("Example Nurse", text)
                self.assertIn("I am a registered nurse", text)
                for borrowed in ("Software Engineer", "Backend"):
                    self.assertNotIn(borrowed, text)


if __name__ == "__main__":
    unittest.main()
