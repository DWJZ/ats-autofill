#!/usr/bin/env python3
"""test_check_configuration.py — the four states, the failure directions, and what the output may not say.

WHY THIS IS A TEST AND NOT A PARAGRAPH. `check_configuration.py` exists because "an agent compares the data
directory against `examples/` by eye" is a step that silently gets it wrong, and the cost of getting it wrong
is a form submitted under the example person's name. A guard against exactly that cannot itself be trusted
because its docstring says so. What is asserted here:

  * THE FOUR STATES, including the two that are easy to collapse into each other — `example` (untouched) and
    `partial` (some files replaced, some not) — and the direction where a HALF-CONFIGURED checkout is
    reported as half-configured rather than configured. That direction is the one that matters: a file with
    one field changed passes every parse and every byte comparison against the examples, and would be
    reported as somebody's own facts by a check that only compared whole files.
  * THE TABLE MATCHES THE REPOSITORY. Every example the table names exists, `scripts/setup-examples.sh`
    installs exactly the destinations the table knows about, and every identity path is still a path in the
    shipped example. A rename in `examples/` is a failing test here rather than a check that quietly stops
    checking anything.
  * THE OUTPUT SAYS NOTHING ABOUT A PERSON. The report is read by a model mid-bootstrap; it may name a file
    and a path, and it may not print a value — not the example's, and not the person's own. Both halves are
    asserted against a data directory whose files carry a distinctive string in every field.
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

EXAMPLES = ROOT / "examples"
ANSWERS = ROOT / "tests" / "fixtures" / "bootstrap" / "answers.json"

#: Values the shipped example puts in a field. None of them may appear in the check's output: the report is
#: about which FILES are still examples, and printing the value is the failure it exists to prevent.
#: `Example_Candidate_Backend_Resume.docx` is deliberately NOT in this list - it is a file name in the
#: repository (a destination in the table), not a value about anyone, and the report names destinations.
EXAMPLE_VALUES = (
    "Example Candidate", "Springfield", "candidate@example.edu", "Example Company One",
    "123 Example Street", "5551234567", "Example High School", "Lakeside State University",
    "Example Framework X", "示例姓名", "Example Country", "Example Job Title",
)

#: Values the person in `tests/fixtures/bootstrap/answers.json` supplied. The check reads their files to
#: decide what is still the example's; it may not report what it read.
PERSON_VALUES = (
    "Żółkiewski", "l.zolkiewski@example.org", "4165550182", "1123 Dundas Street West",
    "Toronto General Hospital", "Mount Sinai Hospital", "College of Nurses", "95000",
)


def install_examples(data_dir: pathlib.Path) -> None:
    """Put the shipped example at every destination the table names — what `setup-examples.sh` does."""
    for spec in cc.FILES:
        target = data_dir / spec.dest
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(EXAMPLES / spec.example, target)
    for name in cc.DIRECTORIES:
        (data_dir / name).mkdir(parents=True, exist_ok=True)


def replace_with_own_content(data_dir: pathlib.Path) -> None:
    """Make every file differ from its example without carrying an example value.

    Deliberately NOT realistic configuration content: the subject here is the state machine, not the schema.
    The suffix decides the shape because the tracker is read as a table and the letter as text.
    """
    for spec in cc.FILES:
        target = data_dir / spec.dest
        if target.suffix == ".json":
            target.write_text(json.dumps({"configured_by": "the test"}) + "\n", encoding="utf-8")
        elif target.suffix == ".csv":
            header = target.read_text(encoding="utf-8-sig").splitlines()[0]
            target.write_text(header + "\n", encoding="utf-8-sig")
        else:
            target.write_text("Written by the test.\n", encoding="utf-8")


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(ROOT / "src" / "tools" / "check_configuration.py"), *args],
                          capture_output=True, text=True, cwd=str(ROOT), timeout=120)


class TheFourStatesTest(unittest.TestCase):
    """Absent, example, partial, configured — and the two that are easy to confuse."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="check-config-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"

    def state(self) -> tuple[str, list[cc.Verdict]]:
        return cc.check_state(self.data, EXAMPLES)

    def test_a_directory_that_does_not_exist_is_absent(self):
        self.assertFalse(self.data.exists())
        self.assertEqual(self.state()[0], cc.ABSENT)

    def test_a_directory_that_exists_and_holds_nothing_is_absent_too(self):
        # A fresh checkout can have an empty `data/` (mkdir, or a checkout that only wrote one unrelated
        # file into it). "Nothing is installed" is the fact; the distinction from a missing directory is one
        # the report keeps in a different line, not one the state should lose.
        self.data.mkdir(parents=True)
        self.assertEqual(self.state()[0], cc.ABSENT)

    def test_the_examples_installed_and_untouched_are_the_example_state(self):
        install_examples(self.data)
        state, verdicts = self.state()
        self.assertEqual(state, cc.EXAMPLE)
        self.assertTrue(all(v.state == "example" for v in verdicts), [v for v in verdicts if v.state != "example"])

    def test_one_file_replaced_and_the_rest_left_is_partial_and_never_configured(self):
        install_examples(self.data)
        (self.data / "candidate_profile.json").write_text('{"candidate": {"name": "A Real Person"}}\n',
                                                          encoding="utf-8")
        state, verdicts = self.state()
        self.assertEqual(state, cc.PARTIAL)
        self.assertEqual(next(v for v in verdicts if v.spec.dest == "candidate_profile.json").state, "own")

    def test_every_file_replaced_is_configured(self):
        install_examples(self.data)
        replace_with_own_content(self.data)
        state, verdicts = self.state()
        self.assertEqual(state, cc.CONFIGURED, [v for v in verdicts if v.state != "own"])

    def test_a_missing_file_that_decides_usability_is_partial_not_configured(self):
        install_examples(self.data)
        replace_with_own_content(self.data)
        (self.data / "applications.csv").unlink()
        state, verdicts = self.state()
        self.assertEqual(state, cc.PARTIAL)
        self.assertEqual(next(v for v in verdicts if v.spec.dest == "applications.csv").state, "missing")

    def test_a_file_that_does_not_decide_usability_can_stay_the_example(self):
        # `blocks=False` in the table, exercised rather than described: an untouched master DOCX is a layout
        # whose body is discarded on every render, and it must not be able to hold a checkout unusable.
        install_examples(self.data)
        replace_with_own_content(self.data)
        for spec in cc.FILES:
            if not spec.blocks:
                shutil.copy2(EXAMPLES / spec.example, self.data / spec.dest)
        state, verdicts = self.state()
        self.assertEqual(state, cc.CONFIGURED)
        self.assertTrue(any(v.state == "example" for v in verdicts), "the premise: something is still the example")


