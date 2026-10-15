#!/usr/bin/env python3
"""The three screeners that carried a field gate of their own, and the vocabulary they carried instead.

WHY THIS FILE IS NOT `test_screen_patterns.py`. That file is the home of the screening PATTERNS - a row
per title, asserting what the gate does with it - and its own comment records why it is careful with
global state: it points `ATS_DATA_DIR` at an empty directory around its loads and puts it back, because a
set left standing made every later test read a directory that does not exist. These three cases need
something that file must not do: they run a module whose BODY IS THE SCAN (importing `scan_registry_fresh`
fetches boards), against a fabricated `<data>/` and a canned board, with `src.paths` swapped for the
duration. That is a heavier harness than a pattern table, and it belongs where the swap can be read in one
place. The level vocabulary - the fourth case of the same change - is a pattern table and lives in
`test_screen_patterns.py`.

A FIFTH CASE FOLLOWED THE SAME THREE, and its home is this file too because it is about these two scanners:
`scan_registry_fresh.BADLVL` and `scan_tracker_tenants.SKIP_TITLE` were each ONE regex mixing a field's
words with words every field writes, so a nursing board was judged by `qa|ios|mobile`. The half that is a
fact about a field is now `filters.skip_title` and the half that is not stays in the code - see
`TheTitleGateIsTwoVocabulariesTest`.

THE CASES. Three screeners each held their own idea of the applicant's field, written into the source:
`scan_registry_fresh.TITLE` (an entire software-job regex, and that scan's only field gate),
`scan_tracker_tenants.TITLES` (a tuple of software job titles, tested by substring against a live board),
and `list_board_jobs.ROLE_HINTS` (`engineer|developer|swe|architect|programmer`, this tool's own idea of
what a role is). On a nursing board all three printed nothing, and "the scanner returned zero" is
indistinguishable from "there is nothing there" - which is exactly the failure `list_board_jobs.py` was
written to escape in the first place. The words now come from the shared model (`field_patterns`), which
reads `filters.field_include` from the board registry and, when that names none, the profile's own
`resume_tracks[*].keywords`.

EACH CASE IS RUN THREE WAYS, because two of them are the ones that make it evidence: the field named as a
NURSE (the postings appear), the LEGACY software vocabulary named back (they do not - so the fix is doing
the work, not the fixture), and NOTHING configured (the software postings, i.e. what every checkout did
before this change and must keep doing).
"""
from __future__ import annotations

import contextlib
import csv
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
import urllib.request
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCREENING = ROOT / "src" / "screening"
REGISTRY_SCAN = SCREENING / "scan_registry_fresh.py"
TENANT_SCAN = SCREENING / "scan_tracker_tenants.py"
BOARD_LIST = SCREENING / "list_board_jobs.py"

#: The shared model, loaded by path for the one assertion that has to ask it directly: that the mark
#: `list_board_jobs` prints is THIS gate's answer and not a second vocabulary wearing its name.
_SHARED_SPEC = importlib.util.spec_from_file_location("screen_newgrad_postings_for_gates",
                                                      SCREENING / "screen_newgrad_postings.py")
snp = importlib.util.module_from_spec(_SHARED_SPEC)
_SHARED_SPEC.loader.exec_module(snp)

#: The vocabulary each module carried, written out so "the nursing postings appear now" is compared with
#: the words that really did drop them rather than with a description of them.
LEGACY_REGISTRY_TITLE = (
    r"software engineer|full.?stack|backend|back-end|platform engineer|product engineer|"
    r"software development engineer|founding engineer|member of technical staff|"
    r"ai engineer|machine learning engineer|ml engineer|application engineer|"
    r"infrastructure engineer|cloud engineer|api engineer|integration engineer"
)
LEGACY_TENANT_TITLES = ["software engineer", "backend", "full stack", "full-stack", "ai engineer",
                        "ml engineer", "platform engineer"]
LEGACY_ROLE_HINTS = r"(engineer|developer|swe|architect|programmer)"
#: `scan_registry_fresh.BADLVL`, as it shipped: ONE regex holding the level words, the non-target families
#: and software's own noise together. The change split it by the only test that decides a configuration
#: key - does a fact about a FIELD change the answer - so this text is the material for both halves, and
#: the case below asserts the two of them still cover it exactly.
LEGACY_BADLVL = (
    r"staff|principal|manager|lead|director|head|architect|intern|ios|android|mobile|qa|"
    r"test|data engineer|machine learning|devops|sre|analyst|sales|support|solutions"
)
#: `scan_tracker_tenants.SKIP_TITLE`, as it shipped: the same judgement in the other scanner's words.
LEGACY_SKIP_TITLE = ("manager", "director", "intern", "recruiter", "sales", "account")

