#!/usr/bin/env python3
"""test_bootstrap_end_to_end.py — from a checkout nobody has configured to an application that exists.

WHY THIS FILE EXISTS. Three separate things were missing behind the sentence in `AGENTS.md` that tells an
agent to stop and ask for the facts: a way to ASK whether the checkout is configured
(`src/tools/check_configuration.py`), a way to turn answers into a configuration
(`src/tools/configure.py`), and PROOF THAT THE PATH WORKS. The first two have unit tests; a unit test of a
bootstrap tool proves that the tool writes the bytes it was asked for, which is not the same claim as "a
person's answers reach a form". The claim that matters is the one an agent is making when it says "the
configuration is done, I can fill forms now", and that claim is only true if the configuration produces an
application: a resume that renders to a PDF, a letter that resolves, and a drafter that answers a real
form's questions from it. A configuration that parses and cannot produce an application is not bootstrapped.

THE FOUR CLAIMS, in the order a bootstrap makes them:

  1. THE CHECK REPORTS THE TRUTH ABOUT AN UNCONFIGURED CHECKOUT — `absent` against a directory that does not
     exist yet, `example` after `scripts/setup-examples.sh` has put the shipped examples there.
  2. THE BOOTSTRAP REACHES `configured` — the answers for a person deliberately unlike the example's (a
     nurse in Toronto, no master's, no LinkedIn) are written into a temporary data directory.
  3. THE CONFIGURED CHECKOUT PRODUCES AN APPLICATION — `application_pipeline.py prepare --profile …` renders
     a PDF, the cover letter resolves, and `draft_form_spec.py` answers an invented inventory from it. The
     drafted spec must carry THIS person's facts, must not carry one value of the example's, and must report
     the one question no profile can answer as a gap instead of guessing.
  4. NOTHING WAS WRITTEN INSIDE THE REPOSITORY — the whole point of `ATS_DATA_DIR` and of a bootstrap tool
     that takes `--data-dir`. Steps 1-3 happen in a temporary directory outside the checkout. The pipeline
     itself writes into `output/` and `tmp/` BESIDE the code, by design (they hold generated documents and
     render scratch space, not answers about a person), so those two are asserted to be the only paths a run
     adds to the repository — and the test takes its own scratch away again, because
     `scripts/run-contract-tests.sh` proves the tree is unchanged after its run.

WHY IT DOES NOT USE THE CHECKOUT'S OWN `data/`: a test that bootstrapped into it would destroy the facts of
whoever is running the suite. `ATS_DATA_DIR` is the setting that makes the temporary directory possible
(`src/paths.py`), and `--data-dir` is the same idea for the check and the tool.
"""
from __future__ import annotations

import json
import os
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

ANSWERS = ROOT / "tests" / "fixtures" / "bootstrap" / "answers.json"
INVENTORY = ROOT / "tests" / "fixtures" / "bootstrap" / "form_inventory.json"
ROLE_PROFILE = "resume_profiles/toronto_general_rn_emergency.json"

#: One value the example person's configuration carries, per file that a form could be filled from. None of
#: these may appear in anything a bootstrapped checkout produces: not in the resume PDF, not in the letter,
#: not in the drafted spec. This is the assertion the whole exercise is for — the example person's facts on a
#: real application is the failure, and it is silent everywhere else.
EXAMPLE_VALUES = (
    "Example Candidate", "Springfield", "candidate@example.edu", "Example Company One",
    "123 Example Street", "+1 555 123 4567", "Example High School", "Lakeside State University",
    "example-candidate", "Example Framework X",
)

#: The person the answers fixture describes — every value here is invented for the test.
PERSON = {
    "name": "Żółkiewski",
    "email": "l.zolkiewski@example.org",
    "phone": "+1 416 555 0182",
    "city": "Toronto",
}


def repository_files() -> dict[str, tuple[int, int]]:
    """Every file in the checkout, with its size and mtime — the before/after picture C6 needs.

    `node_modules` and `.venv` are symlinks to another project's directories and `__pycache__` is a build
    artifact of running anything here at all; none of the three is a file this test may claim a run wrote.
    """
    out: dict[str, tuple[int, int]] = {}
    for base, dirs, names in os.walk(ROOT, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".venv", "__pycache__", ".git", ".cache")]
        for name in names:
            path = pathlib.Path(base) / name
            if path.is_symlink() or not path.is_file():
                continue
            stat = path.stat()
            out[str(path.relative_to(ROOT))] = (stat.st_size, stat.st_mtime_ns)
    return out