class TheHalfEditedFileIsNotConfiguredTest(unittest.TestCase):
    """The direction byte identity cannot see: a file that WAS edited but is still mostly the example's."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="check-config-half-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"
        # The baseline is a REAL bootstrap — the answers fixture written into a temporary data directory —
        # so "own" here means the person's own facts, not a stub the test invented.
        subprocess.run([sys.executable, str(ROOT / "src" / "tools" / "configure.py"), str(ANSWERS),
                        "--data-dir", str(self.data)],
                       capture_output=True, text=True, cwd=str(ROOT), timeout=120, check=True)

    def verdict(self, dest: str) -> cc.Verdict:
        spec = next(s for s in cc.FILES if s.dest == dest)
        return cc.verdict_for(self.data, spec, EXAMPLES)

    def test_the_bootstrap_this_starts_from_is_configured(self):
        """The premise. If the fixture answers left an example value in a profile, every subtest below would
        be measuring the fixture rather than the check."""
        state, verdicts = cc.check_state(self.data, EXAMPLES)
        self.assertEqual(state, cc.CONFIGURED, [v for v in verdicts if v.state not in ("own", "missing")])

    def test_it_is_partial_rather_than_configured(self):
        doc = json.loads((EXAMPLES / "candidate_profile.example.json").read_text(encoding="utf-8"))
        doc["candidate"]["name"] = "A Real Person"
        (self.data / "candidate_profile.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        self.assertEqual(cc.check_state(self.data, EXAMPLES)[0], cc.PARTIAL)

    def test_it_names_the_values_that_are_still_the_examples(self):
        doc = json.loads((EXAMPLES / "candidate_profile.example.json").read_text(encoding="utf-8"))
        doc["candidate"]["name"] = "A Real Person"
        (self.data / "candidate_profile.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        verdict = self.verdict("candidate_profile.json")
        self.assertEqual(verdict.state, "partly")
        self.assertIn("candidate.email", verdict.detail)
        self.assertIn("candidate.current_education", verdict.detail)
        self.assertNotIn("candidate.name", verdict.detail, "the field that WAS changed must not be reported")

    def test_every_identity_path_is_load_bearing(self):
        """Each path in `IDENTITY_PATHS` catches a file that has that one value left as the example's.

        Driven by putting ONE example value back into an otherwise-configured profile — which is exactly what
        a half-finished bootstrap looks like, and what a whole-file byte comparison reports as `own`. A path
        that stops matching (a renamed key, a moved block) fails here instead of silently checking nothing.
        """
        for dest, paths in cc.IDENTITY_PATHS.items():
            example = json.loads((EXAMPLES / cc.example_for(dest)).read_text(encoding="utf-8"))
            own = json.loads((self.data / dest).read_text(encoding="utf-8"))
            for path in paths:
                with self.subTest(file=dest, path=path):
                    value = _at(example, path)
                    self.assertIsNotNone(value, f"{dest}: {path} is not in the shipped example any more")
                    probe = json.loads(json.dumps(own))
                    _put(probe, path, value)
                    # `ensure_ascii=False` so a value with diacritics round-trips: the comparison is on the
                    # parsed value, and an escaped-vs-literal difference would be read as "replaced".
                    (self.data / dest).write_text(json.dumps(probe, indent=2, ensure_ascii=False) + "\n",
                                                  encoding="utf-8")
                    verdict = self.verdict(dest)
                    self.assertEqual(verdict.state, "partly",
                                     f"{dest}: a file with the example's {path} still in it read as "
                                     f"{verdict.state} — that path is no longer checking anything")
                    self.assertIn(path, verdict.detail)
            # leave the file as the test found it, so subtests do not build on each other
            (self.data / dest).write_text(json.dumps(own, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class TheTrackerIsComparedAsRowsTest(unittest.TestCase):
    """The tracker's failure is not a value in a field: it is an invented application that still counts."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="check-config-tracker-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"
        install_examples(self.data)
        self.tracker = self.data / "applications.csv"

    def test_a_tracker_that_keeps_one_invented_row_is_partly_the_example(self):
        text = self.tracker.read_text(encoding="utf-8-sig")
        header, *rows = text.splitlines()
        # Header plus the FIRST example row only: a bootstrap that added its own rows and left the example's
        # in place. One shipped row claims a submission, which is a status that must never be re-applied to.
        self.tracker.write_text(header + "\n" + rows[0] + "\n", encoding="utf-8-sig")
        verdict = cc.verdict_for(self.data, next(s for s in cc.FILES if s.dest == "applications.csv"), EXAMPLES)
        self.assertEqual(verdict.state, "partly")
        self.assertIn("1 row(s)", verdict.detail)

    def test_an_empty_tracker_with_its_header_is_the_persons_own(self):
        header = self.tracker.read_text(encoding="utf-8-sig").splitlines()[0]
        self.tracker.write_text(header + "\n", encoding="utf-8-sig")
        verdict = cc.verdict_for(self.data, next(s for s in cc.FILES if s.dest == "applications.csv"), EXAMPLES)
        self.assertEqual(verdict.state, "own")