#: The postings a nursing search is looking for, the software ones it is not, and one management title -
#: which every vocabulary in these modules treats as out of scope for the applicant's own reasons.
NURSING_TITLES = ["New Grad Registered Nurse - Medical Surgical",
                  "Registered Nurse (RN) - New Graduate Program",
                  "Nurse Practitioner - Family Medicine"]
SOFTWARE_TITLES = ["Senior Software Engineer", "Software Engineer, New Grad 2026"]

BOARD = [
    {"id": 1, "title": NURSING_TITLES[0], "location": {"name": "Boston, MA"}},
    {"id": 2, "title": NURSING_TITLES[1], "location": {"name": "Chicago, IL"}},
    {"id": 3, "title": NURSING_TITLES[2], "location": {"name": "Portland, OR"}},
    {"id": 4, "title": "Nurse Manager - Surgical Unit", "location": {"name": "Denver, CO"}},
    {"id": 5, "title": SOFTWARE_TITLES[0], "location": {"name": "Seattle, WA"}},
    {"id": 6, "title": SOFTWARE_TITLES[1], "location": {"name": "Austin, TX"}},
]

#: The titles the TITLE GATE decided, as against the field gate: a rung, a family, and the field's own
#: noise. Each is a real posting shape, and each carries exactly one of the words in question.
LEVEL_TITLES = ["Staff Software Engineer", "Principal Engineer", "Engineering Manager",
                "Director of Engineering", "Engineering Intern"]
FIELD_NOISE_TITLES = ["QA Engineer, Platform", "iOS Engineer", "Mobile Engineer", "DevOps Engineer"]
#: The applicant's own field, which no vocabulary may drop. `Mobile Clinic Nurse` is here on purpose: it
#: carries a software noise word and is a nursing posting, which is the whole reason that half is
#: configurable rather than shipped.
NURSING_TITLES_KEPT = ["Registered Nurse - Nights", "Nurse Manager - Surgical Unit", "Charge Nurse",
                       "Mobile Clinic Nurse", "Director of Nursing"]


#: The applicant's own words for nursing, in the shape `filters.field_include` documents: a list, so a
#: keyword is a whole word and "nurse" does not screen "Nursery School Teacher".
NURSING_FIELD = ["registered nurse", "RN", "nurse practitioner", "nurse"]


def registry(field=None, levels=None, skip=None) -> dict:
    """A registry with one nursing board: the blocks it was passed, and no others."""
    reg = {"greenhouse": {"example-health": "Example Health"}}
    filters = {}
    if field is not None:
        filters["field_include"] = field
    if skip is not None:
        filters["skip_title"] = skip
    if filters:
        reg["filters"] = filters
    if levels is not None:
        reg["levels"] = levels
    return reg


def skip_gates(patterns) -> list:
    """The two patterns a scanner applies to a TITLE to decide it is not worth reading.

    `GENERAL_SKIP_TITLE` is the half no field translates and `patterns.skip_title` is the half this change
    made configurable; a scanner applies both, so a case here has to as well.
    """
    return [snp.GENERAL_SKIP_TITLE, *([patterns.skip_title] if patterns.skip_title else [])]


def without_braces(text: str) -> str:
    """A compiled gate's text with the whole-word braces taken off, for comparing vocabularies."""
    return snp.BRACE.sub("", text)


class _Board:
    """A Greenhouse board's JSON as `urllib.request.urlopen` hands it back (`.read()` and a context)."""

    def __init__(self, jobs):
        self._payload = json.dumps({"jobs": jobs}).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


#: Every module that resolves `DATA_DIR` at import and has to be re-read for a fabricated one. `src.paths`
#: resolves `ATS_DATA_DIR` ONCE PER PROCESS, so the environment variable cannot do this job here: the full
#: suite imports `src.paths` long before this module is collected, and the answer it cached is the
#: checkout's own `data/`. Swapping the module object for the duration is the same idea pointed at the
#: cache instead of the environment, and it is put back in a `finally` for the same reason.
_RELOADED = ("tracker_index", "screen_newgrad_postings", "src.screening.screen_newgrad_postings")


