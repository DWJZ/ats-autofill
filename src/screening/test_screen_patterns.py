#!/usr/bin/env python3
"""Regression tests for the screening patterns: the hard bars in `screen_urls.py`, and the field and
region gates that `screen_newgrad_postings.py` compiles from configuration.

Every alternative in `BAD` is there because a real posting got past an earlier version of it. The cases
that paid for them belong here rather than in prose: the tenant, the date and the sentence that was
missed, in a comment above the assertion that it is missed no longer.

Both directions matter equally, which is why every case carries its expectation rather than only the
bars. A bar that goes UNREPORTED is a role applied to that cannot be taken; a CLEAN sentence the
patterns match is a role skipped for nothing - `itar` inside "military" was the first kind of mistake,
`fedRAMP` inside a compliance vendor's name was the second. The same two directions appear below as
"this field is not mine" and "this field is mine": a field gate that matches nothing reports an empty
market, and a field gate that matches everything reports a market that is not yours.

The `pay` line is a third instance of the same shape, in the same file: a figure that is not the
employer's is a claim about the candidate, whether the screener invented it or dropped a published band
and quoted a fallback instead.
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

MODULE = pathlib.Path(__file__).with_name("screen_urls.py")
spec = importlib.util.spec_from_file_location("screen_urls", MODULE)
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)

# THE ENVIRONMENT IS CHANGED ONLY AROUND THE LOAD, AND PUT BACK. The field/region gates resolve `DATA_DIR`
# at import time, and the patterns under test are passed in as dicts - a test that read the checkout's own
# `sources.json` would pass or fail depending on who ran it, so the load points at an empty directory.
#
# IT USED TO STAY POINTED THERE. Setting `os.environ` at module scope did that job and then kept it, and
# because full discovery imports every test module before running any of them, every LATER test inherited
# an `ATS_DATA_DIR` naming an empty temporary directory. The tests that run a tool as a subprocess -
# `test_relocation_drafting`, `test_refill_attachments`, `test_compensation_rule` - then failed with a
# FileNotFoundError for a file `setup-examples.sh` had created; each passed when run alone, which is what
# a global set in a test module looks like from the outside.
_previous_ats_data_dir = os.environ.get("ATS_DATA_DIR")
os.environ["ATS_DATA_DIR"] = tempfile.mkdtemp(prefix="screen-patterns-")
try:
    SNP_MODULE = pathlib.Path(__file__).with_name("screen_newgrad_postings.py")
    snpspec = importlib.util.spec_from_file_location("screen_newgrad_postings_under_test", SNP_MODULE)
    snp = importlib.util.module_from_spec(snpspec)
    snpspec.loader.exec_module(snp)
finally:
    if _previous_ats_data_dir is None:
        os.environ.pop("ATS_DATA_DIR", None)
    else:
        os.environ["ATS_DATA_DIR"] = _previous_ats_data_dir


class HardBarPatternTest(unittest.TestCase):
    # (the sentence as the posting wrote it, is it a hard bar?)
    CASES = [
        # ---- bars that a keyword screen missed -------------------------------------------------
        # CrowdStrike, 2026-10-01. A company-wide bar in the "What You'll Need" block: it contains
        # neither "sponsor" nor "clearance", so a screen tuned to those two words passed it.
        ("US Citizen or Green Card holder", True),
        # Teamworks, 2026-10-01. The citizenship half is phrased without any word a naive screen
        # looks for, and the tenant is a skip for an F-1 OPT candidate.
        ("US citizenship, with willingness to pursue security clearance in the future", True),
        # Teamworks, 2026-10-01. The no-sponsorship family in its own wording - the pattern set had no
        # form of it at all, so a real bar went unreported.
        ("This role is not eligible for sponsorship at this time", True),
        # Rackner, 2026-10-06. "Clearance: Active final DoD Secret clearance required" matched NOTHING
        # before the bare word was added, so a defence role with a hard bar looked bar-free.
        ("Clearance: Active final DoD Secret clearance required", True),
        # Retell AI, 2026-10-06. An ENROLMENT bar, invisible in a normal requirement list, that
        # excludes a candidate finishing an M.S. in December 2026.
        ("only open to candidates who have already completed their bachelor's degree and are no longer "
         "enrolled in a bachelor's or master's program", True),
        # Garner Health, 2026-10-01. The bar is an italicised note INSIDE the description rather than a
        # requirements line, and it carries the whole board, so the tenant is a skip and not a
        # per-requisition check.
        ("Please note: we are unable to sponsor or take over sponsorship of an employment visa at this "
         "time.", True),
        # Greenhouse (Greenhouse's own board, req 8279799), 2026-10-14. A live JD carried this sentence and
        # the screener reported "bars: none found in the authorisation sentences" - the sponsorship family
        # had "unable to sponsor" but no form of "unable to SUPPORT sponsorship", so the bar went unnamed.
        ("We are unable to support sponsorship at this time.", True),

        # ---- clean sentences the patterns must NOT match ----------------------------------------
        # Teamworks, 2026-10-01. `itar` had no word boundary and matched inside "mil·itar·y", which
        # produced a false hard bar on a posting that had none. This is the sentence that was in it.
        ("AMS supports military and government programs", False),
        # 2026-10-06. A compliance vendor's own name on a posting with no bar.
        ("You'll be helping us scale towards stateRAMP and fedRAMP compliance", False),
        # Standard EEO boilerplate. The word "citizenship" appears here and means nothing; this is why
        # the pattern list reads "us citizen" rather than the bare noun.
        ("citizenship, medical condition, marital or domestic partner status", False),
    ]

    def test_the_patterns_agree_with_every_case(self):
        wrong = []
        for text, want_bar in self.CASES:
            hit = screen.BAD.search(text)
            if bool(hit) != want_bar:
                wrong.append(
                    f"{'expected a BAR' if want_bar else 'expected CLEAN'}: {text[:68]!r} "
                    f"-> {hit.group(0) if hit else 'no match'}")
        self.assertEqual(wrong, [], "a screening pattern disagrees with the case that paid for it")

    def test_the_case_list_covers_both_directions(self):
        # A list of bars alone would pass even if the patterns matched everything.
        wants = [want for _, want in self.CASES]
        self.assertIn(True, wants)
        self.assertIn(False, wants)


# --------------------------------------------------------------------------- the field and region gates
#
# A NURSE RAN THIS SCREEN AND IT REPORTED THAT IT HAD FOUND NOTHING. Measured on a live run before the
# gates became configuration: 3336 jobs fetched, 2164 excluded as `not_engineering`, 489 as `not_us`,
# and the three results it printed were Senior Software Engineer roles. Every posting her own field
# appeared in was counted as "not her field" by a pattern written into the source, and the report said
# nothing about it. THAT is the shape of the failure these cases pin: the gate must be answerable from
# configuration, and a field it knows nothing about must be REPORTED rather than silently emptied.

#: The patterns as the module constants they used to be, written out in full, so the defaults can be
#: compared against the text that shipped rather than against a description of it. `field_include`
#: is `_LEGACY_FIELD_INCLUDE`, the one constant whose compiled form is deliberately NOT the same.
LEGACY_DEFAULTS = snp.FieldPatterns(
    field_include=snp.re.compile(snp._LEGACY_FIELD_INCLUDE, snp.re.I),
    field_exclude=snp.re.compile(
        r"recruiter|recruiting|sales|marketing|finance|accounting|design|analyst"
        r"|\bsupport\b|product|people|operations|legal|privacy|civil liberties"
        r"|data science|data scientist|machine learning|research", snp.re.I),
    title_topics_exclude=snp.re.compile(
        r"\b(ASIC|RTL|DFT|FPGA|analog|digital design|firmware|hardware|low power"
        r"|cell modeling|energy modeling|power methodology|verification|silicon|PCB)\b", snp.re.I),
    region_include=snp.re.compile(
        r"united states|\busa?\b|\bus\b|remote|seattle|bellevue|redmond|washington,?\s*wa"
        r"|\bwa\b|austin|texas|california|\bca\b|new york|\bny\b|chicago|illinois"
        r"|\bil\b|florida|\bfl\b|massachusetts|boston|oregon|portland|dallas|houston"
        r"|san francisco|san diego|san jose|silicon valley|miami|tampa|orlando"
        r"|denver|colorado|pittsburgh|philadelphia|atlanta|georgia|columbus,?\s*oh"
        r"|ohio|indiana|kentucky|louisville|arizona|\baz\b|utah|sacramento"
        r"|nashville|tennessee|virginia|carolina|maryland|baltimore|district of columbia"
        r"|new jersey|jersey|connecticut|vermont|maine|new hampshire|hawaii|nevada"
        r"|las vegas|kansas|missouri|st\.?\s?louis|minnesota|wisconsin|nebraska"
        r"|oklahoma|mississippi|alabama|arkansas|montana|wyoming|idaho|new mexico", snp.re.I),
    region_exclude=snp.re.compile(
        r"canada|toronto|vancouver|montreal|london|united kingdom|\buk\b|england|europe"
        r"|germany|france|ireland|india|\bin\b|singapore|sydney|melbourne|australia"
        r"|new zealand|japan|korea|seoul|shanghai|beijing|chengdu|dublin|amsterdam"
        r"|berlin|paris|lisbon|portugal|spain|madrid|sweden|stockholm|netherlands"
        r"|brazil|israel|tel aviv|austria|switzerland|zurich|z\u00fcrich|malaysia"
        r"|philippines|warsaw|poland|prague|czech|budapest|romania|cluj|kyiv|ukraine"
        r"|istanbul|turkey|auckland|wellington|manila|kuala lumpur|bangalore|mumbai"
        r"|pune|hyderabad|chennai|delhi|\bcn\b|south africa|duba\u0131|dubai|qatar"
        r"|kuwait|bahrain|oman|jordan|lebanon|saudi", snp.re.I),
    title_region_include=snp.re.compile(r"\bus\b|\busa\b|united states", snp.re.I),
    title_region_exclude=snp.re.compile(
        r"\buk\b|united kingdom|europe|\beu\b|india|china|canada|singapore|london"
        r"|germany|france|ireland|japan|korea|australia|brazil|israel|switzerland"
        r"|netherlands|spain|portugal|poland|sweden|new zealand|malaysia|philippines"
        r"|middle east|turkey", snp.re.I),
)

#: A registry in the shape of a real one - boards, search words, timezone, filters - so the cases below
#: are about the screening and not about a fixture written for the test. A nursing search, because that
#: is the field the failure was measured in. A list is a legal spelling for any of the seven keys.
NURSING_REGISTRY = {
    "greenhouse": {"example-health": "Example Health"},
    "ashby": {"example-clinic": "Example Clinic"},
    "queries": ["registered nurse", "new grad nurse"],
    "timezone": "America/New_York",
    "filters": {
        "field_include": ["registered nurse", "RN", "nurse practitioner", "nurse"],
        "field_exclude": ["recruiter", "sales", "staffing agency"],
    },
}
NURSING_PROFILE = {"resume_tracks": {"bedside": {"label": "Bedside RN",
                                                "keywords": ["registered nurse", "nurse", "RN"]}}}


def passes_field_gate(patterns, title: str) -> bool:
    """The gate exactly as both screeners apply it, so a case here means the same thing in both."""
    return bool(patterns.field_include.search(title)) \
        and not (patterns.field_exclude and patterns.field_exclude.search(title)) \
        and not (patterns.title_topics_exclude and patterns.title_topics_exclude.search(title))


class TheFieldGateIsConfigurationTest(unittest.TestCase):
    """(the title a board published, does the configured gate keep it)"""

    NURSING_CASES = [
        # The postings the live run counted as `not_engineering`. Not one word in any of these appears
        # in any pattern the tool shipped with.
        ("New Grad Registered Nurse - Medical Surgical", True),
        ("Registered Nurse (RN) - New Graduate Program", True),
        ("Nurse Practitioner - Family Medicine", True),
        ("RN - Emergency Department - Nights", True),
        # The negative half of the config, which is the applicant's own answer - a word in
        # `field_include` does not survive `field_exclude`.
        ("Nurse Recruiter - Talent Acquisition", False),
        ("Sales Representative - Healthcare Staffing Agency", False),
        # Not this field at all. A gate that keeps software postings in a nursing search is a gate that
        # has not been configured, and this is the case that says so.
        ("Senior Software Engineer", False),
        ("Software Engineer, New Grad 2026", False),
        # NO HARDWARE EXCLUSION LEAKS IN. "hardware roles - noise for a backend software candidate" was
        # one person's negative preference. A nursing registry that never mentions it must not inherit
        # it, and these two titles carry its words while being ordinary nursing work.
        ("Nurse Informatics Analyst - Clinical Systems", True),
        ("Registered Nurse - Verification Unit", True),
    ]

    def test_a_nursing_search_screens_from_configuration(self):
        patterns, note = snp.field_patterns(NURSING_REGISTRY, NURSING_PROFILE)
        self.assertEqual(note, "", "a registry that names its field has nothing to warn about")
        wrong = [f"{title!r} -> {passes_field_gate(patterns, title)}"
                 for title, want in self.NURSING_CASES
                 if passes_field_gate(patterns, title) != want]
        self.assertEqual(wrong, [], "a configured nursing search disagrees with its own cases")

    def test_the_regions_a_nursing_search_did_not_name_are_not_gated(self):
        """The field is configurable, so the region cannot keep the default nobody asked for."""
        patterns, _ = snp.field_patterns(NURSING_REGISTRY, NURSING_PROFILE)
        self.assertIsNone(patterns.region_include)
        self.assertIsNone(patterns.region_exclude)
        # An unnamed region means "the location field does not decide" - not "not US". The alternative
        # is a Sydney posting counted as `not_us` against a rule its owner never wrote.
        self.assertIsNone(snp.is_us("Sydney, Australia", patterns))

    def test_the_profile_supplies_the_field_when_the_registry_names_none(self):
        """`resume_tracks[*].keywords` is where the applicant already wrote what their field is."""
        patterns, note = snp.field_patterns({"greenhouse": {"example-health": "Example Health"}},
                                            NURSING_PROFILE)
        # AND IT SAYS SO. This asserted `note == ""`, which made the gate's provenance invisible: a
        # profile whose keywords describe a SPECIALISM rather than a field screened out every posting
        # titled with the field's own name - 217 "Software Engineer" postings on one real run - with
        # nothing in the report naming the words responsible. A count of excluded postings looks the
        # same whether the gate is right or wrong, so the words are now always named.
        self.assertIn("resume_tracks", note, "the note must say the gate came from the profile")
        self.assertIn("filters.field_include", note, "and where to change it")
        for title in ("New Grad Registered Nurse", "Registered Nurse (RN) - New Graduate Program"):
            self.assertTrue(passes_field_gate(patterns, title), title)
        self.assertFalse(passes_field_gate(patterns, "Senior Software Engineer"))

    def test_the_profile_keywords_are_joined_across_tracks_and_deduplicated(self):
        """A profile is a dict of tracks, and two of them may spell one word the same way."""
        profile = {"resume_tracks": {"first": {"keywords": ["nurse", "RN"]},
                                     "second": {"keywords": ["RN", "midwife"]}}}
        patterns, _ = snp.field_patterns({}, profile)
        for title in ("Registered Nurse - Nights", "Midwife - New Grad", "RN, Labor and Delivery"):
            self.assertTrue(passes_field_gate(patterns, title), title)
        # Both tracks write "RN"; it is one alternative, not two (and the gate is case-insensitive).
        self.assertEqual(len(patterns.field_include.pattern.split("|")), 3)

    def test_keywords_are_words_not_substrings(self):
        """A keyword matches as a word, so a field cannot be screened by accident.

        A boundary test that treats `-` as a word character misses "Nurse-Practitioner" - the spelling
        boards actually use - which is why the keywords are braced by lookarounds and not by `\\b`.
        """
        patterns, _ = snp.field_patterns({"filters": {"field_include": ["nurse"]}}, {})
        self.assertTrue(passes_field_gate(patterns, "Registered Nurse - Nights"))
        self.assertTrue(passes_field_gate(patterns, "Nurse-Practitioner, Family Medicine"))
        self.assertFalse(passes_field_gate(patterns, "Nursery School Teacher"),
                         "'nurse' must not match inside 'nursery'")

    def test_neither_the_registry_nor_the_profile_names_a_field(self):
        """The outcome that cannot be recovered from is REPORTED, not applied in silence.

        A screen that excludes everything and says nothing looks like a quiet market. So the shipped
        default stands - it is what the tool did before - and the note names both places to set the
        field.
        """
        for registry in ({}, {"greenhouse": {"example-health": "Example Health"}}, {"filters": {}}):
            with self.subTest(registry=registry):
                _, note = snp.field_patterns(registry, {})
                self.assertIn("field_include", note)
                self.assertIn("sources.json", note)
                self.assertIn("candidate_profile.json", note)
                self.assertIn("resume_tracks", note)
                # ... and it says the run is being screened by a default, not by a choice.
                self.assertIn("default", note)

    def test_a_registry_that_names_no_negative_gets_none(self):
        """A blocked title is a posting nobody ever sees, so the shipped negatives do not travel.

        `title_topics_exclude` shipped as "hardware roles - noise for a backend software candidate".
        A registry that writes a `filters` block and does not name it has not expressed that
        preference, and inheriting it would hide postings its owner cannot see are missing.
        """
        patterns, _ = snp.field_patterns(NURSING_REGISTRY, NURSING_PROFILE)
        self.assertIsNone(patterns.title_topics_exclude)
        configured, _ = snp.field_patterns(
            {"filters": {"field_include": ["nurse"], "title_topics_exclude": ["veterinary"]}}, {})
        # Named back, it works - and it does not take the rest of the field with it.
        self.assertTrue(configured.title_topics_exclude.search("Veterinary Nurse"))
        self.assertTrue(passes_field_gate(configured, "Registered Nurse - Nights"))


class TheDefaultBehaviourIsUnchangedTest(unittest.TestCase):
    """A run with no configuration screens as it did before the gates became configuration.

    This is the other half of the contract, and the reason `filters` ships populated. Six of the seven
    patterns are compared CHARACTER FOR CHARACTER with the constants they replaced, so a typo in a
    default - which is a silently different search - fails here and nowhere else: every case above
    passes on a configuration that never touches the defaults.

    THE SEVENTH IS COMPARED AS BEHAVIOUR, because it is deliberately not the same text. The default
    field was a bare-word regex; it is now the same six words compiled as words, and the two disagree on
    titles that a person reading the report would disagree with the old one about:
    "Senior Manager, Solution Engineering Enablement" was screened as an engineering posting because
    `engineer` sits inside "Engineering". The titles below are real ones, taken from this project's own
    screening reports, that only the old pattern kept.
    """

    #: Real titles from `output/screen/daily_*.json` that the bare-word regex kept and the braced words
    #: reject. Not one of them is a software-engineering requisition.
    TITLES_THE_BARE_WORD_PATTERN_KEPT = [
        "Senior Manager, Solution Engineering Enablement",
        "Physical Engineering Business Lead (Special Situations)",
        "Technical Program Manager, Global Programs — Applied AI Engineering",
    ]

    def setUp(self):
        self.patterns, self.note = snp.field_patterns({}, {})

    def test_the_six_other_shipped_patterns_survive_unchanged(self):
        for name in ("field_exclude", "title_topics_exclude", "region_include", "region_exclude",
                     "title_region_include", "title_region_exclude"):
            with self.subTest(pattern=name):
                self.assertEqual(getattr(self.patterns, name).pattern,
                                 getattr(LEGACY_DEFAULTS, name).pattern)

    def test_the_field_default_is_the_same_six_words(self):
        # Same words, same order: the text differs only in the brace around each one.
        self.assertEqual(sorted(self.patterns.field_include.pattern.split("|")),
                         sorted(f"(?<![A-Za-z0-9]){word}(?![A-Za-z0-9])"
                                for word in snp._DEFAULT_FIELD_INCLUDE))

    def test_the_region_answers_are_the_same_answers(self):
        for loc in ("", "Seattle, WA", "Remote - US", "Toronto, Canada", "London, UK",
                    "Sydney, Australia", "New York, NY; Dublin, Ireland"):
            with self.subTest(location=loc):
                self.assertEqual(snp.is_us(loc, self.patterns), snp.is_us(loc, LEGACY_DEFAULTS))

    def test_every_title_both_patterns_agree_about_still_agrees(self):
        for title in ("Senior Software Engineer", "Software Engineer, New Grad 2026",
                      "Hardware Engineer, ASIC", "New Grad Registered Nurse", "Product Designer",
                      "SDE II", "SWE Intern", "Nursery School Teacher"):
            with self.subTest(title=title):
                self.assertEqual(passes_field_gate(self.patterns, title),
                                 passes_field_gate(LEGACY_DEFAULTS, title), title)

    def test_the_titles_the_bare_word_pattern_kept_are_now_rejected(self):
        """The one intended difference, named. A widened default is a search that is not the searcher's."""
        for title in self.TITLES_THE_BARE_WORD_PATTERN_KEPT:
            with self.subTest(title=title):
                self.assertTrue(LEGACY_DEFAULTS.field_include.search(title),
                                "this title is only evidence while the old pattern kept it")
                self.assertFalse(self.patterns.field_include.search(title))

    def test_an_empty_profile_still_falls_back_to_the_shipped_field(self):
        # `field_patterns` is reached from daily_screen with the profile it already loaded; an empty
        # profile is the case where the fallback and the note about it have to fire together. The
        # fallback being the six shipped words is asserted above - this is the profile half of it.
        self.assertTrue(self.note)
        self.assertIsNotNone(self.patterns.field_include)


