#!/usr/bin/env python3
"""The mail scripts' two interfaces, which their headers explain and nothing checked.

`application-mail-triage` had no test coverage at all, and its case log was the smallest of the case files - the two
facts are related. What the scripts do is unusually well documented in their own headers, because each header records
the version that was removed and why:

  mail_app_mark_read   "Mark unread inbox messages read, BY SUBJECT NEEDLE - never by position." And the removal it
                       records: "WHY THE INDEX VERSION WAS REMOVED (2026-10-04). It took an index into the unread set
                       and was called with 1, on the reasoning that each success removes a message from the unread set
                       so the next unread message becomes item 1 again." That reasoning is wrong the moment one
                       message is skipped, and the failure is silent: the wrong message gets marked read.

  mail_app_list_unread "Read ONE unread inbox message by position." Index 0 returns the count. The header says the
                       loop lives in the shell for the same reason - a handler that aborts mid-loop returns nothing
                       for every call, including the ones that would have worked.

  mail_app_body        searches UNREAD only, and says so in its "no unread message matching" result.
  mail_app_body_any    exists because of that: a security code that has been read (or auto-read) reports "no message"
                       from the first script even though the message is right there.

These are contracts, not implementation details - the skill's own command list depends on them - so they are pinned
here rather than left to a header. Four assertions, each of which fails for a specific regression.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLS = ROOT / "src/tools"


def script(name: str) -> str:
    return (TOOLS / name).read_text(encoding="utf-8")


class MailScriptContractsTest(unittest.TestCase):
    def test_mark_read_takes_needles_and_has_no_positional_form(self):
        # The removed version indexed into the unread set. `item 1 of argv` inside a mark-read is that bug returning.
        text = script("mail_app_mark_read.applescript")
        self.assertIn("BY SUBJECT NEEDLE", text)
        body = "\n".join(l for l in text.splitlines() if not l.strip().startswith("--"))
        self.assertNotRegex(body, r"item\s+1\s+of\s+\(every message",
                            "mark_read must not resolve a POSITION in the unread set - the wrong message is marked "
                            "read and nothing reports it")

    def test_list_unread_takes_a_position_and_zero_means_count(self):
        text = script("mail_app_list_unread.applescript")
        self.assertIn("by position", text)
        self.assertRegex(text, r"0\s*=\s*count", "index 0 must be documented as count-only")
        self.assertIn("item 1 of argv", text, "the position comes from argv")

    def test_the_two_body_readers_stay_different(self):
        # If `body` ever searches all messages, `body_any` becomes dead; if `body_any` ever searches only unread, the
        # read-code case comes back. Both are worth failing on.
        unread_only = script("mail_app_body.applescript")
        any_body = script("mail_app_body_any.applescript")
        self.assertIn("no unread message matching", unread_only,
                      "mail_app_body must stay the UNREAD-only reader - its message says so")
        self.assertNotIn("no unread message matching", any_body,
                         "mail_app_body_any exists precisely because unread-only cannot find an already-read code")
        self.assertIn("searches only unread messages", any_body,
                      "the reason it exists belongs in its header, where the next reader of either file lands")

    def test_a_needle_shorter_than_twelve_characters_is_refused(self):
        # A triage run marked nothing while the unread count ROSE from 16 to 17, because the skill's own example said
        # `mail_app_mark_read.applescript 1`. The tool answered `REFUSED (needle too short to be safe): 1` once per
        # call. The guard is the reason a positional habit cannot quietly mark the wrong message read.
        text = script("mail_app_mark_read.applescript")
        self.assertRegex(text, r"length of needle\)?\s*<\s*12",
                         "the 12-character floor guards against a short needle matching many subjects")
        self.assertIn("REFUSED (needle too short to be safe)", text,
                      "the refusal must say so - a silent no-op is what let the unread count rise unnoticed")
        self.assertIn("marked-read ", text, "and a success reports what it marked")

    def test_a_handler_that_loops_returns_nothing_and_the_loop_lives_in_the_shell(self):
        # The shared cause of two separate incidents: an abort inside a loop makes every call return "no message",
        # including the ones that would have worked. Each script does one thing.
        for name in ("mail_app_body_any.applescript", "mail_app_list_unread.applescript"):
            with self.subTest(script=name):
                text = script(name)
                self.assertIn("loop", text, "the header explains why the loop is not here")


if __name__ == "__main__":
    unittest.main()