@contextlib.contextmanager
def fabricated_data_dir(reg: dict, tracker_source: str = ""):
    """A `<data>/` holding this registry and a tracker, with the screening modules re-read from it."""
    with tempfile.TemporaryDirectory(prefix="scanner-gates-") as tmp:
        data = pathlib.Path(tmp)
        (data / "screening").mkdir()
        (data / "screening" / "sources.json").write_text(json.dumps(reg), encoding="utf-8")
        with (data / "applications.csv").open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=["date_added", "company", "title", "source", "status"])
            writer.writeheader()
            if tracker_source:
                writer.writerow({"date_added": "2026-10-01", "company": "Example Health",
                                 "title": "Registered Nurse - Nights", "source": tracker_source,
                                 "status": "not_applied"})
        stub = types.ModuleType("src.paths")
        stub.ROOT = ROOT
        stub.DATA_DIR = data
        saved = {name: sys.modules.get(name) for name in ("src.paths", *_RELOADED)}
        sys.modules["src.paths"] = stub
        for name in _RELOADED:
            sys.modules.pop(name, None)
        try:
            yield data
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


def run_scan(module_path: pathlib.Path, reg: dict, tracker_source: str = "") -> tuple[str, list]:
    """Import a screener whose import IS the scan, and return (what it printed, the URLs it fetched)."""
    with fabricated_data_dir(reg, tracker_source):
        spec = importlib.util.spec_from_file_location(f"{module_path.stem}_under_test", module_path)
        module = importlib.util.module_from_spec(spec)
        fetched: list = []

        def canned(request, *args, **kwargs):
            fetched.append(getattr(request, "full_url", request))
            return _Board(BOARD)

        printed = io.StringIO()
        with mock.patch.object(urllib.request, "urlopen", canned), contextlib.redirect_stdout(printed):
            spec.loader.exec_module(module)
        return printed.getvalue(), fetched


def printed_titles(out: str) -> list[str]:
    """Every board title the run put in front of the reader, in the order it printed them."""
    return [job["title"] for job in BOARD if job["title"] in out]