class TheOutputSaysNothingAboutAPersonTest(unittest.TestCase):
    """The report is read by a model: it names files and paths, and never a value — in either direction."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="check-config-output-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"

    def test_no_example_value_appears_in_any_state(self):
        outputs = []
        outputs.append(run_cli("--data-dir", str(self.data)).stdout)          # absent
        install_examples(self.data)
        outputs.append(run_cli("--data-dir", str(self.data)).stdout)          # example
        (self.data / "candidate_profile.json").write_text('{"candidate": {"name": "A Real Person"}}\n',
                                                          encoding="utf-8")
        outputs.append(run_cli("--data-dir", str(self.data)).stdout)          # partial
        replace_with_own_content(self.data)
        outputs.append(run_cli("--data-dir", str(self.data)).stdout)          # configured
        for number, output in enumerate(outputs):
            for value in EXAMPLE_VALUES:
                self.assertNotIn(value, output, f"run {number} printed an example value: {value!r}")

    def test_the_persons_own_values_are_never_printed_either(self):
        """A partly-configured checkout is where this is easiest to get wrong: the check has just READ the
        person's files to compare them, and the tempting report is "your candidate_profile.json still says
        Springfield" — which puts the value on screen. Only the path is printed."""
        subprocess.run([sys.executable, str(ROOT / "src" / "tools" / "configure.py"),
                        str(ANSWERS), "--data-dir", str(self.data)],
                       capture_output=True, text=True, cwd=str(ROOT), timeout=120, check=True)
        # And then break one file the way a half-finished bootstrap does, so the report has something to say
        # about a file that IS the person's.
        profile = json.loads((self.data / "application_profile.json").read_text(encoding="utf-8"))
        profile["candidate"]["phone"]["formatted"] = json.loads(
            (EXAMPLES / "application_profile.example.json").read_text(encoding="utf-8")
        )["candidate"]["phone"]["formatted"]
        (self.data / "application_profile.json").write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")

        done = run_cli("--data-dir", str(self.data))
        self.assertEqual(done.returncode, 1)
        self.assertIn("state: partial", done.stdout)
        self.assertIn("candidate.phone.formatted", done.stdout, "the path is what the report is for")
        for value in PERSON_VALUES + EXAMPLE_VALUES:
            self.assertNotIn(value, done.stdout, f"the report printed a value: {value!r}")
            self.assertNotIn(value, done.stderr, f"the report printed a value on stderr: {value!r}")


