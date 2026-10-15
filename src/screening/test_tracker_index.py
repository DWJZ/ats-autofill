#!/usr/bin/env python3
"""The shared tracker primitives, and the two traps every screener used to rediscover on its own.

Run:  .venv/bin/python3 -m unittest src.screening.test_tracker_index
"""
from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import tracker_index as tracker


class TheTwoTrapsStayFixed(unittest.TestCase):
    def test_root_is_the_repo_root_not_the_src_directory(self):
        """`parents[1]` resolved to `src/data/applications.csv` and killed a whole scan with FileNotFoundError."""
        # THE RESOLVED FILE, NOT THE LITERAL PATH. The tracker is read from the configured data directory
        # (`ATS_DATA_DIR`, see `src/paths.py`), so what has to hold is that the path the shared reader resolves is
        # a real file - which is exactly what `parents[1]` failed, because `src/data/applications.csv` is nothing.
        # Asserting `ROOT / "data" / "applications.csv"` here would instead pin the DEFAULT directory and fail
        # every run that points the setting somewhere else, which is the one thing it must not do.
        self.assertTrue(tracker.TRACKER.is_file(), f"no tracker at {tracker.TRACKER}")
        # THE DEPTH IS THE TRAP, NOT THE NAME. Asserting the directory was called by the private checkout's own
        # folder name pinned that name rather than the resolution, so it failed on any other one - an extracted
        # copy, a clone into a differently named directory. What must hold is that ROOT is this file's own
        # grandparent (src/screening/tracker_index.py, two levels up), whatever the repository is called.
        here = pathlib.Path(tracker.__file__).resolve()
        self.assertEqual(tracker.ROOT, here.parents[2],
                         "ROOT must be the repo root, derived from this file's own location")

    def test_the_bom_is_stripped_so_the_first_column_key_is_plain(self):
        """The file carries a UTF-8 BOM: a plain utf-8 read makes the first key `\\ufeffdate_added` and the first
        row raises KeyError. This asserts the column name, not merely that loading succeeded."""
        rows = tracker.load_rows()
        self.assertGreater(len(rows), 0)
        self.assertIn("date_added", rows[0], "the BOM leaked into the first column key")
        self.assertNotIn("\ufeffdate_added", rows[0])

    def test_a_plain_utf8_read_is_what_would_break(self):
        """Pins why utf-8-sig is load-bearing, so nobody 'simplifies' it away."""
        import csv
        with open(tracker.TRACKER, encoding="utf-8", newline="") as handle:
            broken = next(csv.DictReader(handle))
        self.assertNotIn("date_added", broken)


class Normalisation(unittest.TestCase):
    def test_case_and_punctuation_collapse_to_one_form(self):
        self.assertEqual(tracker.norm("Senior Full-Stack Software Engineer, Community"),
                         tracker.norm("Senior Full Stack Software Engineer Community"))

    def test_repeated_separators_do_not_produce_empty_tokens(self):
        self.assertEqual(tracker.norm("bestow   software  engineer ii"), "bestow software engineer ii")

    def test_none_and_empty_are_empty_strings(self):
        self.assertEqual(tracker.norm(None), "")
        self.assertEqual(tracker.norm(""), "")


class RequisitionIds(unittest.TestCase):
    def test_an_ashby_uuid_is_found(self):
        self.assertIn("a172ada5-1a6e-4646-8e0d-26747422af24",
                      tracker.req_ids("https://jobs.ashbyhq.com/perplexity/a172ada5-1a6e-4646-8e0d-26747422af24"))

    def test_a_greenhouse_jobs_id_is_found(self):
        self.assertIn("5424404008", tracker.req_ids("https://job-boards.greenhouse.io/anthropic/jobs/5424404008"))

    def test_a_greenhouse_token_is_found(self):
        self.assertIn("8788272002", tracker.req_ids(
            "https://job-boards.greenhouse.io/embed/job_app?token=8788272002&for=chime"))

    def test_ids_are_lower_cased_for_set_comparison(self):
        found = tracker.req_ids("https://jobs.ashbyhq.com/x/A172ADA5-1A6E-4646-8E0D-26747422AF24")
        self.assertTrue(all(i == i.lower() for i in found))

    def test_no_ids_is_an_empty_set_not_a_crash(self):
        self.assertEqual(tracker.req_ids(""), set())
        self.assertEqual(tracker.req_ids(None), set())