class TheTitleGateIsTwoVocabulariesTest(unittest.TestCase):
    """The words that screen a title OUT, split by the one test that decides a configuration key.

    A FIELD fact changes its answer, a general one does not. `manager`, `director` and `intern` are what
    every field writes the manager/lead track with, so they need no configuration and stay in the code
    that applies them; `qa`, `ios`, `android` and `devops` are software's own noise, so they travel with
    the registry and a nursing board is never judged by them. The case that pays for this: a nursing
    search on a hospital's board dropped "Mobile Clinic Nurse" with a software word list - a real role,
    hidden by a fact about a different field.
    """

    def test_the_two_halves_still_cover_the_single_regex_they_replaced(self):
        """Nothing may be lost or gained in the split: the old words are still exactly the new ones.

        COMPARED AS SETS, because what the split reordered is the regex's alternatives and an alternation
        is unordered for everything that matters here - a word list is what a person edits, an order is
        not. THE LEGACY TEXT IS THE EVIDENCE: `BADLVL` as it shipped, plus the two words only `SKIP_TITLE`
        carried, against the general pattern's alternatives added to the field pattern's.
        """
        patterns, _ = snp.field_patterns({}, {})
        general = without_braces(snp.GENERAL_SKIP_TITLE.pattern).split("|")
        field = without_braces(patterns.skip_title.pattern).split("|")
        legacy = set(LEGACY_BADLVL.split("|")) | set(LEGACY_SKIP_TITLE)
        self.assertEqual(set(general + field), legacy,
                         "the split changed the vocabulary it was supposed to preserve")
        for word in LEGACY_SKIP_TITLE:
            with self.subTest(word=word):
                self.assertIn(word, general,
                              "a word the tenant scan carried is missing from the general half")

    def test_an_unconfigured_run_drops_exactly_what_it_dropped_before(self):
        """The contract every change here carries: no `filters` block, no difference in behaviour."""
        legacy = snp.re.compile(LEGACY_BADLVL, snp.re.I)
        patterns, _ = snp.field_patterns({}, {})
        gates = skip_gates(patterns)
        for title in LEVEL_TITLES + FIELD_NOISE_TITLES + NURSING_TITLES_KEPT:
            with self.subTest(title=title):
                self.assertEqual(any(g.search(title) for g in gates), bool(legacy.search(title)), title)

    def test_the_level_and_family_words_are_applied_without_being_configured(self):
        """`manager`/`director`/`intern` are not a field's, so no registry has to name them back."""
        patterns, _ = snp.field_patterns(registry(NURSING_FIELD), {})
        gates = skip_gates(patterns)
        for title in LEVEL_TITLES:
            with self.subTest(title=title):
                self.assertTrue(any(g.search(title) for g in gates), title)

    def test_a_nursing_registry_is_not_judged_by_software_noise_words(self):
        """The other half of the split, and the reason it exists: those words ARE the field's."""
        patterns, _ = snp.field_patterns(registry(NURSING_FIELD), {})
        self.assertIsNone(patterns.skip_title,
                          "a registry that named a field and no skip words has no field gate")
        for title in FIELD_NOISE_TITLES:
            with self.subTest(title=title):
                self.assertFalse(patterns.field_include.search(title),
                                 "a software posting is not in a nursing search either")
        # The noise words do not travel: a nursing title carrying one is kept.
        self.assertTrue(patterns.field_include.search("Mobile Clinic Nurse"))
        self.assertFalse(any(g.search("Mobile Clinic Nurse") for g in skip_gates(patterns)))

    def test_a_registry_that_names_its_own_noise_words_gets_them(self):
        patterns, _ = snp.field_patterns(registry(NURSING_FIELD, skip=["veterinary", "kennel"]), {})
        gates = skip_gates(patterns)
        self.assertTrue(any(g.search("Veterinary Technician") for g in gates))
        self.assertTrue(any(g.search("Kennel Assistant") for g in gates))
        self.assertFalse(any(g.search("Registered Nurse - Nights") for g in gates))
        # Replaced, not added to: the software list did not come along.
        self.assertFalse(any(g.search("QA Nurse Coordinator") for g in gates))

    def test_both_scanners_apply_the_general_half_and_the_field_half(self):
        """A scanner that took only one of them would either drop nothing or drop someone else's list."""
        for module_path, source in ((REGISTRY_SCAN, REGISTRY_SCAN.read_text(encoding="utf-8")),
                                    (TENANT_SCAN, TENANT_SCAN.read_text(encoding="utf-8"))):
            with self.subTest(module=module_path.name):
                self.assertIn("GENERAL_SKIP_TITLE", source,
                              "the words no field translates must still be applied")
                self.assertIn("skip_title", source,
                              "the field's own words must come from the registry, not from this file")


class TheRegistryScanScreensInTheApplicantsFieldTest(unittest.TestCase):
    """`scan_registry_fresh.py`, whose body fetches every board in the registry as it is imported."""

    def test_a_nursing_registry_reaches_the_nursing_postings(self):
        out, fetched = run_scan(REGISTRY_SCAN, registry(NURSING_FIELD))
        self.assertTrue(fetched, "the board must have been fetched - a silent skip proves nothing")
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertIn(title, out)
        for title in SOFTWARE_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out, "this registry named nursing, not software")

    def test_the_vocabulary_it_carried_dropped_every_one_of_them(self):
        """The case that paid for this: the same board, screened by the words the module shipped with."""
        out, _ = run_scan(REGISTRY_SCAN, registry(LEGACY_REGISTRY_TITLE))
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out)
        self.assertIn(SOFTWARE_TITLES[0], out)

    def test_a_run_that_names_no_field_screens_exactly_as_before(self):
        out, _ = run_scan(REGISTRY_SCAN, registry())
        self.assertIn(SOFTWARE_TITLES[0], out)
        self.assertIn(SOFTWARE_TITLES[1], out)
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out)

    def test_the_software_title_regex_is_not_back_in_the_module(self):
        # The same shape as the pay-line guard in test_screen_patterns.py: a vocabulary written into the
        # source is the defect, so the fragment that made it software's is asserted absent, and the gate
        # that replaced it is asserted present.
        source = REGISTRY_SCAN.read_text(encoding="utf-8")
        self.assertNotIn("full.?stack", source, "a hardcoded title vocabulary is back in this scanner")
        self.assertIn("field_patterns", source)