#: A synthetic board list in the shapes the boards return, one screening run's worth. The software
#: postings are the ones the live run surfaced, the nursing ones are the field it could not see, and
#: two of them are noise on purpose - the negative half and a title carrying a hardware word.
BOARD_LIST = [
    ("Example Health", "Senior Software Engineer", "Seattle, WA"),
    ("Example Health", "Software Engineer, New Grad 2026", "Austin, TX"),
    ("Example Clinic", "New Grad Registered Nurse - Medical Surgical", "Boston, MA"),
    ("Example Clinic", "Registered Nurse (RN) - New Graduate Program", "Chicago, IL"),
    ("Example Clinic", "Nurse Practitioner - Family Medicine", "Remote - US"),
    ("Example Clinic", "RN - Emergency Department - Nights", "Denver, CO"),
    ("Example Health", "Nurse Recruiter - Talent Acquisition", "New York, NY"),
    ("Example Health", "Hardware Engineer, New Grad", "San Jose, CA"),
    ("Example Clinic", "Nurse Informatics Analyst - Clinical Systems", "Portland, OR"),
]


def board_list_survivors(patterns) -> list[str]:
    """The titles `daily_screen` would keep from the board list above, in board order.

    The same gate the screener applies, with the region gate read through `is_us` so an unconfigured
    region cannot exclude anything.
    """
    return [title for _, title, loc in BOARD_LIST
            if passes_field_gate(patterns, title) and snp.is_us(loc, patterns) is not False]


