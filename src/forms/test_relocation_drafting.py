#!/usr/bin/env python3
"""Pin the shadowing bug: the relocation answer must survive being drafted INSIDE the loop over `fields`.

The probe, on the saved Twitch inventory:

    PROBE branch=select ... key='will_relocate' answer='Yes' noptions=17
    PROBE pre-fallback option=None  key == will_relocate -> True
    PROBE relocate_answer -> None

`relocate_answer(field)` returns "Seattle, WA" for that same field from outside. `main()` binds `candidate` to the
profile and then `for candidate in fields:` rebinds it to a FIELD, so the call was handing the function a field dict.
`preferred_locations` found no `standing_answers` in it, the order came back empty, and the field landed in
`needs_review` saying "profile answer 'Yes' has no matching option" - three hundred lines from the cause.

A function-level test would NOT have caught this: `relocate_answer` was correct the whole time. Only drafting a real
inventory exercises the name that gets shadowed, so that is what this does - it drives the CLI, which is also how the
bug reached the live form.
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = ROOT / "src" / "forms" / "draft_form_spec.py"

# The drafter is loaded in-process as well as driven as a CLI: the field this test builds has to name a place
# the INSTALLED preference order ranks, which is `preferred_locations()`'s answer. Sibling tests load the module
# the same way.
_spec = importlib.util.spec_from_file_location("draft_form_spec_relocation", MODULE)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)

# The Twitch field, copied from the inventory: 17 options that are `No`, a remote option and a list of cities.
RELOCATION_FIELD = {
    "ref": "id:question_38733927002",
    "label": "Are you open to relocation? *",
    "help": "* Select... Please choose a location from the list below if you're open to relocating with Twitch.",
    "type": "text", "react_select": True, "required": True, "value": "",
    "options": ["No", "No, but I'm open to a remote position", "San Francisco, CA", "Irvine, CA",
                "Los Angeles, CA", "Seattle, WA", "New York, NY", "Salt Lake City, UT"],
}


def draft(fields):
    with tempfile.TemporaryDirectory() as d:
        fpath = pathlib.Path(d) / "fields.json"
        opath = pathlib.Path(d) / "out.spec.json"
        fpath.write_text(json.dumps({"url": "https://example.test/x", "fields": fields}), encoding="utf-8")
        r = subprocess.run([sys.executable, str(MODULE), str(fpath), "--out", str(opath), "--job", "t"],
                           capture_output=True, text=True, cwd=ROOT)
        assert r.returncode == 0, r.stderr[-800:]
        spec = json.loads(opath.read_text(encoding="utf-8"))
        review = json.loads(pathlib.Path(str(opath).replace(".spec.json", ".spec.needs_review.json"))
                            .read_text(encoding="utf-8"))["needs_review"]
        return spec, review


class RelocationSurvivesTheLoopTest(unittest.TestCase):
    def relocation_field(self) -> dict:
        """The Twitch field, with its place options narrowed to the order THIS checkout records.

        The regression is `for candidate in fields:` rebinding the name the relocation fallback reads, so what
        the test needs is a place option the installed preference order actually ranks — not any particular
        city. The inventory offered Seattle because that is the order it was saved under; a checkout whose
        `standing_answers.preferred_locations.order` names a different place offers that one instead, and every
        assertion below is unchanged. It is still a real field: the shape that matters is a list of options in
        which one names a place and the rest do not.
        """
        order = drafter.preferred_locations()
        if not order:
            raise unittest.SkipTest(
                "data/candidate_profile.json records no standing location order "
                "(standing_answers.preferred_locations.order), so no place can be offered or chosen here")
        return dict(RELOCATION_FIELD, options=["No", "No, but I'm open to a remote position",
                                               f"{order[0]} — example", "Elsewhere, ZZ"])

    def test_a_drafted_relocation_field_gets_the_best_offered_place(self):
        # THE REGRESSION. If the fallback is ever handed the loop's `candidate` again, this returns to `needs_review`.
        field = self.relocation_field()
        expected_place = field["options"][2]     # the one option that names the top-ranked place
        spec, review = draft([field])
        entries = [e for e in (spec.get("selects") or []) if e.get("ref") == field["ref"]]
        self.assertEqual(len(entries), 1, f"the field was not drafted; needs_review says {review}")
        self.assertEqual(entries[0]["option"], expected_place)
        self.assertEqual([r for r in review if "relocation" in str(r.get("label", "")).lower()], [],
                         "a relocation field that can be answered must not be listed for a human")

    def test_a_yes_no_relocation_field_still_uses_the_standing_answer(self):
        # The other direction: with no place on offer, the fallback must stay out of the way and the ordinary
        # `Yes` rule must still decide - otherwise this "fix" would start choosing cities for yes/no questions.
        field = dict(RELOCATION_FIELD, options=["Yes", "No"])
        spec, review = draft([field])
        entries = [e for e in (spec.get("selects") or []) if e.get("ref") == field["ref"]]
        self.assertEqual(len(entries), 1, f"needs_review says {review}")
        self.assertEqual(entries[0]["option"], "Yes")


if __name__ == "__main__":
    unittest.main()
