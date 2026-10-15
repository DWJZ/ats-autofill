#!/usr/bin/env python3
"""The summary guard decides what an employer reads, and nothing tested it.

`summary_guard.py` is called by both resume builders, so every tailored resume goes through it. Its
decisions are the user's own instructions - summaries are written in the FIRST PERSON, and they are
not too long - and it refuses rather than truncates, because silently shortening a tailored sentence
changes what the employer sees.

That makes two classes of failure worth pinning, and they pull in opposite directions. Too lax and a
third-person or over-long summary reaches a PDF; too strict and a legitimate short summary is refused,
which is a real regression that already happened once: a floor was added on 2026-10-07 and removed the
same day because it refused a reasonable 254-character per-JD summary.

Nothing here asserts on the exact wording of a refusal - that is prose, and it should be free to
change. The tests assert WHICH inputs are refused.
"""
import contextlib
import importlib.util
import io
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("summary_guard", ROOT / "src/pipeline/summary_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def quietly(fn, *args, **kwargs):
    """Run a guard that prints on success; the print is not what is under test."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args, **kwargs)


class FirstPersonTest(unittest.TestCase):
    def test_a_summary_about_the_candidate_is_refused(self):
        # The user's instruction: summaries say "I build...", never "he builds...".
        for text in ["He builds backend systems.",
                     "She led the migration to Kubernetes.",
                     "His record includes eight years of TypeScript."]:
            with self.assertRaises(SystemExit, msg=text):
                quietly(guard.assert_first_person, text)

    def test_a_subjectless_fragment_does_not_satisfy_the_rule(self):
        with self.assertRaises(SystemExit):
            quietly(guard.assert_first_person,
                    "Backend engineer with eight years across TypeScript, Go and Kubernetes.")

    def test_a_first_person_summary_passes(self):
        quietly(guard.assert_first_person,
                "I build backend systems, and my record includes eight years across TypeScript and Go.")

    def test_an_empty_summary_is_refused_rather_than_ignored(self):
        for text in ["", None]:
            with self.assertRaises(SystemExit, msg=repr(text)):
                quietly(guard.assert_first_person, text)


class SummaryLengthTest(unittest.TestCase):
    def text_of(self, length):
        """A first-person summary of exactly `length` characters."""
        return "I " + "x" * (length - 2)

    def test_the_hard_edge_is_inclusive(self):
        quietly(guard.assert_summary_fits, self.text_of(guard.HARD_EDGE))
        with self.assertRaises(SystemExit):
            quietly(guard.assert_summary_fits, self.text_of(guard.HARD_EDGE + 1))

    def test_there_is_no_floor(self):
        # A floor was tried on 2026-10-07 and removed the same day: it refused a reasonable
        # 254-character summary, and the user asked for per-JD customisation to stay flexible.
        for length in (20, 100, 254):
            quietly(guard.assert_summary_fits, self.text_of(length))

    def test_strict_refuses_the_grey_zone_above_the_safe_max(self):
        text = self.text_of(guard.SAFE_MAX + 1)
        quietly(guard.assert_summary_fits, text)
        with self.assertRaises(SystemExit):
            quietly(guard.assert_summary_fits, text, strict=True)

    def test_the_safe_max_itself_is_inside_the_grey_zone_not_outside_it(self):
        quietly(guard.assert_summary_fits, self.text_of(guard.SAFE_MAX), strict=True)

    def test_the_guard_reports_and_never_edits(self):
        # Refusing rather than truncating is the whole design: cutting a tailored sentence silently
        # would change what the employer reads.
        text = self.text_of(guard.HARD_EDGE + 50)
        before = str(text)
        with self.assertRaises(SystemExit):
            quietly(guard.assert_summary_fits, text)
        self.assertEqual(text, before)

    def test_the_first_person_rule_is_checked_before_the_length_one(self):
        # A third-person summary that is also too long must fail for the reason a person can act on.
        text = "He " + "x" * (guard.HARD_EDGE + 50)
        with self.assertRaises(SystemExit):
            quietly(guard.assert_summary_fits, text)


class ConstantsTest(unittest.TestCase):
    def test_the_numbers_are_the_ones_the_builders_rely_on(self):
        # Named here because a change to any of them changes what every future resume may say.
        self.assertEqual((guard.SAFE_MIN, guard.SAFE_MAX, guard.HARD_EDGE), (450, 800, 950))

    def test_the_summary_helper_describes_the_bounds_it_enforces(self):
        line = guard.summarise("I build things.")
        for value in (str(guard.SAFE_MIN), str(guard.SAFE_MAX), str(guard.HARD_EDGE)):
            self.assertIn(value, line)


_cli_spec = importlib.util.spec_from_file_location(
    "check_profile_summaries", ROOT / "src/tools/check_profile_summaries.py")
cli = importlib.util.module_from_spec(_cli_spec)
_cli_spec.loader.exec_module(cli)


class TheTwoChecksAgreeTest(unittest.TestCase):
    """Two gates with two sets of numbers, and the WEAKER one runs first.

    `check_profile_summaries.py` carried its own 1200/1250, measured against a layout this project no
    longer produces, while this guard enforced 800/950. So `check_profile_summaries.py && prepare` - the
    order the case log recommends - could clear the first gate and be refused by the second. A green light
    from a check that is not the check that decides is worse than no check, because it gets trusted.
    """
    def test_the_cli_takes_its_limits_from_this_guard(self):
        self.assertEqual((cli.TARGET, cli.HARD_LIMIT), (guard.SAFE_MAX, guard.HARD_EDGE))

    def test_nothing_can_clear_the_first_gate_and_fail_the_second(self):
        # The property behind the numbers, stated as a property so it survives a recalibration.
        for length in (200, guard.SAFE_MAX, guard.HARD_EDGE):
            text = "I " + "x" * (length - 2)
            quietly(guard.assert_summary_fits, text)
            self.assertLessEqual(len(text), cli.HARD_LIMIT,
                                 "a summary this guard accepts must not be over the CLI's limit")

    def test_a_sweep_audits_while_a_named_file_gates(self):
        # 1005 of the 1335 saved profiles predate the layout these limits were measured for, so a sweep
        # that exited 1 could never sit in front of `prepare`. Named files are the gate.
        self.assertEqual(quietly(cli.main, []), 0)


if __name__ == "__main__":
    unittest.main()