class TheTableAndTheRepositoryAgreeTest(unittest.TestCase):
    """The one table is worth what it is checked against: the examples, the setup script, the identity list."""

    def test_every_example_the_table_names_is_in_the_repository(self):
        for spec in cc.FILES:
            with self.subTest(example=spec.example):
                self.assertTrue((EXAMPLES / spec.example).is_file())

    def test_the_setup_script_installs_exactly_the_destinations_the_table_knows(self):
        """`setup-examples.sh` and this table are two copies of one mapping, and the copy that drifts is the
        one nobody runs: a file the script installs and the check does not know about is a file no report
        ever mentions. Parsed from the script's own `copy_example <example> <destination>` calls."""
        script = (ROOT / "scripts" / "setup-examples.sh").read_text(encoding="utf-8")
        installed = set()
        for line in script.splitlines():
            stripped = line.strip()
            if stripped.startswith("copy_example "):
                _example, dest = stripped.split()[1:3]
                installed.add(dest)
        self.assertEqual(installed, {spec.dest for spec in cc.FILES})

    def test_the_directories_the_table_reports_are_the_ones_the_setup_script_makes(self):
        script = (ROOT / "scripts" / "setup-examples.sh").read_text(encoding="utf-8")
        for name in cc.DIRECTORIES:
            with self.subTest(directory=name):
                self.assertIn(f"$DATA_DIR/{name}", script)

    def test_every_identity_path_exists_in_the_shipped_example(self):
        """A path that is not in the example checks nothing, and would do it silently."""
        for dest, paths in cc.IDENTITY_PATHS.items():
            with self.subTest(file=dest):
                example = json.loads((EXAMPLES / cc.example_for(dest)).read_text(encoding="utf-8"))
                for path in paths:
                    self.assertIsNotNone(_at(example, path), f"{dest}: {path} is not a path in the example")

    def test_the_identity_list_and_the_marker_scan_are_both_needed(self):
        """Neither signal subsumes the other, asserted on the shipped example rather than argued.

        `candidate.location` and `candidate.last_name` carry NO example marker — the check only knows they are
        the example's because they are on the identity list. `confirmed_skills` is the other way round: it is
        not an identity path, and it is caught by the marker scan alone.
        """
        example = json.loads((EXAMPLES / "candidate_profile.example.json").read_text(encoding="utf-8"))
        application = json.loads((EXAMPLES / "application_profile.example.json").read_text(encoding="utf-8"))
        self.assertFalse(cc.is_marked(_at(example, "candidate.location")))
        self.assertFalse(cc.is_marked(_at(application, "candidate.last_name")))
        self.assertIn("candidate.location", cc.IDENTITY_PATHS["candidate_profile.json"])
        self.assertTrue(cc.is_marked(_at(example, "confirmed_skills")[0]))
        self.assertNotIn("confirmed_skills", cc.IDENTITY_PATHS["candidate_profile.json"])