class TheNursingRunTest(unittest.TestCase):
    """End to end through the gate: the run that reported nothing, before and after configuration.

    This is the measured failure written down as a screening run - 2164 postings excluded as
    `not_engineering` and three software results printed - so that a change to the gate has to show up
    here as a specific posting appearing or disappearing. The board list is synthetic and offline; the
    gate, the location reading and the order are the ones `daily_screen.py` uses.
    """

    def test_a_nursing_board_list_is_screened_before_configuration(self):
        # The default, named as a number: two software postings, every nursing posting counted against
        # a field that is not the applicant's. If this ever grows a nursing title, one of the shipped
        # defaults has been widened by accident.
        patterns, _ = snp.field_patterns({}, {})
        self.assertEqual(board_list_survivors(patterns),
                         ["Senior Software Engineer", "Software Engineer, New Grad 2026"])

    def test_the_same_board_list_is_screened_after_configuration(self):
        patterns, note = snp.field_patterns(NURSING_REGISTRY, NURSING_PROFILE)
        self.assertEqual(note, "")
        survivors = board_list_survivors(patterns)
        self.assertEqual(survivors, [
            "New Grad Registered Nurse - Medical Surgical",
            "Registered Nurse (RN) - New Graduate Program",
            "Nurse Practitioner - Family Medicine",
            "RN - Emergency Department - Nights",
            "Nurse Informatics Analyst - Clinical Systems"])
        # The two halves that make the list a test rather than a count: the field is no longer
        # excluded, and the field's own noise still is.
        self.assertNotIn("Senior Software Engineer", survivors)
        self.assertNotIn("Nurse Recruiter - Talent Acquisition", survivors)
        self.assertNotIn("Hardware Engineer, New Grad", survivors)


