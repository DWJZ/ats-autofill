#!/usr/bin/env python3
"""test_configure.py — what the bootstrap tool writes, and the one thing it must never do.

`src/tools/configure.py` exists because "an agent writes the nine configuration files by hand" is the step
that had never been verified. The failure it is built against is asymmetric, so the tests are too:

  * A BOOTSTRAP THAT WRITES NOTHING USEFUL is annoying and visible — `check_configuration.py` reports the
    checkout as partly configured and names what is still the example's.
  * A BOOTSTRAP THAT OVERWRITES A REAL ANSWER is not visible at all. The file it destroys is the person's
    own facts, the record of what they have applied to, or a hand-corrected profile; there is no copy of it
    anywhere, and the loss is discovered on an employer's form. So the refusal rule is tested from both
    sides: a file that differs from its example is kept and reported, and a second run of the same answers
    file is a no-op rather than a rewrite.

The other half is the contract of the answers format: objects merge, lists and scalars replace, `null`
deletes the key, and a destination this toolkit does not read is refused rather than created.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.tools import check_configuration as cc  # noqa: E402
from src.tools import configure as boot  # noqa: E402

EXAMPLES = ROOT / "examples"
ANSWERS = ROOT / "tests" / "fixtures" / "bootstrap" / "answers.json"
COMMAND = str(ROOT / "src" / "tools" / "configure.py")


def run(*args: str, answers: object | None = None) -> subprocess.CompletedProcess:
    """Drive the tool the way a person does: a file in, a report out, an exit status."""
    if answers is None:
        return subprocess.run([sys.executable, COMMAND, *args], capture_output=True, text=True, cwd=str(ROOT),
                              timeout=120)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="configure-answers-"))
    path = tmp / "answers.json"
    path.write_text(json.dumps(answers), encoding="utf-8")
    try:
        return subprocess.run([sys.executable, COMMAND, str(path), *args], capture_output=True, text=True,
                              cwd=str(ROOT), timeout=120)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class ABootstrapTest(unittest.TestCase):
    """A temporary data directory, never the checkout's own — the same rule the tool enforces on itself."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="configure-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"

    def read(self, dest: str):
        return json.loads((self.data / dest).read_text(encoding="utf-8"))

    def test_the_answers_fixture_reaches_a_configured_checkout(self):
        done = run("--data-dir", str(self.data), answers=json.loads(ANSWERS.read_text(encoding="utf-8")))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("state: configured", done.stdout)
        self.assertEqual(cc.check_state(self.data, EXAMPLES)[0], cc.CONFIGURED)

    def test_the_answers_land_at_the_paths_the_code_reads(self):
        """Not "the tool wrote a file": the facts are where the pipeline looks for them, in the two places
        that decide who the applicant is — `candidate.name` here, `candidate.address.city` there."""
        run("--data-dir", str(self.data), answers=json.loads(ANSWERS.read_text(encoding="utf-8")))
        candidate = self.read("candidate_profile.json")["candidate"]
        application = self.read("application_profile.json")
        self.assertEqual(candidate["name"], "Łukasz Żółkiewski")
        self.assertEqual(candidate["standard_answers"]["work_authorization"], "us_citizen")
        self.assertEqual(candidate["standing_answers"]["compensation"]["currency"], "CAD")
        self.assertEqual(application["candidate"]["address"]["city"], "Toronto")
        self.assertEqual(application["candidate"]["linkedin"], "", "the LinkedIn the example carries is gone")
        self.assertEqual(application["education"][0]["school"], "Toronto Metropolitan University")
        self.assertEqual(application["work_experience"][0]["company"],
                         "University Health Network — Toronto General Hospital")
        self.assertNotIn("legal_name_native", application["candidate"], "`null` deletes the key")
        self.assertEqual((self.data / "applications.csv").read_text(encoding="utf-8-sig").strip().count("\n"), 0,
                         "the example's invented applications are gone, the header is not")

    def test_a_file_that_is_not_the_example_is_never_overwritten(self):
        """The rule the whole tool exists around. The file here is a filled-in tracker, which is the one
        configuration file this project treats as unrecoverable."""
        answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
        self.data.mkdir(parents=True)
        mine = "date_added,company,title,source,eligibility,recommended_track,track_scores,status,notes\n" \
               "2026-10-14,A Hospital,Registered Nurse,https://example.invalid/a,OK,nursing,{},submitted_by_user," \
               "sent, confirmed\n"
        (self.data / "applications.csv").write_text("\ufeff" + mine, encoding="utf-8")
        before = (self.data / "applications.csv").read_bytes()

        done = run("--data-dir", str(self.data), answers=answers)
        self.assertIn("keep", done.stdout)
        self.assertIn("applications.csv", done.stdout)
        self.assertEqual((self.data / "applications.csv").read_bytes(), before, "a real answer was overwritten")
        self.assertEqual(done.returncode, 0, "the other files were written; only this one was kept")

    def test_running_the_same_answers_twice_changes_nothing_the_second_time(self):
        answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
        run("--data-dir", str(self.data), answers=answers)
        first = {p: p.read_bytes() for p in sorted(self.data.rglob("*")) if p.is_file()}
        done = run("--data-dir", str(self.data), answers=answers)
        second = {p: p.read_bytes() for p in sorted(self.data.rglob("*")) if p.is_file()}
        self.assertEqual(first, second, "a second bootstrap rewrote a file it had already written")
        self.assertEqual(done.stdout.count("keep"), len(answers["files"]),
                         "every file should now be reported as already yours")

    def test_a_missing_file_is_built_from_the_example_so_a_bare_checkout_can_be_bootstrapped(self):
        self.assertFalse(self.data.exists())
        run("--data-dir", str(self.data), answers={"files": {
            "candidate_profile.json": {"candidate": {"name": "A Real Person"}}}})
        written = self.read("candidate_profile.json")
        self.assertEqual(written["candidate"]["name"], "A Real Person")
        self.assertEqual(written["candidate"]["standing_answers"]["compensation"]["currency"], "USD",
                         "the keys the answers did not mention come from the example — a bootstrap is a merge, "
                         "not a rewrite, and what it did not replace is what the check reports")

    def test_the_report_says_what_it_wrote_and_what_is_left(self):
        answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
        only_two = {"files": {k: answers["files"][k] for k in ("candidate_profile.json", "application_profile.json")}}
        done = run("--data-dir", str(self.data), answers=only_two)
        self.assertEqual(done.returncode, 1, "an incomplete bootstrap is not a configured checkout")
        self.assertIn("state: partial", done.stdout)
        self.assertIn("wrote 2 file(s)", done.stdout)
        self.assertIn("NOT USABLE", done.stdout)
        for still_example in ("form_specs/answer_rules.json", "applications.csv"):
            self.assertIn(still_example, done.stdout)

    def test_a_dry_run_writes_nothing(self):
        answers = json.loads(ANSWERS.read_text(encoding="utf-8"))
        done = run("--data-dir", str(self.data), "--dry-run", answers=answers)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("would", done.stdout)
        self.assertFalse(self.data.exists(), "a dry run created the data directory")