class TheBootstrapPathTest(unittest.TestCase):
    """The whole path, in a temporary data directory, from `absent` to an application that exists."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bootstrap-e2e-")
        self.addCleanup(self.tmp.cleanup)
        self.data = pathlib.Path(self.tmp.name) / "data"
        self.work = pathlib.Path(self.tmp.name) / "work"
        self.work.mkdir(parents=True, exist_ok=True)
        self._writes = _ScratchWrites(ROOT)
        self.addCleanup(self._writes.restore)

    # ------------------------------------------------------------------ drivers
    def drive(self, *argv: str, env: dict | None = None) -> subprocess.CompletedProcess:
        """A subprocess with the data directory pointed at the temporary one.

        `PYTHONDONTWRITEBYTECODE` because a run that leaves `__pycache__` in the checkout is a run that wrote
        into the repository, which is the claim being tested — `scripts/run-contract-tests.sh` sets it for
        the same reason.
        """
        return subprocess.run(list(argv), capture_output=True, text=True, cwd=str(ROOT), timeout=300,
                              env=dict(os.environ, ATS_DATA_DIR=str(self.data),
                                       PYTHONDONTWRITEBYTECODE="1", **(env or {})))

    def check(self) -> subprocess.CompletedProcess:
        return self.drive(sys.executable, "src/tools/check_configuration.py", "--data-dir", str(self.data))

    def bootstrap(self) -> None:
        """`setup-examples.sh` then `configure.py`: exactly the documented path, nothing shortened."""
        setup = self.drive("bash", "scripts/setup-examples.sh")
        self.assertEqual(setup.returncode, 0, setup.stdout + setup.stderr)
        configured = self.drive(sys.executable, "src/tools/configure.py", str(ANSWERS), "--data-dir", str(self.data))
        self.assertEqual(configured.returncode, 0, configured.stdout + configured.stderr)

    def assertNoExampleValues(self, haystack: str, where: str) -> None:
        for value in EXAMPLE_VALUES:
            self.assertNotIn(value, haystack, f"{where} carries the example's {value!r}")

    # ------------------------------------------------------------------ 1-4
    def test_the_bootstrap_takes_an_unconfigured_checkout_to_a_configured_one(self):
        """Absent, then example, then configured — and not one byte written inside the checkout."""
        before = repository_files()

        absent = self.check()
        self.assertEqual(absent.returncode, 1, "an unconfigured checkout must not exit 0")
        self.assertEqual(absent.stdout.splitlines()[0], "state: absent")
        self.assertIn("setup-examples.sh", absent.stdout, "the absent state has to say what to run")

        setup = self.drive("bash", "scripts/setup-examples.sh")
        self.assertEqual(setup.returncode, 0, setup.stdout + setup.stderr)
        example = self.check()
        self.assertEqual(example.returncode, 1)
        self.assertEqual(example.stdout.splitlines()[0], "state: example")
        self.assertIn("candidate_profile.json", example.stdout, "the example state names the files to replace")
        self.assertIn("identity", example.stdout, "…and what has to be asked for, per file")
        self.assertNoExampleValues(example.stdout, "the check's report")

        configured = self.drive(sys.executable, "src/tools/configure.py", str(ANSWERS), "--data-dir", str(self.data))
        self.assertEqual(configured.returncode, 0, configured.stdout + configured.stderr)
        self.assertIn("state: configured", configured.stdout)

        after = self.check()
        self.assertEqual(after.returncode, 0, after.stdout)
        self.assertEqual(after.stdout.splitlines()[0], "state: configured")

        self.assertEqual(repository_files(), before,
                         "the bootstrap wrote inside the checkout; every file it touches belongs in the data "
                         "directory, which is what `--data-dir` and `ATS_DATA_DIR` are for")

    # ------------------------------------------------------------------ 5
    def test_the_configured_checkout_produces_an_application(self):
        """`prepare` renders a real PDF, the letter resolves, and the drafter answers a real inventory."""
        self.bootstrap()
        before = repository_files()

        # `--cover-letter` IS THE FLAG THE SMOKE WALK OMITTED (2026-10-14): `prepare` had no such flag at all,
        # so the walk skipped the letter and the drafter accepted the absence. The README's drafter step
        # attaches `output/pdf/<...>_Cover_Letter.pdf`, and this drive proves the flag produces that file.
        prepared = self.drive(sys.executable, "src/pipeline/application_pipeline.py", "prepare",
                            "--profile", str(self.data / ROLE_PROFILE), "--cover-letter")
        self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
        summary = _json_tail(prepared.stdout)
        # `needs_form_mapping` is the honest first-run answer rather than a failure: the platform config this
        # run writes is a SCAFFOLD built from the profile, and mapping it onto the live form is the next step
        # (`prepare --config`). What this test proves is the other half — that a configured data directory
        # produces the application's materials at all.
        self.assertEqual(summary["status"], "needs_form_mapping", summary)
        self.assertEqual(summary["platform"], "greenhouse", "the platform comes from the profile's own URL")
        self.assertEqual(summary["pdf_pages"], 1)

        manifest = json.loads((self.data / "application_bundles" / "toronto_general_rn_emergency.json")
                              .read_text(encoding="utf-8"))
        self.assertTrue(manifest["pdf_validation"]["ok"], manifest["pdf_validation"])
        self.assertTrue(manifest["profile_validation"]["ok"], manifest["profile_validation"])
        self.assertLessEqual(manifest["pdf_validation"]["page_count"], 3)
        pdf = pathlib.Path(manifest["resume_pdf_path"])
        self.assertTrue(pdf.is_file(), f"prepare named a PDF that is not there: {pdf}")
        self.assertEqual(pdf.read_bytes()[:5], b"%PDF-")
        self.assertGreater(pdf.stat().st_size, 10_000)

        # THE COVER LETTER THE FLAG PRODUCES, at the README's path shape - output/pdf/<...>_Cover_Letter.pdf,
        # the same stem as the resume with `_Resume` swapped for `_Cover_Letter` - carrying this person's
        # facts and none of the example's.
        cover = pathlib.Path(manifest["cover_letter_pdf_path"])
        self.assertTrue(cover.is_file(), f"--cover-letter named a PDF that is not there: {cover}")
        self.assertEqual(cover.name, pdf.name.replace("_Resume.pdf", "_Cover_Letter.pdf"),
                         "the letter shares the resume's stem, as the README example shows")
        self.assertEqual(summary["cover_letter_pdf"], str(cover))
        cover_text = _pdf_text(cover)
        self.assertIn(PERSON["name"], cover_text, "the cover letter does not carry the person's own name")
        self.assertIn("Toronto General Hospital", cover_text)
        self.assertNoExampleValues(cover_text, "the cover letter prepare rendered")

        # THE FACTS ON THE PAGE ARE THE PERSON'S, AND NOTHING ELSE'S. Read out of the rendered PDF rather
        # than out of the profile, because the PDF is what an employer receives.
        text = _pdf_text(pdf)
        self.assertIn(PERSON["name"], text, "the resume does not carry the person's own name")
        self.assertIn(PERSON["city"], text)
        self.assertNoExampleValues(text, "the rendered resume")

        # THE TRACKER ROW WENT INTO THE TEMPORARY DATA DIRECTORY, in the tracker the bootstrap emptied: the
        # example's three invented applications (one of them a submission) are gone, and this run's row is
        # the only one there.
        tracker = (self.data / "applications.csv").read_text(encoding="utf-8-sig").strip().splitlines()
        self.assertEqual(len(tracker), 2, "one header and the row this run recorded")
        self.assertIn("Toronto General Hospital", tracker[1])
        self.assertIn("needs_form_mapping", tracker[1])
        self.assertIn("autofill", manifest["autofill"]["config_path"],
                      "the generated platform config belongs in the data directory, not in the source tree")
        # RESOLVED ON BOTH SIDES: on macOS `/var` is a symlink to `/private/var`, so a temporary directory's
        # path as given and the path a tool prints for the same file are two spellings of one place.
        self.assertTrue(pathlib.Path(manifest["autofill"]["config_path"]).resolve()
                        .is_relative_to(self.data.resolve()),
                        f"a generated config was written outside the data directory: "
                        f"{manifest['autofill']['config_path']}")

        # THE COVER LETTER, from the wording the bootstrap wrote — the placeholders in a hand-written template
        # are the part a bootstrap is most likely to get wrong, and an unresolved one is a refusal.
        letter = self.drive(sys.executable, "src/pipeline/build_cover_letter.py", "--no-pdf",
                          "--company", "Toronto General Hospital", "--role", "Registered Nurse, Emergency Department")
        self.assertEqual(letter.returncode, 0, letter.stdout + letter.stderr)
        letter_docx = pathlib.Path(letter.stdout.split("docx:", 1)[1].strip())
        self.assertTrue(letter_docx.is_file())
        letter_text = _docx_text(letter_docx)
        self.assertIn("Toronto General Hospital", letter_text)
        self.assertIn(PERSON["city"], letter_text)
        self.assertNoExampleValues(letter_text, "the rendered cover letter")

        # THE DRAFTER, against a form the configuration has never seen. This is the step an agent takes
        # immediately after a bootstrap: the answers have to survive being turned into a fill spec.
        spec_path = self.work / "toronto_general_rn_emergency.spec.json"
        drafted = self.drive(sys.executable, "src/forms/draft_form_spec.py", str(INVENTORY),
                          "--out", str(spec_path), "--resume", str(pdf),
                          "--job", "Toronto General Hospital — Registered Nurse, Emergency Department")
        self.assertEqual(drafted.returncode, 0, drafted.stdout + drafted.stderr)
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        review = json.loads(spec_path.with_name(spec_path.stem + ".needs_review.json").read_text(encoding="utf-8"))
        values = {entry["ref"]: entry["value"] for entry in spec["texts"]}
        options = {entry["ref"]: entry["option"] for entry in spec["selects"]}
        self.assertEqual(values["id:first_name"], "Łukasz")
        self.assertEqual(values["id:last_name"], "Żółkiewski")
        self.assertEqual(values["name:email"], PERSON["email"])
        self.assertEqual(values["id:phone"], PERSON["phone"])
        self.assertEqual(values["id:postal_code"], "M6J 1X3")
        self.assertEqual(values["id:city"], "Toronto, Ontario, Canada")
        self.assertEqual(options["id:country"], "Canada", "the country comes from the address in the profile")
        self.assertEqual([f["path"] for f in spec["files"]], [str(pdf)], "the resume this run rendered is attached")
        self.assertNoExampleValues(spec_path.read_text(encoding="utf-8"), "the drafted spec")
        self.assertNoExampleValues(json.dumps(review, ensure_ascii=False), "the drafter's review list")

        # THE ANSWER TABLE THE BOOTSTRAP WROTE IS LIVE: this question is answered by a rule in
        # `form_specs/answer_rules.json`, not by the drafter's built-in table.
        self.assertEqual(options["id:prev_employed"], "No")
        # AND A QUESTION NO PROFILE CAN ANSWER IS REPORTED, NOT GUESSED. The registration number is in no
        # configuration file, so it comes back as a gap for the person to fill in — a blank is a finding.
        reported = {entry["ref"] for entry in review["needs_review"]}
        self.assertIn("id:cno_registration", reported,
                      "a required question with no answer in the configuration must be reported, not filled")
        self.assertNotIn("id:cno_registration", {entry["ref"] for entry in spec["texts"]})
        # THE LINKEDIN FIELD STAYS EMPTY, because this person has none — and it must not have picked up the
        # example person's profile URL, which is the value no matcher would have flagged as wrong.
        self.assertNotIn("name:urls[LinkedIn]", {entry["ref"] for entry in spec["texts"]})
        self.assertIn("name:urls[LinkedIn]", reported)

        self._assert_only_scratch_was_added(before)

    def _assert_only_scratch_was_added(self, before: dict[str, tuple[int, int]]) -> None:
        after = repository_files()
        changed = sorted(set(after) - set(before)) + sorted(p for p in set(after) & set(before)
                                                            if after[p] != before[p])
        outside = [p for p in changed if not p.startswith(("output/", "tmp/"))]
        self.assertEqual(outside, [], f"a run wrote these paths inside the checkout: {outside}")
        missing = sorted(set(before) - set(after))
        self.assertEqual(missing, [], f"a run removed these paths from the checkout: {missing}")


class _ScratchWrites:
    """Everything a run adds under the checkout, taken away again when the test ends.

    `prepare` and the letter both render into `output/` and `tmp/render/<stem>/` beside the code — by design,
    and documented: those two hold generated documents and render scratch space rather than answers about a
    person. `scripts/run-contract-tests.sh` proves the tree is unchanged after ITS run, so a test that drives
    the renderer has to clear its own scratch or it would fail a guard it never meant to touch. Only files
    that were NOT there before are removed, so a real resume sitting in `output/` is never deleted.
    """

    WATCHED = ("output", "tmp")

    def __init__(self, root: pathlib.Path):
        self.root = root
        self.before = {path for name in self.WATCHED for path in self._files(root / name)}
        #: The directories that were ALREADY there — the two bases and everything under them. A DIRECTORY IS
        #: A PATH LIKE ANY OTHER to `scripts/run-contract-tests.sh`, whose guard compares the whole `find`
        #: listing, so an `output/` this test created and emptied still counts as added and has to go. The
        #: converse matters more: an `output/docx/` another test created is not this test's to remove, and a
        #: cleanup that pruned every empty directory under `output/` was quietly deleting somebody else's.
        self.directories_before = {p for name in self.WATCHED for p in self._directories(root / name)}
        self.bases_before = {name for name in self.WATCHED if (root / name).is_dir()}

    @staticmethod
    def _files(base: pathlib.Path) -> list[pathlib.Path]:
        return [p for p in base.rglob("*") if p.is_file()] if base.is_dir() else []

    @staticmethod
    def _directories(base: pathlib.Path) -> list[pathlib.Path]:
        return [p for p in base.rglob("*") if p.is_dir()] if base.is_dir() else []

    def restore(self) -> None:
        added = [p for name in self.WATCHED for p in self._files(self.root / name)
                 if p not in self.before]
        for path in sorted(added, key=lambda p: len(p.parts), reverse=True):
            path.unlink(missing_ok=True)
        # Directories the run created, deepest first, and only while they are empty: an output/docx that
        # already held someone's resume keeps it, and keeps existing.
        for base in self.WATCHED:
            created = [d for d in self._directories(self.root / base) if d not in self.directories_before]
            for directory in sorted(created, key=lambda p: len(p.parts), reverse=True):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            if base not in self.bases_before:
                try:
                    (self.root / base).rmdir()
                except OSError:
                    pass


class TheScratchCleanupRemovesOnlyItsOwnTest(unittest.TestCase):
    """`_ScratchWrites` is what keeps a bootstrap test from tripping the contract runner's tree guard.

    It is also the thing that could delete a real resume while doing it, so its rule is tested on a fabricated
    tree rather than trusted: a file that was already under `output/` stays, a file the run wrote goes, a
    directory another test created stays even when it is empty, and a base directory this test created is
    removed — because a path added to the tree is a path the guard reports, empty or not.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="scratch-cleanup-")
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "output" / "pdf").mkdir(parents=True)
        (self.root / "output" / "pdf" / "someone_elses_resume.pdf").write_bytes(b"%PDF-1.4 theirs")
        (self.root / "output" / "docx").mkdir()          # created by another test, and left empty
        (self.root / "tmp" / "render").mkdir(parents=True)

    def test_it_takes_back_what_the_run_wrote_and_nothing_else(self):
        writes = _ScratchWrites(self.root)
        (self.root / "output" / "pdf" / "ours.pdf").write_bytes(b"%PDF-1.4 ours")
        (self.root / "output" / "metrics").mkdir()
        (self.root / "output" / "metrics" / "ledger.jsonl").write_text("{}\n", encoding="utf-8")
        (self.root / "tmp" / "render" / "page-1.png").write_bytes(b"png")
        writes.restore()
        self.assertTrue((self.root / "output" / "pdf" / "someone_elses_resume.pdf").is_file(),
                        "a file that was there before the run was deleted")
        self.assertFalse((self.root / "output" / "pdf" / "ours.pdf").exists())
        self.assertFalse((self.root / "output" / "metrics").exists())
        self.assertFalse((self.root / "tmp" / "render" / "page-1.png").exists())
        self.assertTrue((self.root / "tmp" / "render").is_dir(),
                        "a directory the run did not create was removed — another test's, or a person's")
        self.assertTrue((self.root / "output" / "docx").is_dir())

    def test_a_base_directory_the_run_created_is_removed_with_it(self):
        empty = pathlib.Path(self.tmp.name) / "fresh"
        empty.mkdir()
        writes = _ScratchWrites(empty)
        (empty / "output").mkdir()
        (empty / "output" / "docx").mkdir()
        (empty / "output" / "docx" / "resume.docx").write_bytes(b"PK")
        writes.restore()
        self.assertFalse((empty / "output").exists(),
                         "an empty `output/` this run created is still a path the tree guard reports")


def _json_tail(text: str) -> dict:
    """The JSON object a tool printed, when it printed a progress line or two before it.

    `prepare` prints `summary guard OK: summary is 684 characters` and THEN its JSON, and a caller that
    assumed the whole of stdout parses would fail on a run that worked.
    """
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "{":
            return json.loads("\n".join(lines[index:]))
    raise AssertionError(f"no JSON object in the output: {text[-800:]!r}")


def _pdf_text(path: pathlib.Path) -> str:
    from pypdf import PdfReader
    return "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)


def _docx_text(path: pathlib.Path) -> str:
    from docx import Document
    document = Document(str(path))
    return "\n".join([paragraph.text for paragraph in document.paragraphs]
                     + [cell.text for table in document.tables for row in table.rows for cell in row.cells])


if __name__ == "__main__":
    unittest.main()