# --------------------------------------------------------------------------- the level vocabulary
#
# A THIRD VOCABULARY, AND A DIFFERENT QUESTION FROM THE FIELD GATE. "Senior", "Staff" and "Lead" are not
# field words - they are spelled the same in every field, and a nurse's posting saying "Senior" was always
# read correctly. What was software's alone is the spelling a field gives its own RUNGS: software writes
# "Software Engineer II", "SWE II" and "IC2", nursing writes "RN II", law writes "Associate", and the four
# patterns that read them were written into `daily_screen.py`. The cost is not a hidden posting but a
# mis-ranked one - "Registered Nurse II" came back `level: unknown`, so the posting lost the ranking weight
# its rung has earned - plus the management titles it never recognised: a nursing registry's
# "Director of Nursing" was not management to a list of software words, so it was kept and ranked as an
# ordinary role. The words now live in `levels` beside `filters` and default to exactly what shipped.
#
# `level_of` LIVES IN `daily_screen.py`, WITH THE RANKING IT FEEDS, and is loaded the way this file loads
# its other modules: by path, so nothing here depends on the working directory or on package layout.
_daily_spec = importlib.util.spec_from_file_location("daily_screen_under_test",
                                                     pathlib.Path(__file__).with_name("daily_screen.py"))
daily = importlib.util.module_from_spec(_daily_spec)
_daily_spec.loader.exec_module(daily)