class SubmittedRows(unittest.TestCase):
    def test_only_the_submitted_statuses_count_as_an_application(self):
        rows = [{"status": "submitted_by_agent"}, {"status": "submitted_by_user"},
                {"status": "not_applied"}, {"status": "materials_ready"}, {"status": ""}]
        kept = tracker.submitted_rows(rows)
        self.assertEqual(len(kept), 2)
        self.assertEqual({r["status"] for r in kept}, {"submitted_by_agent", "submitted_by_user"})

    def test_against_the_real_tracker_it_finds_submissions(self):
        rows = tracker.load_rows()
        submitted = tracker.submitted_rows(rows)
        self.assertGreater(len(submitted), 0)
        self.assertLess(len(submitted), len(rows))


class TheScreenersShareIt(unittest.TestCase):
    """The point of the module: every screener that reads the tracker must go through it, not carry its own copy.

    Each of these five had its own `open(...utf-8-sig)` and its own `parents[N]` until 2026-10-06, which is why
    each had to rediscover the BOM and the root-depth trap separately. `daily_screen` and `screen_newgrad_postings`
    keep their own thin wrappers (`load_tracker_rows`, `load_tracker`) because they add behaviour — an existence
    check and a title normaliser — but those wrappers now delegate here.
    """

    SCREENERS = (
        "filter_unapplied.py",
        "check_duplicate.py",
        "scan_registry_fresh.py",
        "harvest_board_slugs.py",
        "screen_urls.py",
        "daily_screen.py",
        "screen_newgrad_postings.py",
    )

    def source(self, name: str) -> str:
        return (pathlib.Path(__file__).resolve().parent / name).read_text(encoding="utf-8")

    def test_every_screener_that_reads_the_tracker_imports_the_shared_module(self):
        for name in self.SCREENERS:
            with self.subTest(screener=name):
                self.assertIn("from tracker_index import", self.source(name))

    def test_no_screener_still_opens_the_tracker_itself(self):
        for name in self.SCREENERS:
            with self.subTest(screener=name):
                source = self.source(name)
                self.assertNotIn('open(ROOT / "data/applications.csv"', source)
                self.assertNotIn('TRACKER.open(encoding="utf-8-sig")', source)
                self.assertNotIn('TRACKER_PATH.open("r", encoding="utf-8-sig"', source)
                self.assertNotIn("with p.open() as f:", source)

    def test_a_screener_must_not_import_load_rows_without_calling_it(self):
        """Round 2's patch replaced a read with `load_rows()` but silently skipped the import, leaving a NameError.

        The import and the call are one change: either alone is a broken file.
        """
        for name in self.SCREENERS:
            with self.subTest(screener=name):
                source = self.source(name)
                self.assertIn("load_rows(", source)
                # and the import must precede the first call, counted in the source text
                self.assertLess(source.index("from tracker_index import"), source.index("load_rows("))

    def test_list_board_jobs_is_not_forced_to_import_it(self):
        """It lists a board's jobs and never reads the tracker; an earlier sweep named it anyway because a
        `grep -L` cannot tell 'does not share the reader' from 'has no reason to'."""
        self.assertNotIn("from tracker_index import", self.source("list_board_jobs.py"))

    def test_the_shared_reader_equals_the_copy_it_replaced(self):
        """The equivalence the rewires rest on, checked directly rather than by trusting the diff of two runs."""
        import csv
        # `with` rather than the one-liner that used to sit here: the handle was never closed, so
        # every suite run carried a ResourceWarning - noise that trains the reader to stop reading
        # warnings. The comparison this test is for is unchanged.
        with open(tracker.TRACKER, encoding="utf-8-sig", newline="") as handle:
            inline = list(csv.DictReader(handle))
        shared = tracker.load_rows()
        self.assertEqual(len(inline), len(shared))
        self.assertEqual(list(inline[0]), list(shared[0]))
        self.assertEqual(inline[-1].get("source"), shared[-1].get("source"))

    def test_every_screener_can_actually_be_imported(self):
        """Text checks are not enough, and this is the test that proves it.

        Two rewiring passes in a row inserted text that read correctly and did not run: one replaced a read with
        `load_rows()` but never inserted the import (NameError at first use), and the next referred to `_sys` in a
        file that imports `sys` (NameError on the first line of module code). Both satisfied
        `assertIn("from tracker_index import", source)` and both compiled. Only importing them catches it.

        Network and argv failures are expected and ignored; a NameError, ImportError or SyntaxError is not.
        """
        import subprocess
        import sys as _sys
        for name in self.SCREENERS:
            with self.subTest(screener=name):
                probe = (
                    "import importlib.util as u, sys, pathlib\n"
                    f"p = pathlib.Path({str(pathlib.Path(__file__).resolve().parent / name)!r})\n"
                    "sys.path.insert(0, str(p.parent))\n"
                    "spec = u.spec_from_file_location('probe_' + p.stem, p)\n"
                    "m = u.module_from_spec(spec)\n"
                    "try:\n"
                    "    spec.loader.exec_module(m)\n"
                    "except SystemExit:\n"
                    "    pass\n"
                    "except (NameError, ImportError, SyntaxError) as e:\n"
                    "    raise AssertionError(f'{type(e).__name__}: {e}')\n"
                    "except Exception:\n"
                    "    pass\n"
                )
                scratch = pathlib.Path("/tmp") / f"probe_{name}"
                scratch.write_text(probe, encoding="utf-8")
                try:
                    done = subprocess.run([_sys.executable, str(scratch)],
                                          capture_output=True, text=True, timeout=30)
                except subprocess.TimeoutExpired:
                    continue  # reached its network work: the imports resolved, which is all this checks
                self.assertEqual(done.returncode, 0,
                                 f"{name} fails to import:\n{done.stderr.strip()[-400:]}")


