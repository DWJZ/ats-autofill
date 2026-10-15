#!/usr/bin/env python3
"""The ledger must be append-only, never fatal, and identical from either language.

The two writers (`ledger.py` for the pipeline, `_ledger.mjs` for the form drivers) exist because one
side is Python and one is Node. That duplication is the main risk here, so one test runs the real Node
module and asserts the line it writes is what the Python reader expects.

Run:  .venv/bin/python3 -m unittest src.metrics.test_ledger
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src" / "pipeline"))

import ledger
import ledger_report as report


def line(**over) -> dict:
    base = {"at": 1_700_000_000_000, "event": "preflight", "url": "https://x/1", "slug": "acme_swe"}
    base.update(over)
    return base


class WritingLines(unittest.TestCase):
    def test_a_line_carries_the_event_and_every_field_given(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.jsonl"
            written = ledger.record("submit", path=path, slug="acme_swe", outcome="refused",
                                    detail={"reason": "required field: phone"})
            self.assertIsNotNone(written)
            rows = [json.loads(l) for l in path.read_text().splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["event"], "submit")
            self.assertEqual(rows[0]["detail"]["reason"], "required field: phone")
            self.assertIn("at", rows[0])

    def test_it_appends_and_never_rewrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.jsonl"
            ledger.record("preflight", path=path, slug="a")
            ledger.record("submit", path=path, slug="a")
            self.assertEqual(len(path.read_text().splitlines()), 2)

    def test_none_valued_fields_are_dropped_not_written_as_null(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.jsonl"
            ledger.record("preflight", path=path, slug="a", company=None)
            row = json.loads(path.read_text().strip())
            self.assertNotIn("company", row)

    def test_telemetry_never_breaks_the_caller(self):
        # A path that cannot be opened must return None, not raise: the caller is mid-submission.
        self.assertIsNone(ledger.record("submit", path=pathlib.Path("/proc/definitely/not/writable.jsonl")))

    def test_a_line_carries_only_the_event_and_its_fields(self):
        # Nothing is attached that the caller did not pass: the ledger records what happened to an
        # application, and everything else in the line is a field the caller supplied.
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.jsonl"
            ledger.record("preflight", path=path, slug="a")
            self.assertEqual(len(path.read_text().splitlines()), 1)
            self.assertEqual(set(json.loads(path.read_text().strip())), {"at", "event", "slug"})


class ReadingLines(unittest.TestCase):
    def test_a_half_written_last_line_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.jsonl"
            path.write_text(json.dumps(line()) + "\n" + '{"at": 1, "event": "sub', encoding="utf-8")
            self.assertEqual(len(report.load(path)), 1)

    def test_an_absent_ledger_is_empty_not_an_error(self):
        self.assertEqual(report.load(pathlib.Path("/nonexistent/ledger.jsonl")), [])


class GroupingApplications(unittest.TestCase):
    def test_events_are_grouped_by_slug_and_ordered(self):
        apps = report.group([line(at=300, event="closed"), line(at=100), line(at=200, event="prepare")])
        self.assertEqual(len(apps), 1)
        self.assertEqual([e["at"] for e in apps[0].events], [100, 200, 300])

    def test_a_run_without_a_slug_falls_back_to_the_url(self):
        apps = report.group([{**line(), "slug": None}])
        self.assertEqual(len(apps), 1)
        self.assertEqual(apps[0].key, "https://x/1")

    def test_two_applications_stay_two(self):
        apps = report.group([line(slug="a", url="https://x/1"), line(slug="b", url="https://x/2")])
        self.assertEqual({a.key for a in apps}, {"a", "b"})

    def test_one_application_stays_one_across_its_whole_lifecycle(self):
        """The first live ledger split every application in two: `prepare` and `submit` carry the slug,
        `record-status` does not, and `submit` records the PAGE url while the rest record the job url.
        Keying on `slug or url` counted each half separately."""
        apps = report.group([
            line(slug="acme_swe", url="https://jobs.ashbyhq.com/acme/1", event="prepare"),
            line(at=2, slug="acme_swe", url="https://jobs.ashbyhq.com/acme/1/application", event="submit"),
            line(at=3, slug=None, url="https://jobs.ashbyhq.com/acme/1", event="closed"),
        ])
        self.assertEqual(len(apps), 1, "the lifecycle is one application")
        self.assertEqual(len(apps[0].events), 3)
        self.assertEqual(apps[0].attempts, 1)
        self.assertEqual(apps[0].status, "?")  # the closed event carried no outcome in this fixture

    def test_the_union_does_not_merge_unrelated_applications(self):
        apps = report.group([
            line(slug="a", url="https://jobs.ashbyhq.com/acme/1"),
            line(at=2, slug="b", url="https://jobs.ashbyhq.com/acme/2"),
        ])
        self.assertEqual(len(apps), 2)


class AttemptsAndBlockers(unittest.TestCase):
    def test_attempts_counts_every_submit_event(self):
        app = report.group([line(event="submit", outcome="not_confirmed"),
                            line(event="submit", outcome="refused"),
                            line(event="submit", outcome="confirmed")])[0]
        self.assertEqual(app.attempts, 3)

    def test_a_confirmed_submit_is_not_a_refusal(self):
        app = report.group([line(event="submit", outcome="confirmed")])[0]
        self.assertEqual(app.refusals, [])

    def test_the_refusal_text_is_kept(self):
        app = report.group([line(event="submit", outcome="not_confirmed",
                                 detail={"errors": ["required field: phone number"]})])[0]
        self.assertIn("required field: phone number", app.refusals[0])

    def test_a_refused_gate_is_a_block_not_a_handover(self):
        """The first six gate refusals were recorded as handovers; five of them went on to submit, so the
        data proved the classification wrong."""
        app = report.group([line(event="blocked", outcome="gate_refused",
                                 detail={"failures": ["sponsorship answered Yes"]})])[0]
        self.assertEqual(app.handover_classes, [])
        self.assertIn("sponsorship answered Yes", app.blocks[0])

    def test_a_legacy_gate_refusal_is_reclassified_without_rewriting_the_line(self):
        legacy = line(event="handover", outcome="gate_failed",
                      detail={"failures": ["standing-table: reads YES, the table says OPTION"]})
        app = report.group([legacy])[0]
        self.assertEqual(app.handover_classes, [], "a gate refusal is not a handover")
        self.assertEqual(len(app.blocks), 1, "it must still be counted, as a block")
        self.assertNotIn("gate_failed", " ".join(app.refusals))

    def test_the_report_counts_handovers_and_blocks_separately(self):
        rows = [line(url="https://x/1", event="handover", outcome="captcha", detail={"reason": "a captcha"}),
                line(at=2, slug="b", url="https://x/2", event="handover", outcome="gate_failed",
                     detail={"failures": ["x"]}),
                line(at=3, slug="b", url="https://x/2", event="blocked", outcome="gate_refused",
                     detail={"failures": ["y"]})]
        text = report.report(rows, report.group(rows), top=5)
        self.assertIn("1 of 2 applications ended in a handover", text)
        self.assertIn("stopped before the click", text)

    def test_the_refusal_never_quotes_the_job_description_as_the_reason(self):
        app = report.group([line(event="submit", outcome="not_confirmed",
                                 detail={"body": "Senior Engineer Location Remote Employment Type Full time"})])[0]
        self.assertEqual(app.refusals, ["not_confirmed"],
                         "the page head is the job description, not a refusal reason")

    def test_the_refusal_prefers_the_errors_the_form_returned(self):
        app = report.group([line(event="submit", outcome="not_confirmed",
                                 detail={"errors": ["Missing entry for required field: Location"],
                                         "body": "job description"})])[0]
        self.assertIn("Missing entry", app.refusals[0])

    def test_status_prefers_the_closing_event(self):
        app = report.group([line(event="submit", outcome="confirmed"),
                            line(at=2_000, event="closed", outcome="submitted_by_agent")])[0]
        self.assertEqual(app.status, "submitted_by_agent")

    def test_a_refusal_with_no_close_reads_as_stuck(self):
        app = report.group([line(event="submit", outcome="not_confirmed")])[0]
        self.assertEqual(app.status, "stuck")


class TheReportItself(unittest.TestCase):
    def test_an_empty_ledger_says_so_rather_than_printing_zeros(self):
        text = report.report([], [], top=5)
        self.assertIn("empty", text)


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class BothWritersAgree(unittest.TestCase):
    """The Node writer and the Python writer must produce lines the same reader accepts."""

    def test_the_node_module_writes_the_schema_python_expects(self):
        module = pathlib.Path(__file__).resolve().parent.parent / "forms" / "_ledger.mjs"
        self.assertTrue(module.is_file(), "src/forms/_ledger.mjs must exist")
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "ledger.jsonl"
            driver = pathlib.Path(tmp) / "drive.mjs"
            driver.write_text(
                f'import {{ recordLedger, SUBMIT }} from "{module}";\n'
                f'const written = recordLedger(SUBMIT, {{ slug: "node_slug", url: "https://x/9",\n'
                f'  outcome: "confirmed", detail: {{ errors: [] }} }}, "{out}");\n'
                f'if (!written) process.exit(3);\n',
                encoding="utf-8",
            )
            result = subprocess.run(["node", str(driver)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = report.load(out)
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["event"], "submit")          # same event vocabulary
            self.assertEqual(row["slug"], "node_slug")
            self.assertEqual(row["outcome"], "confirmed")
            self.assertIn("at", row)

    def test_the_two_writers_use_the_same_event_names(self):
        source = (pathlib.Path(__file__).resolve().parent.parent / "forms" / "_ledger.mjs").read_text()
        for name in ("preflight", "prepare", "submit", "closed", "handover"):
            self.assertIn(f'"{name}"', source, f"_ledger.mjs is missing the {name} event")


class TelemetryCannotBreakAnApplication(unittest.TestCase):
    """`record()` swallowing its own errors is not enough: a missing or broken ledger module must not
    fail the *import* of a script that submits an application. Verified by hand — deleting
    `_ledger.mjs` leaves every submit path loading and printing its usage — and pinned here so the
    defensive form cannot be quietly simplified away."""

    def test_the_pipeline_imports_the_ledger_defensively(self):
        source = (repo_root() / "src" / "pipeline" / "application_pipeline.py").read_text()
        self.assertIn("    import ledger\n", source)
        self.assertIn("except Exception", source)
        self.assertIn("_NullLedger", source, "there must be a no-op fallback, not just a try block")

    def test_every_submit_path_imports_the_ledger_defensively(self):
        paths = [
            repo_root() / "src" / "forms" / "submit_with_verification_code.mjs",
            repo_root() / "src" / "forms" / "submit_ashby_application.mjs",
            repo_root() / "src" / "forms" / "verify_and_submit.mjs",
            repo_root() / "src" / "autofill" / "workday" / "workday_runner.mjs",
        ]
        for path in paths:
            with self.subTest(script=path.name):
                source = path.read_text()
                self.assertIn("await import(", source, "a static import would throw before the script runs")
                self.assertIn(".catch(", source, "the import needs a no-op fallback")
                self.assertNotIn('from "./_ledger.mjs";', source)
                self.assertNotIn('from "../../forms/_ledger.mjs";', source)


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[2]


class HandoversAreRecorded(unittest.TestCase):
    """A handover is the one outcome only the agent can recognise, so it needs a command to declare it."""

    def test_the_cli_writes_a_handover_event(self):
        import application_pipeline  # noqa: PLC0415 -- needs src/pipeline on sys.path
        with tempfile.TemporaryDirectory() as tmp:
            original = ledger.LEDGER
            ledger.LEDGER = pathlib.Path(tmp) / "ledger.jsonl"
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    code = application_pipeline.handover(argparse.Namespace(
                        url="https://jobs.ashbyhq.com/acme/1", klass="user_content",
                        reason="the essay asks for a personal anecdote", slug="acme_swe",
                        company="Acme", platform="auto"))
            finally:
                ledger.LEDGER = original
            self.assertEqual(code, 0)
            rows = report.load(pathlib.Path(tmp) / "ledger.jsonl")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["event"], "handover")
            self.assertEqual(rows[0]["outcome"], "user_content")
            self.assertEqual(rows[0]["detail"]["detected_by"], "agent")
            self.assertEqual(rows[0]["platform"], "ashby")

    def test_a_recorded_handover_shows_up_as_a_blocker(self):
        app = report.group([line(event="handover", outcome="captcha",
                                 detail={"reason": "an image challenge", "detected_by": "unified_runner"})])[0]
        self.assertEqual(app.handover_classes, ["captcha"])
        self.assertIn("an image challenge", app.refusals[0])
        self.assertEqual(app.status, "stuck")

    def test_the_report_breaks_handovers_down_by_class(self):
        rows = [line(event="handover", outcome="captcha", detail={"reason": "a"}),
                line(at=2, slug="b", event="handover", outcome="login", detail={"reason": "b"}),
                line(at=3, slug="c", event="handover", outcome="login", detail={"reason": "c"})]
        text = report.report(rows, report.group(rows), top=5)
        self.assertIn("handover classes", text)
        self.assertIn("| `login` | 2 |", text)
        self.assertIn("| `captcha` | 1 |", text)

    def test_every_class_has_a_meaning_in_the_report(self):
        for name in ledger.HANDOVER_CLASSES:
            self.assertIn(name, report.HANDOVER_MEANING, f"{name} would render with an empty meaning")


class TheHandoverVocabularyAgreesEverywhere(unittest.TestCase):
    """The agent picks a class, the CLI validates it against `ledger.py`, and the report renders it.
    Three copies of one list is three chances to drift — and the third copy used to be a prose reference
    file, which is the copy that could not be executed."""

    def test_python_and_node_agree(self):
        source = (repo_root() / "src" / "forms" / "_ledger.mjs").read_text()
        block = source.split("HANDOVER_CLASSES = [")[1].split("];")[0]
        js = [piece.split('"')[1] for piece in block.splitlines() if '"' in piece]
        self.assertEqual(js, list(ledger.HANDOVER_CLASSES))

    def test_both_writers_know_the_blocked_event(self):
        self.assertEqual(ledger.BLOCKED, "blocked")
        source = (repo_root() / "src" / "forms" / "_ledger.mjs").read_text()
        self.assertIn('export const BLOCKED = "blocked"', source)

    def test_the_gate_no_longer_writes_a_handover(self):
        source = (repo_root() / "src" / "forms" / "verify_and_submit.mjs").read_text()
        self.assertIn("recordLedger(BLOCKED", source)
        self.assertNotIn("recordLedger(HANDOVER", source)

    def test_the_cli_accepts_only_the_declared_classes(self):
        """The closed list is enforced by argparse, not by a sentence telling the reader it is closed.

        `handover --class` takes its choices from `ledger.HANDOVER_CLASSES`, which is what makes a class that
        nobody declared impossible to record. That used to be a claim in the handover reference file, checked by
        grepping the file for each class name; the assertion now runs the real entry point, so a class added to
        the tuple is accepted and an invented one is refused.
        """
        command = [sys.executable, str(repo_root() / "src" / "pipeline" / "application_pipeline.py"), "handover"]

        # `--help` is what makes the accepted half safe to run: argparse intercepts it before it validates
        # anything, prints the formatting of every option and exits 0 - so the accepted case reads the choices
        # out of the parser without recording a handover into the real ledger.
        accepted = subprocess.run(
            command + ["--url", "https://example.invalid/1", "--class", ledger.HANDOVER_CLASSES[0],
                       "--reason", "the CLI's own choices are the vocabulary", "--help"],
            capture_output=True, text=True, cwd=repo_root())
        self.assertEqual(accepted.returncode, 0, accepted.stderr[-400:])
        for name in ledger.HANDOVER_CLASSES:
            self.assertIn(name, accepted.stdout, f"the CLI never offers the {name} class")

        # And without --help it validates, which is the half that matters: the refusal has to come BEFORE the
        # handler runs, or an invented class would be written as a handover event and only the report would know.
        refused = subprocess.run(
            command + ["--url", "https://example.invalid/1", "--class", "invented_class",
                       "--reason", "not a class anybody declared"],
            capture_output=True, text=True, cwd=repo_root())
        self.assertNotEqual(refused.returncode, 0, "an undeclared class must not be recordable")
        self.assertIn("invalid choice", refused.stderr)


if __name__ == "__main__":
    unittest.main()