#: The four patterns as the module constants they replaced, written out in full, so the shipped defaults
#: can be compared against the text that shipped rather than against a description of it.
LEGACY_LEVELS = {
    "junior": r"\bjunior\b|software engineer i\b|\bswe i\b|\bic1\b|level 1\b|associate software engineer",
    "mid": r"mid-?level|software engineer ii\b|\bswe ii\b|\bic2\b|level 2\b|software engineer 2\b",
    "senior": r"\bsenior\b|staff|principal|\blead\b",
    "management": (
        r"\b(?:engineering|software|technical|technology|sre|infrastructure|platform|data|devops|ml|ai"
        r"|web|frontend|backend|full[- ]?stack)\s+"
        r"(?:vice president|vp|director|manager|lead|head|chief)\b"
        r"|\b(?:vice president|vp|director|manager|head|chief)\s*,?\s*(?:of\s+)?"
        r"(?:engineering|software|technical|technology|sre|infrastructure|platform|data|devops|ml|ai"
        r"|web|frontend|backend|full[- ]?stack)\b"
    ),
}

#: The nursing registry with its own rungs named. `levels` sits BESIDE `filters` rather than inside it
#: because "which rung is this" and "is this my field" are different questions - see `LevelPatterns`.
NURSING_LEVELS = {
    "junior": ["nurse i", "rn i", "level 1", "new graduate nurse"],
    "mid": ["nurse ii", "rn ii", "level 2"],
    "senior": ["senior", "lead", "charge nurse", "nurse practitioner"],
    "management": ["nurse manager", "nursing director", "director of nursing", "nurse supervisor"],
}


