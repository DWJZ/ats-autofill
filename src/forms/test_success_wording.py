#!/usr/bin/env python3
"""The success wording is a decision two incidents shaped in opposite directions.

`thank you[^.]{0,150}` - wide enough to swallow a form's own INTRODUCTORY COURTESY TEXT. Crux's form opens "Thank you
for your interest in joining Crux Climate! Kindly share how you heard about this opportunity...", so a form that was
live, with eleven inputs and a submit button, produced a success word. The wide pattern was removed.

Oneleet, recorded in the code's own comment: its success page DOES read "Thank you for your interest in Oneleet and what
we are building here", and with the wide alternative gone a genuinely submitted application was reported UNCONFIRMED -
three pointless retries and two spurious "the resume is missing" investigations against a page that had no form left.

The phrase is genuinely both, and text alone cannot separate them. What the code does instead is treat a match as a
hint that the POST landed, with the screenshot as the authority - a decision, made twice, that nothing recorded.

THE SCOPE OF THIS TEST WAS WRONG ON ITS FIRST RUN, and the way it was wrong is the reason for this paragraph. It
flagged `thank you[^.]{0,240}` in `ashby_finish_form.mjs` as "the Crux pattern is back". That regex is real, and it is
in the AFTER-submission reporter, where it captures a message to PRINT for a human - not in any decision about whether
a submission happened. Wide-and-printed is not wide-and-believed. The assertion was true and its meaning was wrong,
which is worse than a false one: it would have had someone "fix" a log line.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

# The files where a match DECIDES something: `confirmed` / `ok` become true from it.
DECIDERS = ["submit_with_verification_code.mjs", "submit_ashby_application.mjs"]
# The file that REPORTS: it prints whatever it matched, and nothing downstream reads it as a verdict.
REPORTERS = ["ashby_finish_form.mjs"]


class SuccessWordingTest(unittest.TestCase):
    def source(self, name: str) -> str:
        return (ROOT / "src/forms" / name).read_text(encoding="utf-8")

    def test_no_decider_swallows_a_courtesy_paragraph(self):
        # `thank you` followed by up to N non-dots matches Crux's opening paragraph. It was removed from the deciders;
        # the assertion is that it stays removed THERE.
        for name in DECIDERS:
            with self.subTest(script=name):
                text = self.source(name)
                # look only at lines that are part of a verdict
                for line in text.splitlines():
                    if not re.search(r"confirmed\s*=|ok\s*=|test\(", line):
                        continue
                    self.assertNotRegex(line, r"thank you\s*\[\^\.\]",
                                        f"{name}: a courtesy-swallowing alternative is back in a DECISION: {line.strip()[:90]}")

    def test_the_spelled_out_phrase_is_still_matched_by_the_submitter_that_faced_it(self):
        # Dropping it is the false negative that cost Oneleet three retries and two fake investigations.
        self.assertIn("thank you for your interest", self.source("submit_with_verification_code.mjs"),
                      "the Oneleet success page reads this; without it a real submission reports unconfirmed")

    def test_a_match_is_a_hint_and_the_screenshot_is_the_authority(self):
        # The mitigation, which is a sentence in a comment and nothing else. Asserting the sentence is weak, and it is
        # asserted anyway: the alternative is that the next reader widens the pattern without meeting it.
        text = self.source("submit_with_verification_code.mjs")
        self.assertRegex(text, r"screenshot stays the authority")
        self.assertIn("_after_submit.png", text, "the screenshot must still be taken for that sentence to mean anything")

    def test_the_reporter_may_be_wide_because_nothing_believes_it(self):
        # The distinction this test learned the hard way. `ashby_finish_form.mjs` captures a long "thank you..." string
        # to PRINT, and a wide capture there is correct - it is how a human reads what the page said. What matters is
        # that the file does not turn it into a verdict: its confirmation comes from verify_and_submit's own output.
        text = self.source("ashby_finish_form.mjs")
        self.assertRegex(text, r'/"confirmed":\s*\\s\*true/\.test',
                         "the reporter must take its verdict from the gate, not from the text it captured")
        for line in text.splitlines():
            if re.search(r"confirmed\s*=\s*|ok\s*=\s*true", line):
                self.assertNotIn("thanks", line,
                                 "a captured courtesy string must not become a verdict in the reporter")


if __name__ == "__main__":
    unittest.main()