class TheTenantScanScreensInTheApplicantsFieldTest(unittest.TestCase):
    """`scan_tracker_tenants.py`, which re-reads the live board of every tenant the tracker knows."""

    TRACKER_SOURCE = "https://job-boards.greenhouse.io/example-health/jobs/999"

    def test_a_nursing_registry_reaches_the_nursing_postings(self):
        out, fetched = run_scan(TENANT_SCAN, registry(NURSING_FIELD), self.TRACKER_SOURCE)
        self.assertTrue(fetched, "the tenant's board must have been fetched")
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertIn(title, out)
        for title in SOFTWARE_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out)

    def test_the_title_tuple_it_carried_dropped_every_one_of_them(self):
        out, _ = run_scan(TENANT_SCAN, registry(LEGACY_TENANT_TITLES), self.TRACKER_SOURCE)
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out)
        self.assertIn(SOFTWARE_TITLES[0], out)

    def test_a_run_that_names_no_field_screens_exactly_as_before(self):
        out, _ = run_scan(TENANT_SCAN, registry(), self.TRACKER_SOURCE)
        self.assertIn(SOFTWARE_TITLES[0], out)
        for title in NURSING_TITLES:
            with self.subTest(title=title):
                self.assertNotIn(title, out)

    def test_the_substring_title_list_is_not_back_in_the_module(self):
        source = TENANT_SCAN.read_text(encoding="utf-8")
        self.assertNotIn("ml engineer", source, "a hardcoded title list is back in this scanner")
        self.assertIn("field_patterns", source)


class TheBoardListingShowsEveryJobAndMarksTheFieldTest(unittest.TestCase):
    """`list_board_jobs.py`, whose job is to show what is ON a board - so it must hide nothing.

    Its own docstring says it prints every job "with no filtering", and its history is a filter that hid
    two real postings. `ROLE_HINTS` was a second version of that mistake: this file's idea of what a role
    is, which on a hospital's board matched nothing. The field now MARKS the rows instead of choosing
    them, and these cases pin both halves - nothing is hidden, and the mark is the screening gate's own
    answer rather than a second vocabulary.
    """

    def listing(self, reg: dict) -> str:
        with fabricated_data_dir(reg):
            spec = importlib.util.spec_from_file_location("list_board_jobs_under_test", BOARD_LIST)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            jobs = [(j["title"], j["location"]["name"],
                     f"https://job-boards.greenhouse.io/example-health/jobs/{j['id']}") for j in BOARD]
            printed = io.StringIO()
            with mock.patch.object(module, "fetch", return_value=jobs), \
                    mock.patch.object(sys, "argv", ["list_board_jobs.py", "gh:example-health"]), \
                    contextlib.redirect_stdout(printed):
                self.assertEqual(module.main(), 0)
            return printed.getvalue()

    def test_every_job_on_the_board_is_printed_whatever_the_field_is(self):
        out = self.listing(registry(NURSING_FIELD))
        self.assertEqual(printed_titles(out), [job["title"] for job in BOARD])
        # The one the legacy gate hid: `Nurse Manager` carries none of engineer/developer/swe/architect.
        self.assertIn("Nurse Manager - Surgical Unit", out)

    def test_the_mark_is_the_screening_gates_own_answer(self):
        reg = registry(NURSING_FIELD)
        out = self.listing(reg)
        patterns, _ = snp.field_patterns(reg, {})
        for job in BOARD:
            line = next((ln for ln in out.splitlines() if job["title"][:70] in ln), "")
            with self.subTest(title=job["title"]):
                self.assertTrue(line, "every job is printed, so every job has a line")
                self.assertEqual(line.strip().startswith("F"),
                                 bool(patterns.field_include.search(job["title"])),
                                 "the mark and the screen must be the same question asked once")
        self.assertIn("roles in your field:", out)

    def test_a_run_that_names_no_field_marks_the_software_postings(self):
        out = self.listing(registry())
        marked = [line for line in out.splitlines() if line.strip().startswith("F")]
        self.assertTrue(any(SOFTWARE_TITLES[0][:20] in line for line in marked),
                        "the shipped field words still mark software postings")
        self.assertFalse(any("Registered Nurse" in line for line in marked))

    def test_the_legacy_role_hints_would_have_hidden_the_field_entirely(self):
        """The case the tool exists for, as a check on the fixture rather than on the code.

        `ROLE_HINTS` is asserted against the titles this file lists, so a future change to the fixture
        cannot quietly turn the two cases above into tests of nothing.
        """
        import re
        legacy = re.compile(LEGACY_ROLE_HINTS, re.I)
        self.assertEqual([t for t in NURSING_TITLES if legacy.search(t)], [],
                         "not one nursing title carries a word the legacy gate looked for")


if __name__ == "__main__":
    unittest.main()