def levels_registry(levels=None) -> dict:
    """The nursing board registry of this file, with a `levels` block when one is passed."""
    registry = dict(NURSING_REGISTRY)
    if levels is not None:
        registry = {**registry, "levels": levels}
    return registry


class TheLevelVocabularyIsConfigurationTest(unittest.TestCase):
    """(the title a board published, the level it should read as)"""

    def test_a_nursing_registry_reads_its_own_rungs(self):
        # The measured failure: every one of these came back `unknown`, so a posting that says which rung
        # it is asking for was ranked as if it had said nothing.
        levels = snp.level_patterns(levels_registry(NURSING_LEVELS))
        self.assertEqual(daily.level_of("Nurse I - Medical Surgical", "", levels), "junior")
        self.assertEqual(daily.level_of("Registered Nurse II - Medical Surgical", "", levels), "mid")
        self.assertEqual(daily.level_of("RN II, Labor and Delivery", "", levels), "mid")
        # AND THE OWNER OF THE POSTING IS STILL OUT OF SCOPE, which is what the management vocabulary is
        # for: this one is not a rung, it is a title the applicant has said they do not want.
        for title in ("Nurse Manager - Surgical Unit", "Director of Nursing", "Nursing Director"):
            with self.subTest(title=title):
                self.assertTrue(levels.management.search(title),
                                "a management title in this field must be recognised as one")
        self.assertFalse(levels.management.search("Registered Nurse II - Medical Surgical"))

    def test_the_seniority_words_are_not_field_words(self):
        """A nurse's posting saying "Senior" or "Lead" reads correctly with NOTHING configured.

        This is the half of the level vocabulary that is not a fact about a field, and it is why the
        levels are a separate block from `filters` rather than four more keys in it. If a change ever
        ties the generic words to a field's own rungs, this is where it shows up.
        """
        shipped = snp.level_patterns({})
        self.assertEqual(daily.level_of("Senior Registered Nurse", "", shipped), "senior")
        self.assertEqual(daily.level_of("Lead Registered Nurse - Nights", "", shipped), "senior")
        # "Lead" is an IC title and stays in scope: the shipped management vocabulary pairs a management
        # word with a FIELD word, and keeps the management word alone out of it.
        self.assertFalse(shipped.management.search("Lead Registered Nurse - Nights"))
        # The other direction, on the same vocabulary: a software management title still is one.
        self.assertTrue(shipped.management.search("Director of Engineering"))

    def test_a_nursing_registry_that_names_no_levels_is_read_with_software_rungs(self):
        """The cost of not naming them, asserted rather than implied - the ranking, not the gate.

        A registry that states its field and not its levels loses the rung and keeps the posting, which is
        the safe direction and the one this test pins: a missing `levels` block must never DELETE a title.
        """
        levels = snp.level_patterns(levels_registry())
        self.assertEqual(daily.level_of("Registered Nurse II - Medical Surgical", "", levels), "unknown")
        self.assertFalse(levels.management.search("Director of Nursing"),
                         "unconfigured is unrecognised, not excluded")

    def test_a_list_is_the_words_and_a_string_is_a_regex(self):
        """The same two spellings `filters` accepts, because it is the same reader underneath."""
        words = snp.level_patterns(levels_registry({"mid": ["nurse ii"]}))
        self.assertEqual(daily.level_of("Nurse II - Nights", "", words), "mid")
        self.assertEqual(daily.level_of("Nurse III - Nights", "", words), "unknown",
                         "a keyword is a whole word, not a prefix of the next rung")
        regex = snp.level_patterns(levels_registry({"mid": r"nurse i{2,3}"}))
        self.assertEqual(daily.level_of("Nurse III - Nights", "", regex), "mid")


class TheShippedLevelVocabularyIsUnchangedTest(unittest.TestCase):
    """A run that configures no levels reads them exactly as it did before there was a block to configure.

    This is the other half of the contract, proved the way `TheDefaultBehaviourIsUnchangedTest` proves the
    field half: character for character against the constants that shipped, so a typo in a default - which
    is a silently different ranking - fails here and nowhere else.
    """

    def setUp(self):
        self.levels = snp.level_patterns({})

    def test_the_four_shipped_patterns_survive_unchanged(self):
        for name, text in LEGACY_LEVELS.items():
            with self.subTest(pattern=name):
                self.assertEqual(getattr(self.levels, name).pattern, text)

    def test_the_level_a_software_run_reads_is_the_one_it_read(self):
        cases = [("Software Engineer", "unknown"), ("Software Engineer I", "junior"),
                 ("Software Engineer II", "mid"), ("SWE II", "mid"), ("IC2", "mid"),
                 ("Level 2 Backend Engineer", "mid"), ("Senior Software Engineer", "senior"),
                 ("Staff Software Engineer", "senior"), ("Engineering Intern", "intern"),
                 ("New Grad Software Engineer", "new_grad")]
        for title, want in cases:
            with self.subTest(title=title):
                self.assertEqual(daily.level_of(title, "", self.levels), want)

    def test_a_registry_block_for_a_field_does_not_leak_into_an_unconfigured_run(self):
        snp.level_patterns(levels_registry(NURSING_LEVELS))
        self.assertEqual(daily.level_of("Registered Nurse II - Medical Surgical", "", snp.level_patterns({})),
                         "unknown", "compiling one registry's levels must not change another's")