class TheCommandLineContractTest(unittest.TestCase):
    """The exit status is what automation branches on; the first line is the same answer in text."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="check-config-cli-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"

    def test_the_state_is_the_first_line_and_only_configured_exits_zero(self):
        for expected_state, exit_code in ((cc.ABSENT, 1), (cc.EXAMPLE, 1), (cc.PARTIAL, 1), (cc.CONFIGURED, 0)):
            with self.subTest(state=expected_state):
                shutil.rmtree(self.data, ignore_errors=True)
                if expected_state != cc.ABSENT:
                    install_examples(self.data)
                if expected_state in (cc.PARTIAL, cc.CONFIGURED):
                    (self.data / "candidate_profile.json").write_text('{"candidate": {"name": "A Real Person"}}\n',
                                                                      encoding="utf-8")
                if expected_state == cc.CONFIGURED:
                    replace_with_own_content(self.data)
                done = run_cli("--data-dir", str(self.data))
                self.assertEqual(done.returncode, exit_code, done.stdout)
                self.assertEqual(done.stdout.splitlines()[0], f"state: {expected_state}")

    def test_quiet_prints_the_state_and_nothing_else(self):
        install_examples(self.data)
        done = run_cli("--data-dir", str(self.data), "--quiet")
        self.assertEqual(done.stdout.strip(), "state: example")

    def test_another_examples_tree_can_be_named(self):
        """`--examples-dir` is what lets a caller compare against a tree that is not this repository's.

        The tests here use it; a second checkout whose `examples/` has been edited is the other caller.
        Asserted from the outside: the same data directory is `example` against the shipped examples and is
        not, for the file in question, against a tree where that one example differs.
        """
        install_examples(self.data)
        other = pathlib.Path(self.tmp.name) / "other-examples"
        shutil.copytree(EXAMPLES, other)
        (other / "candidate_profile.example.json").write_text('{"candidate": {"name": "Someone Else"}}\n',
                                                              encoding="utf-8")
        self.assertIn("state: example", run_cli("--data-dir", str(self.data)).stdout)
        done = run_cli("--data-dir", str(self.data), "--examples-dir", str(other))
        self.assertEqual(done.returncode, 1)
        self.assertNotIn("state: example", done.stdout)

    def test_an_unreadable_file_is_reported_rather_than_crashing(self):
        # A profile that was hand-edited and left with a trailing comma is a state a bootstrap meets. The
        # check says what it can read and calls the file partial; it does not raise out of a comparison.
        install_examples(self.data)
        (self.data / "candidate_profile.json").write_text('{"candidate": {"name": "A Real Person",}}\n',
                                                          encoding="utf-8")
        done = run_cli("--data-dir", str(self.data))
        self.assertEqual(done.returncode, 1)
        self.assertIn("not readable as JSON", done.stdout)


def _at(doc, path: str):
    """The value at `candidate.address.city` / `education.0.school`, or None when the path is not there."""
    value = doc
    for part in path.split("."):
        if isinstance(value, list):
            try:
                value = value[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    return value


def _put(doc, path: str, value) -> None:
    parts = path.split(".")
    target = doc
    for part in parts[:-1]:
        target = target[int(part)] if isinstance(target, list) else target[part]
    if isinstance(target, list):
        target[int(parts[-1])] = value
    else:
        target[parts[-1]] = value


if __name__ == "__main__":
    unittest.main()
