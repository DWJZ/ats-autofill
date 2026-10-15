#!/usr/bin/env python3
"""Tests for the two things a full scripted refill got wrong, both found by auditing the RESULT rather than trusting
the run: the attachments never reached the spec, and a relocation field offering cities was answered `Yes`.

    cover_letter | file | Attach | (empty)              <- the loop was given --cover-letter
    Are you open to relocation?* | Select... | (empty)  <- the drafter's answer was `Yes`, not one of the 17 options

Both are the same shape as everything else this project meets: the run reported no error, the drafter reported a
reasonable-looking answer, and only the page disagreed.
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

MODULE_PATH = ROOT / "src" / "forms" / "draft_form_spec.py"
_spec = importlib.util.spec_from_file_location("draft_form_spec_refill", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)

TWITCH_RELOCATION = {
    "ref": "id:question_38733927002",
    "question": "Are you open to relocation? *",
    "type": "text",
    "react_select": True,
    "required": True,
    "options": ["No", "No, but I'm open to a remote position", "San Francisco, CA", "Irvine, CA",
                "Los Angeles, CA", "Seattle, WA", "New York, NY", "Salt Lake City, UT"],
}


# THE STANDING ORDER, SUPPLIED RATHER THAN READ FROM THE PROFILE. `relocate_answer(field, candidate)` takes the
# candidate dict precisely so the ranking can be checked without one: the order is a preference belonging to
# whoever configured the checkout, so passing it in keeps these cases about the RANKING - which is what the
# function adds - and keeps them running in a checkout whose profile records a different one. The order below
# is this test's own premise, drawn from the fixture field's own options, and is deliberately nobody's.
CANDIDATE = {"standing_answers": {"preferred_locations": {
    "order": ["Salt Lake City", "New York", "Los Angeles"]}}}


class RelocationOfferingPlacesTest(unittest.TestCase):
    def test_the_best_offered_place_wins(self):
        # The place comes from the profile's priority_locations; the first preferred place the field OFFERS wins.
        self.assertEqual(drafter.relocate_answer(TWITCH_RELOCATION, CANDIDATE), "Salt Lake City, UT")

    def test_a_field_that_does_not_offer_the_top_choice_gets_the_next_one(self):
        self.assertEqual(
            drafter.relocate_answer({"options": ["No", "Los Angeles, CA", "New York, NY"]}, CANDIDATE),
            "New York, NY")

    def test_a_yes_no_relocation_field_is_left_to_the_standing_rule(self):
        # None, NOT "Yes": the caller still has the ordinary answer for this question, and choosing a place here would
        # be answering a different question than the one the form asks.
        self.assertIsNone(drafter.relocate_answer({"options": ["Yes", "No"]}))
        self.assertIsNone(drafter.relocate_answer({"options": []}))
        self.assertIsNone(drafter.relocate_answer({"question": "Are you open to relocation?"}))

    def test_the_order_comes_from_data_not_from_this_file(self):
        # The order is a preference, so it belongs beside the compensation rule - not hardcoded where it cannot be
        # changed without a code edit.
        self.assertIn("preferred_locations",
                      json.dumps(json.loads((DATA_DIR / "candidate_profile.json").read_text(encoding="utf-8"))))
        self.assertTrue(drafter.preferred_locations(), "no preference order was read from canonical data")
        self.assertEqual(drafter.preferred_locations({}), [], "an absent preference is not an error")
        self.assertEqual(drafter.preferred_locations({"standing_answers": {"preferred_locations": {"order": []}}}), [])


class AttachmentsReachTheSpecTest(unittest.TestCase):
    """The spec must carry `files` whenever the flags are given - including on a second pass over a filled form."""

    def _draft(self, fields, *extra):
        with tempfile.TemporaryDirectory() as d:
            fpath = pathlib.Path(d) / "fields.json"
            opath = pathlib.Path(d) / "out.spec.json"
            fpath.write_text(json.dumps({"url": "https://example.test/x", "fields": fields}), encoding="utf-8")
            r = subprocess.run(
                [sys.executable, str(MODULE_PATH), str(fpath), "--out", str(opath), "--job", "t", *extra],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            return json.loads(opath.read_text(encoding="utf-8"))

    def test_a_filled_form_still_gets_its_attachments(self):
        # THE MEASURED FAILURE. Round 2 of a scripted refill: the resume was already attached, so the scan showed no
        # blank file field, `used_files` stayed empty and `spec["files"]` was never created at all - and the cover
        # letter the loop had been handed was silently dropped.
        spec = self._draft(
            [{"ref": "id:first_name", "question": "First Name", "type": "text", "value": "Example"}],
            "--resume", "output/pdf/r.pdf", "--cover-letter", "output/pdf/c.pdf",
        )
        paths = [f["path"] for f in spec.get("files") or []]
        self.assertEqual(paths, ["output/pdf/r.pdf", "output/pdf/c.pdf"],
                         "the flags are an instruction to attach; a filled form does not cancel it")

    def test_a_blank_file_field_is_still_used_as_the_ref_when_one_exists(self):
        spec = self._draft(
            [{"ref": "id:resume", "question": "Resume", "type": "file", "group_label": "Resume/CV"},
             {"ref": "id:cover", "question": "Cover Letter", "type": "file", "group_label": "Cover Letter"}],
            "--resume", "output/pdf/r.pdf", "--cover-letter", "output/pdf/c.pdf",
        )
        refs = {f["path"]: f["ref"] for f in spec.get("files") or []}
        self.assertEqual(refs.get("output/pdf/r.pdf"), "id:resume")
        self.assertEqual(refs.get("output/pdf/c.pdf"), "id:cover")

    def test_no_flags_means_no_files_key(self):
        spec = self._draft([{"ref": "id:x", "question": "First Name", "type": "text", "value": "T"}])
        self.assertNotIn("files", spec, "an empty files array would be read as 'attach nothing', which is not the ask")


if __name__ == "__main__":
    unittest.main()