class TheAnswersFormatTest(ABootstrapTest):
    """Object merge, list replace, `null` delete — asserted on the file the tool writes, not on the helper."""

    def test_objects_merge_and_lists_replace(self):
        self.assertEqual(boot.merge({"a": {"b": 1, "c": 2}}, {"a": {"c": 3}}), {"a": {"b": 1, "c": 3}})
        self.assertEqual(boot.merge({"a": [1, 2, 3]}, {"a": [9]}), {"a": [9]})
        self.assertEqual(boot.merge({"a": "x"}, {"a": "y"}), {"a": "y"})

    def test_null_deletes_the_key_and_a_missing_key_is_not_touched(self):
        self.assertEqual(boot.merge({"a": 1, "b": 2}, {"a": None}), {"b": 2})
        self.assertEqual(boot.merge({"a": 1}, {"zzz": None}), {"a": 1})

    def test_a_tracker_row_carries_the_examples_own_header(self):
        done = run("--data-dir", str(self.data), answers={"files": {"applications.csv": {"rows": [
            {"company": "A Hospital", "title": "Registered Nurse", "status": "materials_ready"}]}}})
        self.assertEqual(done.returncode, 1, done.stdout)  # everything else is still missing
        text = (self.data / "applications.csv").read_text(encoding="utf-8-sig")
        header, row = text.strip().splitlines()
        self.assertEqual(header.split(",")[:3], ["date_added", "company", "title"])
        self.assertIn("A Hospital", row)
        self.assertEqual(len(row.split(",")), len(header.split(",")), "the row is written to the header's width")

    def test_a_row_with_a_column_the_tracker_does_not_have_is_refused(self):
        done = run("--data-dir", str(self.data), answers={"files": {"applications.csv": {"rows": [
            {"company": "A Hospital", "salery_expectation": "95000"}]}}})
        self.assertEqual(done.returncode, 2)
        self.assertIn("columns are not in the example tracker's header", done.stderr)
        self.assertFalse(self.data.exists())

    def test_a_json_file_whose_answer_is_not_an_object_is_refused(self):
        # Every file this toolkit reads is a JSON object. A list would be written happily and read later by a
        # tool that has no idea an answers file exists — a failure moved somewhere it cannot be explained.
        done = run("--data-dir", str(self.data),
                   answers={"files": {"candidate_profile.json": ["not", "an", "object"]}})
        self.assertEqual(done.returncode, 2)
        self.assertIn("must be a JSON object", done.stderr)
        self.assertFalse(self.data.exists())

    def test_a_destination_the_filesystem_cannot_spell_is_refused(self):
        done = run("--data-dir", str(self.data), answers={"files": {"a\u0000b.json": {"a": 1}}})
        self.assertEqual(done.returncode, 2)
        self.assertIn("REFUSED", done.stderr)

    def test_a_file_this_toolkit_does_not_read_is_refused_rather_than_created(self):
        done = run("--data-dir", str(self.data), answers={"files": {"notes/scratch.json": {"a": 1}}})
        self.assertEqual(done.returncode, 2)
        self.assertIn("REFUSED", done.stderr)

    def test_a_destination_outside_the_data_directory_is_refused(self):
        for dest in ("../outside.json", "/tmp/absolute.json", "resume_profiles/../../outside.json"):
            with self.subTest(dest=dest):
                done = run("--data-dir", str(self.data), answers={"files": {dest: {"a": 1}}})
                self.assertEqual(done.returncode, 2, done.stdout)
                self.assertIn("REFUSED", done.stderr)
                self.assertNotIn("outside.json", [p.name for p in pathlib.Path(self.tmp.name).rglob("*.json")])

    def test_a_binary_file_cannot_be_written_from_answers(self):
        done = run("--data-dir", str(self.data), answers={"files": {
            "resume_templates/Example_Candidate_Backend_Resume.docx": "not really a docx"}})
        self.assertEqual(done.returncode, 2)
        self.assertIn("binary", done.stderr)

    def test_a_role_profile_is_written_from_the_per_application_template(self):
        done = run("--data-dir", str(self.data), answers={"files": {
            "resume_profiles/a_hospital_rn.json": {"company": "A Hospital", "role": "Registered Nurse",
                                                   "source": "https://example.invalid/jobs/1",
                                                   "summary": "A summary."}}})
        self.assertEqual(done.returncode, 1, done.stdout)  # the rest of the data directory is still absent
        written = self.read("resume_profiles/a_hospital_rn.json")
        self.assertEqual(written["company"], "A Hospital")
        self.assertIn("_readme", written, "the example's own contract note travels with the file it explains")

    def test_an_answers_file_with_no_files_object_is_refused(self):
        done = run("--data-dir", str(self.data), answers={"candidate_profile.json": {"a": 1}})
        self.assertEqual(done.returncode, 2)
        self.assertIn('"files" object', done.stderr)