class TheLevelVocabularyIsReadableTest(unittest.TestCase):
    """`level_vocabulary`: the rung words as WORDS, for a caller that reports rather than screens.

    `job_app_assistant`'s "Seniority hints" line is that caller. It carried three software rung spellings
    of its own ("software engineer i", "software engineer ii", "ic2") beside the generic new-grad words,
    so a nursing registry could replace every level word the screen ranks by and the report would still
    print software's - the defect the `levels` block was added to remove, one line further down. The words
    now come from the block `level_patterns` reads.
    """

    def test_a_nursing_registry_is_readable_in_its_own_words(self):
        words = snp.level_vocabulary(levels_registry(NURSING_LEVELS))
        for want in ("nurse i", "rn i", "nurse ii", "rn ii"):
            with self.subTest(word=want):
                self.assertIn(want, words)
        for software in ("software engineer i", "software engineer ii", "ic2", "swe ii"):
            with self.subTest(word=software):
                self.assertNotIn(software, words, "a nursing registry is not read in software's words")

    def test_the_shipped_defaults_are_readable_and_are_the_software_ones(self):
        # `junior` and `associate software engineer` are the shipped `junior` pattern's own spellings, and
        # `level 1` proves a multi-word spelling survives; the `\b`-anchored alternatives are what the
        # reader has to take the anchors off.
        words = snp.level_vocabulary({})
        for want in ("software engineer i", "swe i", "ic1", "level 1", "associate software engineer",
                     "software engineer ii", "swe ii", "ic2", "level 2", "software engineer 2"):
            with self.subTest(word=want):
                self.assertIn(want, words)

    def test_a_regex_with_no_plain_spelling_does_not_invent_one(self):
        """`mid-?level` is a pattern, not a word, and "mid" is not a rung anybody is titled.

        A LIST is the words themselves; a STRING is a regex, and a regex whose alternatives are not
        spellings contributes nothing rather than a substring of itself.
        """
        words = snp.level_vocabulary(levels_registry({"mid": r"mid-?level|nurse i{2,3}"}))
        self.assertNotIn("mid", words, "a substring of a regex is not a vocabulary word")
        self.assertNotIn("nurse i", words, "nor is a prefix of one")

    def test_a_word_list_is_read_the_way_filters_reads_one(self):
        """Both spellings a `levels` value accepts produce words, and one key does not silence the other."""
        words = snp.level_vocabulary(levels_registry({"junior": ["level 1", "new graduate nurse"],
                                                      "mid": ["level 2", "charge nurse ii"]}))
        self.assertEqual(words, ["level 1", "new graduate nurse", "level 2", "charge nurse ii"])

    def test_the_management_words_are_not_rungs_and_are_not_returned(self):
        """The same line reports the postings the applicant is looking FOR, so the removal is not in it."""
        words = snp.level_vocabulary(levels_registry(NURSING_LEVELS))
        self.assertNotIn("nurse manager", words)
        self.assertNotIn("charge nurse", words)



class TheGateSaysWhereItCameFromTest(unittest.TestCase):
    """A field gate decides what the applicant never sees, so its words are always named."""

    def test_the_registry_answering_the_question_silences_the_note(self):
        # `filters.field_include` is the explicit answer; there is nothing left to warn about.
        #
        # A LIST IS WHOLE WORDS, so `nursing` does not match "Registered Nurse" - the two are different
        # words and the gate is not a stemmer. Both forms are named here because that is the trap: a
        # registry written with one and a board titled with the other excludes every posting silently.
        patterns, note = snp.field_patterns({"filters": {"field_include": ["nurse", "nursing"]}},
                                            {"resume_tracks": {"rn": {"keywords": ["bedside"]}}})
        self.assertTrue(passes_field_gate(patterns, "Registered Nurse"), "'nurse' should match")
        self.assertTrue(passes_field_gate(patterns, "Nursing Assistant"), "'nursing' should match")
        self.assertFalse(passes_field_gate(patterns, "Bedside Companion"), "the profile is not consulted")
        self.assertEqual(note, "")

    def test_nothing_configured_anywhere_still_says_so(self):
        # Dropping everything is the outcome that cannot be recovered from: the run would look like a
        # quiet market rather than a misconfiguration. The default stands and the note names both homes.
        patterns, note = snp.field_patterns({}, {})
        self.assertIn("no field configured", note)
        self.assertIn("filters.field_include", note)
        self.assertTrue(passes_field_gate(patterns, "Software Engineer"))


