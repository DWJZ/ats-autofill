#!/usr/bin/env python3
"""The focus guard has to be trusted before it is believed.

`check_no_focus_steal.py` enforces the user's rule from 2026-10-04 - "注意填写时不要抢我的焦点" - and it had
no test. Running it against the repository found three things, two of them defects in the guard itself:

1. **It reported the wrong line number.** A multi-line `/* */` block was collapsed to a single space, so
   every line after one shifted: it named line 73 for a call on line 113. A guard that points at innocent
   code is worse than no guard, because the reader concludes the guard is broken and stops running it.
2. **It could not express an exemption**, so a test driving a private headless browser - no window ever
   appears - was reported the same way as a script pulling the user's tab forward.

What the tests below cannot cover, and the file says so: an inline `node -e "..."` never touches disk, so
no static checker can see it. Browser work must be written to a file and run from there.
"""
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

spec = importlib.util.spec_from_file_location("focus_guard", ROOT / "src/tools/check_no_focus_steal.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


# The roots a real focus-stealing call is looked for in: this checkout's own script directories, plus the
# scratch directory of the CONFIGURED data directory - where a one-off driver is written, and which is not
# necessarily inside the repository once `ATS_DATA_DIR` points somewhere else (`src/paths.py` owns that
# setting). `tmp/` is left out deliberately: it is not tracked, so a test cannot vouch for it;
# `check_no_focus_steal.py` scans it on purpose and reports what it finds there.
SCANNED_ROOTS = (ROOT / "src" / "forms", ROOT / "src" / "autofill", DATA_DIR / "scratch")


def label(path: pathlib.Path) -> str:
    """A path a reader can act on: relative to the repo when it is inside it, absolute when it is not."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


class StripCommentsTest(unittest.TestCase):
    def test_a_block_comment_keeps_its_line_count(self):
        # The bug that made the guard name the wrong line. Counted on the whole text, because that is
        # what the caller compares against the file it read.
        text = "a\n/* one\ntwo\nthree */\nb\nc\n"
        self.assertEqual(len(guard.strip_comments(text).splitlines()), len(text.splitlines()))

    def test_the_line_after_a_block_comment_still_reports_its_own_number(self):
        text = "// header\n/* a\nb\nc */\nawait page.bringToFront();\n"
        reported = [i for i, line in enumerate(guard.strip_comments(text).splitlines(), 1)
                    if any(p.search(line) for p, _ in guard.PATTERNS)]
        self.assertEqual(reported, [5], "the call is on line 5 of the file that was read")

    def test_a_commented_out_call_is_not_a_call(self):
        # Several files mention these calls in comments explaining that they avoid them.
        code = guard.strip_comments("// page.bringToFront();\nawait go();\n")
        self.assertFalse(any(p.search(line) for line in code.splitlines() for p, _ in guard.PATTERNS))

    def test_a_trailing_comment_is_dropped_without_eating_the_code(self):
        code = guard.strip_comments("await page.click(x); // page.bringToFront() is not used here\n")
        self.assertIn("page.click", code)
        self.assertFalse(any(p.search(code) for p, _ in guard.PATTERNS))

    def test_a_url_is_not_mistaken_for_a_line_comment(self):
        code = guard.strip_comments('await page.goto("https://example.test/apply");\n')
        self.assertIn("https://example.test/apply", code,
                      "truncating at // would swallow the rest of any line carrying a URL")


class PatternTest(unittest.TestCase):
    def test_each_pattern_matches_the_call_it_describes(self):
        for code, label in [("await page.bringToFront();", "bringToFront"),
                            ("await page.focus();", "page.focus"),
                            ("const p = await context.newPage();", "newPage")]:
            self.assertTrue([p for p, _ in guard.PATTERNS if p.search(code)], f"{label} must be reported")

    def test_the_exemption_has_to_be_on_the_line_itself(self):
        # The marker travels with the call, so the reason is visible where it applies and cannot be
        # declared once at the top of a file to cover everything in it.
        self.assertTrue(guard.EXEMPT.search("await b.newPage(); // focus-ok: private headless browser"))
        self.assertFalse(guard.EXEMPT.search("await b.newPage();"))


class CreateTargetTest(unittest.TestCase):
    """`Target.createTarget` is the SETTLED way to open a tab - correct when it passes `background`.

    It is not in `PATTERNS`, because reporting the call itself produced 16 findings and every one of them
    already passed `background: true`. A guard that cries wolf on sixteen innocent lines is a guard nobody
    runs, and that is the state this one was in: it had no test and no one had looked at its output.
    """
    def test_a_call_with_background_is_correct(self):
        statement = 'await session.send("Target.createTarget", { url, background: true });'
        self.assertTrue(guard.CREATE_TARGET.search(statement))
        self.assertTrue(guard.BACKGROUND.search(statement))

    def test_a_call_without_background_is_the_thing_to_report(self):
        statement = 'await session.send("Target.createTarget", { url });'
        self.assertTrue(guard.CREATE_TARGET.search(statement))
        self.assertFalse(guard.BACKGROUND.search(statement), "the guard must report this one")

    def test_a_message_about_the_call_is_not_a_call(self):
        # `new Error("timeout waiting for Target.createTarget")` is a message ABOUT the call. Matching the
        # bare word reported it, which is another way this checker used to cry wolf.
        self.assertFalse(guard.CREATE_TARGET.search('new Error("timeout waiting for Target.createTarget")'))

    def test_a_comment_mentioning_it_is_not_a_call(self):
        self.assertFalse(guard.CREATE_TARGET.search(guard.strip_comments(
            "// `Target.createTarget` with `background: true` opens the tab silently.\n")))

    def test_every_call_site_in_the_tree_passes_background(self):
        # The evidence behind moving this rule off the pattern list: the whole repository is already
        # correct, so the only thing an unconditional report could do was mislead.
        offences = []
        for root in SCANNED_ROOTS:
            for path in sorted(root.rglob("*.mjs")):
                lines = guard.strip_comments(path.read_text(errors="ignore")).splitlines()
                for i, line in enumerate(lines, 1):
                    if guard.CREATE_TARGET.search(line):
                        statement = "\n".join(lines[i - 1:i + 2])
                        if not guard.BACKGROUND.search(statement):
                            offences.append(f"{label(path)}:{i}")
        self.assertEqual(offences, [], "every createTarget must pass `background:`")


class TheTrackedTreeIsCleanTest(unittest.TestCase):
    def test_no_real_focus_stealing_call_in_the_tracked_roots(self):
        # This is the one that keeps the user's rule true rather than merely written down. `tmp/` is
        # excluded because it is not tracked by git, so a test cannot vouch for it; the guard itself
        # scans it on purpose, and a violation found there is really there.
        offences = []
        for root in SCANNED_ROOTS:
            for path in sorted(root.rglob("*.mjs")):
                raw = path.read_text(errors="ignore")
                lines = raw.splitlines()
                for i, line in enumerate(guard.strip_comments(raw).splitlines(), 1):
                    raw_line = lines[i - 1] if i <= len(lines) else ""
                    for pattern, why in guard.PATTERNS:
                        if pattern.search(line) and not guard.EXEMPT.search(raw_line):
                            offences.append(f"{label(path)}:{i} - {why}")
        self.assertEqual(offences, [], "the user asked that filling never take their focus")


if __name__ == "__main__":
    unittest.main()