class CompanyMatching(unittest.TestCase):
    """Whole words, not substrings.

    driving-widgets-cases-3: "match names by WORD, not by substring - `grep -i loft` returned Agiloft". The
    dedupe path ran a containment test on the normalised forms, so those two employers weighed as one whenever
    their titles agreed - and a generic title agrees constantly. Both directions of the containment test were
    wrong the same way, so both are asserted.
    """

    def test_the_case_that_prompted_it(self):
        # `loft` is a run of characters inside `agiloft` and not a word in it.
        self.assertFalse(tracker.same_company("loft", "Agiloft"))
        self.assertFalse(tracker.same_company("Agiloft", "loft"))

    def test_the_case_containment_was_written_for_still_works(self):
        # A slug rarely carries the legal suffix the tracker records, and that is why containment was used.
        self.assertTrue(tracker.same_company("agiloft", "Agiloft, Inc."))
        self.assertTrue(tracker.same_company("Agiloft, Inc.", "agiloft"))
        self.assertTrue(tracker.same_company("Bestow", "bestow"))

    def test_case_and_punctuation_do_not_matter(self):
        self.assertTrue(tracker.same_company("Lyra-Health", "lyra health"))

    def test_a_word_boundary_is_not_a_prefix_boundary(self):
        # `Snap` is a word in `Snap Inc` and a prefix of `Snapdocs`; only the first is the same employer.
        self.assertTrue(tracker.same_company("snap", "Snap Inc"))
        self.assertFalse(tracker.same_company("snap", "Snapdocs"))

    def test_nothing_matches_nothing(self):
        # An empty company must not match everything, which `"" in anything` would have done.
        for hint, company in (("", "Agiloft"), ("loft", ""), (None, None), ("", ""), (None, "Agiloft")):
            with self.subTest(hint=hint, company=company):
                self.assertFalse(tracker.same_company(hint, company))


if __name__ == "__main__":
    unittest.main()