class PublishedPayTest(unittest.TestCase):
    """The band a posting published, reported in the currency it published it in.

    THE CASE THAT PAID FOR THIS. `pay_answer` matched `$`-prefixed amounts and nothing else, so a posting
    written "CAD 78,000 to 96,000" came back as "none published" and the reader was handed the fallback line
    for a posting that had published a range. Dropping the employer's own band and inventing one are the same
    failure from the candidate's side: the figure in front of the model that writes the compensation answer is
    then not the employer's.
    """

    def test_a_band_written_with_a_currency_code_is_reported_in_that_currency(self):
        band, answer = screen.pay_answer("The base salary for this role is CAD 78,000 to 96,000 per year.")
        self.assertEqual(band, "CAD 78,000 - CAD 96,000")
        self.assertEqual(answer, "CAD 96,000 (top of band)",
                         "the top of the band, in the currency the posting used - not a bare $ figure")

    def test_the_usd_shape_the_earlier_notes_quote_is_unchanged(self):
        # Widening the parser must not rewrite the output every existing note quotes.
        band, answer = screen.pay_answer("Base salary range: $127,100 - $185,000.")
        self.assertEqual(band, "$127,100 - $185,000")
        self.assertEqual(answer, "$185,000 (top of band)")

    def test_the_currency_carries_across_a_range_that_names_it_once(self):
        # The spelling the standing rule's own example uses: the code once, the second figure bare. Without a
        # running currency that second figure is uncounted and a published band looks like a lone number.
        band, _ = screen.pay_answer("USD 120,000 - 150,000")
        self.assertEqual(band, "$120,000 - $150,000", "USD is the currency the `$` reports")

    def test_a_range_written_with_another_symbol_is_not_dropped_either(self):
        band, _ = screen.pay_answer("Compensation: €90,000 - 110,000 depending on location.")
        self.assertEqual(band, "EUR 90,000 - EUR 110,000")

    def test_two_currencies_are_reported_side_by_side_rather_than_added_together(self):
        # No exchange rate is attempted, so the two ranges stay two ranges - and a multi-region posting is
        # exactly the case the line's own note warns the reader about.
        band, answer = screen.pay_answer("USD 180,000 - 250,000 in the US; CAD 150,000 - 200,000 in Canada.")
        self.assertEqual(band, "$180,000 - $250,000 | CAD 150,000 - CAD 200,000")
        self.assertEqual(answer, "$250,000 (top of band) / CAD 200,000 (top of band)")

    def test_figures_with_no_currency_at_all_are_still_not_a_band(self):
        # The invention the widening must not start doing: two unrelated counts in one description are not a
        # compensation range, and reading them as one would put a band nobody published in front of the model.
        self.assertEqual(screen.pay_answer("We serve 50,000 users and have shipped 80,000 downloads."),
                         (None, None))

    def test_a_lone_figure_is_still_not_a_band(self):
        # Unchanged from before the widening: one number is a lower bound wearing a band's clothes.
        self.assertEqual(screen.pay_answer("A reasonable estimate of the base salary range is $79,040."),
                         (None, None))


class TheFallbackIsRecordedNotTypedTest(unittest.TestCase):
    """With nothing published, the line answers from the profile - never from a figure written into this file.

    THE CASE THAT PAID FOR THIS. The line read "none published -> answer $150,000 - $170,000 (fallback)": two
    figures in the source, and they were one person's. They were also already stale - the recorded fallback is
    a single number in `candidate_profile.json -> candidate.standing_answers.compensation`, which
    docs/CONFIGURATION.md names as the one home for it - so the screener handed the model a figure the profile
    does not hold, and what the model is handed is what reaches a live form as the candidate's own
    compensation expectation. This was the one place in the toolkit that bypassed that field.
    """

    PROFILE = {"candidate": {"standing_answers": {"compensation": {
        "rule": "top_of_published_band", "fallback": 137500, "currency": "USD"}}}}

    def test_the_line_answers_from_the_profile_file_the_drafter_reads(self):
        # The whole chain, against a profile this checkout does not have to own: the screener asks the
        # drafter's resolver, and the resolver reads the file the drafter's own DATA_DIR points at.
        from src.forms import draft_form_spec
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "candidate_profile.json"
            path.write_text(json.dumps(self.PROFILE), encoding="utf-8")
            with mock.patch.object(draft_form_spec, "DATA_DIR", pathlib.Path(d)):
                line = screen.pay_line(None, None)
        self.assertIn("$137,500", line)
        self.assertIn("standing_answers.compensation", line,
                      "the line names the field, so the fix for a missing number is findable")

    def test_the_number_follows_the_profile_rather_than_a_constant(self):
        # A different profile, a different number, no code change - which is what makes the value testable at
        # all, and what a hardcoded pair can never be.
        line = screen.pay_line(None, None, {"standing_answers": {"compensation": {"fallback": 123456}}})
        self.assertIn("$123,456", line)

    def test_a_recorded_currency_other_than_usd_is_named(self):
        line = screen.pay_line(None, None,
                               {"standing_answers": {"compensation": {"fallback": 96000, "currency": "CAD"}}})
        self.assertIn("CAD 96,000", line)

    def test_no_recorded_number_is_an_explicit_miss_rather_than_a_figure(self):
        line = screen.pay_line(None, None, {"standing_answers": {}})
        self.assertIn("ask the user", line)
        self.assertNotRegex(line, r"\d", "a profile that records nothing must not be answered with a number")

    def test_the_rule_is_the_drafters_and_not_a_second_copy(self):
        from src.forms import draft_form_spec
        self.assertIs(screen.compensation_rule, draft_form_spec.compensation_rule,
                      "a second resolver in the screener is how this figure drifted in the first place")

    def test_the_printed_pay_line_carries_the_recorded_number(self):
        # The defect was a printed line, so this drives report() rather than the helper beneath it.
        buf = io.StringIO()
        with mock.patch.object(screen, "compensation_rule",
                               return_value={"rule": "top_of_published_band", "fallback": 137500,
                                             "currency": "USD"}):
            with contextlib.redirect_stdout(buf):
                screen.report("board", "Software Engineer", "Remote", "Competitive compensation.",
                              "https://x", set())
        pay = [line for line in buf.getvalue().splitlines() if line.strip().startswith("pay")][0]
        self.assertIn("$137,500", pay)

    def test_no_compensation_figure_is_hardcoded_in_the_screener(self):
        # The enforced half: the pair that used to be printed here must not come back as a literal. A figure in
        # the source is a figure about one person, and it is the copy that drifts.
        source = MODULE.read_text(encoding="utf-8")
        for literal in ("150,000", "170,000"):
            self.assertNotIn(literal, source, "a hardcoded compensation figure is back in the screener")


if __name__ == "__main__":
    unittest.main()