class NothingOutsideTheDataDirectoryIsTouchedTest(ABootstrapTest):
    """The bootstrap's whole point: the facts go where `ATS_DATA_DIR` says, and the checkout is untouched."""

    def test_the_checkout_is_byte_for_byte_the_same_after_a_bootstrap(self):
        before = {p: p.read_bytes() for p in sorted(ROOT.rglob("*")) if p.is_file()
                  and "node_modules" not in p.parts and ".venv" not in p.parts and "__pycache__" not in p.parts}
        run("--data-dir", str(self.data), answers=json.loads(ANSWERS.read_text(encoding="utf-8")))
        after = {p: p.read_bytes() for p in sorted(ROOT.rglob("*")) if p.is_file()
                 and "node_modules" not in p.parts and ".venv" not in p.parts and "__pycache__" not in p.parts}
        self.assertEqual(sorted(map(str, before)), sorted(map(str, after)), "the bootstrap added a file to the repo")
        self.assertEqual(before, after, "the bootstrap changed a file in the repository")

    def test_the_default_data_directory_is_only_used_when_nothing_else_is_named(self):
        """`--data-dir` is what makes this testable, and `src/paths.py` is still the single definition of the
        default. Asserted rather than assumed, because a tool that ignored the setting would write into the
        checkout's own `data/` on every bootstrap."""
        from src.paths import DATA_DIR
        source = (ROOT / "src" / "tools" / "configure.py").read_text(encoding="utf-8")
        self.assertIn("from src.paths import DATA_DIR", source)
        self.assertIn("if args.data_dir else DATA_DIR", source)
        self.assertNotIn('ROOT / "data"', source, "a second definition of the data directory")
        self.assertTrue(str(DATA_DIR).endswith("data"))


if __name__ == "__main__":
    unittest.main()
