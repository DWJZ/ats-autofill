#!/usr/bin/env python3
"""A board inside its application limit must not be applied to again.

The cap file is data and `test_tenant_policies.py` holds its shape. What that file could not say is whether the
counting is RIGHT — and the counting is the whole point: the limit exists to stop a second submission, so a
counter that misses a submission, or attributes another employer's to this board, or lets an expired one expire,
is the difference between a refusal and an application that cannot be taken back.

Every case below is a real one, named with its tenant and date where it happened:

  * Ro, 2026-10-05 — slug `ro` matched 84 submissions at Anthropic, Robinhood and Roblox.
  * Coinbase, 2026-10-09 — its own mail states a 4-per-30-days limit while its posting states 3 per 6 months,
    and the three requisitions it wrote about had been recorded as submitted and confirmed four days earlier.

`today` is a parameter for exactly this reason: a window assertion written against the wall clock passes today
and rots by itself. Each test passes a frozen date.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import tracker_index as tracker  # noqa: E402  (the one place that reads the CSV, BOM handled)
import tenant_caps as caps_mod  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

CAPS_FILE = DATA_DIR / "form_specs" / "tenant_caps.json"

TODAY = dt.date(2026, 10, 9)
GREENHOUSE = "https://job-boards.greenhouse.io/{slug}/jobs/1234567"


def row(company: str, slug: str, date_added: str = "2026-10-05",
        status: str = "submitted_by_agent") -> dict:
    """One tracker row, in the shape `tracker_index.load_rows` produces."""
    return {"company": company, "title": "Software Engineer",
            "source": GREENHOUSE.format(slug=slug), "status": status, "date_added": date_added}


def caps_entry(slug: str, cap: int, window_days: int, kind: str = "count", **extra) -> dict:
    entry = {"slug": slug, "cap": cap, "window_days": window_days, "kind": kind,
             "note": "", "source": "test"}
    entry.update(extra)
    return entry


class ABoardInsideItsLimitIsRefused(unittest.TestCase):
    def test_a_board_at_its_limit_is_refused(self):
        rows = [row("Coinbase", "coinbase", f"2026-10-0{d}") for d in (1, 2, 3)]
        block = caps_mod.blocking_rule(rows, [caps_entry("coinbase", 3, 180)], "coinbase", TODAY)
        self.assertIsNotNone(block, "three submissions against a limit of three is a refusal")
        self.assertEqual(block.used, 3)

    def test_a_board_below_its_limit_is_allowed(self):
        rows = [row("Coinbase", "coinbase", "2026-10-01"), row("Coinbase", "coinbase", "2026-10-02")]
        self.assertIsNone(caps_mod.blocking_rule(rows, [caps_entry("coinbase", 3, 180)], "coinbase", TODAY))

    def test_a_row_recorded_but_never_sent_does_not_count(self):
        # A row is not a submission. Counting `not_applied` / `filled_for_review` rows would lock out a
        # requisition that is still open to apply to - the opposite of what the limit is for.
        rows = [row("Coinbase", "coinbase", "2026-10-01", status="not_applied"),
                row("Coinbase", "coinbase", "2026-10-02", status="filled_for_review"),
                row("Coinbase", "coinbase", "2026-10-03", status="")]
        self.assertIsNone(caps_mod.blocking_rule(rows, [caps_entry("coinbase", 1, 180)], "coinbase", TODAY))

    def test_a_submission_older_than_the_window_does_not_count(self):
        rows = [row("Roblox", "roblox", "2026-06-01")]  # 130 days before TODAY, window is 30
        self.assertIsNone(caps_mod.blocking_rule(rows, [caps_entry("roblox", 1, 30)], "roblox", TODAY))

    def test_the_last_day_of_the_window_still_counts(self):
        # Exactly `window_days` old is INSIDE the window; one day more is outside. Off-by-one here is a
        # submission that the tenant counts and the preflight did not.
        inside = [row("Roblox", "roblox", "2026-09-09")]   # 30 days
        outside = [row("Roblox", "roblox", "2026-09-08")]  # 31 days
        self.assertIsNotNone(caps_mod.blocking_rule(inside, [caps_entry("roblox", 1, 30)], "roblox", TODAY))
        self.assertIsNone(caps_mod.blocking_rule(outside, [caps_entry("roblox", 1, 30)], "roblox", TODAY))

    def test_a_submission_with_no_readable_date_counts(self):
        # A malformed date must not buy a free application against a board that has already refused one.
        rows = [row("Roblox", "roblox", "")]
        block = caps_mod.blocking_rule(rows, [caps_entry("roblox", 1, 30)], "roblox", TODAY)
        self.assertIsNotNone(block, "an unreadable date is counted, conservatively")
        self.assertEqual(block.undated, 1, "and it is reported, so the cell gets fixed")

    def test_a_same_role_cooldown_counts_inside_its_window_and_not_before(self):
        # Forus states one application per role per 90 days: the same counting, a different kind.
        rows = [row("Forus", "forus", "2026-08-01")]  # 69 days, inside
        entry = caps_entry("forus", 1, 90, kind="same_role_cooldown")
        self.assertIsNotNone(caps_mod.blocking_rule(rows, [entry], "forus", TODAY))

    def test_a_state_limit_counts_every_submission_however_old(self):
        # `one_at_a_time` is a state, not a count over time: an application from two years ago still occupies
        # the slot the tenant allows.
        rows = [row("Applied Intuition", "appliedintuition", "2024-01-01")]
        entry = caps_entry("appliedintuition", 1, 0, kind="one_at_a_time")
        block = caps_mod.blocking_rule(rows, [entry], "appliedintuition", TODAY)
        self.assertIsNotNone(block)
        self.assertEqual(block.used, 1)


class EveryStatedLimitIsEnforced(unittest.TestCase):
    """Coinbase, 2026-10-09: the posting says 3 per 6 months, the tenant's own mail says 4 per 30 days.

    Keeping only the posting's figure is what makes a board look open while the tenant is refusing it, so both
    are enforced and the board is refused when ANY of them is reached.
    """

    ENTRY = caps_entry("coinbase", 3, 180,
                       also_stated=[{"cap": 1, "window_days": 30, "kind": "count", "source": "mail"}])

    def test_the_shorter_stated_limit_blocks_even_when_the_recorded_one_is_not_reached(self):
        rows = [row("Coinbase", "coinbase", "2026-09-20")]  # 19 days: 1 of 3 in the long window, 1 of 1 in the short
        block = caps_mod.blocking_rule(rows, [self.ENTRY], "coinbase", TODAY)
        self.assertIsNotNone(block, "the mailed limit is reached even though the posting's is not")
        self.assertEqual((block.cap, block.window_days), (1, 30))
        self.assertEqual(block.source, "mail", "the reader must see which of the two rules said no")

    def test_both_limits_are_weighed_so_the_report_can_show_which_one_bound(self):
        rows = [row("Coinbase", "coinbase", "2026-10-05")]
        checks = caps_mod.check_board(rows, [self.ENTRY], "coinbase", TODAY)
        self.assertEqual([(c.cap, c.window_days) for c in checks], [(3, 180), (1, 30)])
        self.assertEqual([c.reached for c in checks], [False, True])

    def test_a_looser_stated_limit_cannot_unblock_a_reached_one(self):
        # The dangerous direction: a second rule that looks permissive must never turn a refusal into a go.
        entry = caps_entry("coinbase", 1, 30,
                           also_stated=[{"cap": 99, "window_days": 3650, "kind": "count", "source": "mail"}])
        self.assertIsNotNone(caps_mod.blocking_rule([row("Coinbase", "coinbase")], [entry], "coinbase", TODAY))

    def test_an_extra_limit_without_a_kind_inherits_the_recorded_one(self):
        entry = caps_entry("coinbase", 3, 180,
                           also_stated=[{"cap": 1, "window_days": 30, "source": "mail"}])
        rules = caps_mod.rules_of(entry)
        self.assertEqual([r["kind"] for r in rules], ["count", "count"])


class ASlugIsAPathSegmentNotASubstring(unittest.TestCase):
    """Ro, 2026-10-05: the two-letter slug `ro` matched 84 submissions at other employers."""

    OTHERS = [row("Anthropic", "anthropic"), row("Robinhood", "robinhood"), row("Roblox", "roblox")]

    def test_another_employers_submissions_are_not_counted_against_a_short_slug(self):
        used, _ = caps_mod.count_used(self.OTHERS, "ro", "count", 180, TODAY)
        self.assertEqual(used, 0, "none of these rows is on Ro's board")
        self.assertIsNone(caps_mod.blocking_rule(self.OTHERS, [caps_entry("ro", 1, 180)], "ro", TODAY))

    def test_the_same_board_is_recognised_through_every_url_shape_the_tracker_holds(self):
        cases = {
            "https://job-boards.greenhouse.io/blend/jobs/6190338004": "blend",
            "https://boards.greenhouse.io/chime/jobs/8765684002?gh_jid=8765684002": "chime",
            "https://job-boards.greenhouse.io/embed/job_app?for=blend&token=6190338004": "blend",
            "https://jobs.lever.co/ro/54c9a32f-7c6f-4b02-a971-c2404b20c428": "ro",
            "https://jobs.ashbyhq.com/alpacahealth/1c8c1560-3a94-4672-90bb-3e9677215e21": "alpacahealth",
            "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/JR111970": "acme",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(caps_mod.board_slug_of(url), expected)

    def test_an_unreadable_url_is_not_matched_to_a_board(self):
        for source in ("", None, "not a url", "https://job-boards.greenhouse.io/embed/job_app"):
            with self.subTest(source=source):
                self.assertFalse(caps_mod.board_matches("coinbase", source))

    def test_a_row_on_a_host_that_carries_no_board_slug_still_counts(self):
        # `careers.roblox.com/jobs/8072244` yields the path segment `jobs`, which is no board, so Roblox's
        # 5-per-30-days limit counted one submission fewer than the tracker holds (2026-10-09, the row dated
        # 2026-09-13). Under-counting is the direction that matters: it lets a capped board take one more.
        careers_row = {"company": "Roblox", "status": "submitted_by_user", "date_added": "2026-09-13",
                       "source": "https://careers.roblox.com/jobs/8072244?gh_jid=8072244"}
        self.assertTrue(caps_mod.row_is_on_board(careers_row, "roblox"))
        self.assertEqual(caps_mod.count_used([careers_row], "roblox", "count", 30, TODAY)[0], 1)

    def test_the_company_fallback_does_not_match_a_longer_company_name(self):
        # The fallback compares WHOLE NAMES, never substrings: a slug `applied` must not be answered by a row
        # for a different employer whose name happens to contain it. `Ro` inside `Robinhood` is how this was
        # got wrong before, and it is what made 84 rows look like one tenant's.
        for company, slug in (("Robinhood", "ro"), ("Applied Intuition", "applied"), ("Roblox", "ro")):
            with self.subTest(company=company, slug=slug):
                self.assertFalse(caps_mod.row_is_on_board(
                    {"company": company, "source": "https://example.com/x", "status": "submitted_by_agent"}, slug))


class TheRealCapsFileRefusesTheBoardsItShould(unittest.TestCase):
    """The data and the code together, frozen at 2026-10-09 so the assertion cannot rot.

    This is the Coinbase case end to end: eight recorded submissions, a 3-per-180-days rule from the posting and
    a 4-per-30-days rule from the tenant's own mail, and a mailbox holding three notices about requisitions that
    were confirmed on 2026-10-05 and counted by neither rule afterwards.
    """

    @classmethod
    def setUpClass(cls):
        cls.caps = json.loads(CAPS_FILE.read_text(encoding="utf-8"))["caps"]
        cls.rows = tracker.load_rows()

    #: This project's own learned caps. `examples/tenant_caps.example.json` records invented boards instead, so
    #: the guard below is about PRESENCE: the example file has none of these, a real file that has lost one
    #: still fails the assertions.
    LEARNED_BOARDS = ("roblox", "coinbase", "applied", "oneapp")

    def require_learned_boards(self) -> None:
        """Skip the per-board assertions when this checkout has none of the boards they are about.

        Each of these describes one board's recorded history - Coinbase's two stated limits, Roblox's
        five-in-30 that closes the excess rather than refusing it, Applied Intuition's one-at-a-time - found in
        that employer's posting, mail or form. That history belongs to one person's search; the examples carry
        invented boards, and there is nothing here for these three to be about.
        """
        if not any(entry["slug"] in self.LEARNED_BOARDS for entry in self.caps):
            raise unittest.SkipTest(
                "the installed caps file records none of this project's own boards "
                f"({', '.join(self.LEARNED_BOARDS)}): the examples ship invented ones, so the board history "
                "these three tests assert against does not exist here")

    def test_coinbase_is_blocked_by_every_limit_it_states(self):
        self.require_learned_boards()
        checks = caps_mod.check_board(self.rows, self.caps, "coinbase", TODAY)
        self.assertGreaterEqual(len(checks), 2, "Coinbase states more than one limit")
        for check in checks:
            with self.subTest(rule=check.describe()):
                self.assertTrue(check.reached, f"{check.describe()} is reached")
                self.assertGreaterEqual(check.used, check.cap)
        self.assertIsNotNone(caps_mod.blocking_rule(self.rows, self.caps, "coinbase", TODAY))

    def test_a_board_with_no_recorded_limit_is_not_blocked(self):
        self.assertEqual(caps_mod.check_board(self.rows, self.caps, "not-a-recorded-tenant", TODAY), [])
        self.assertIsNone(caps_mod.blocking_rule(self.rows, self.caps, "not-a-recorded-tenant", TODAY))

    def test_every_recorded_slug_round_trips_through_the_parser(self):
        # A slug the parser cannot return is a cap that never fires, whatever the file says. This is the check
        # the file-shape test cannot make: only the parser knows what a slug becomes once it is read from a URL.
        for entry in self.caps:
            slug = caps_mod.norm_slug(entry.get("slug"))
            with self.subTest(slug=slug):
                self.assertEqual(
                    caps_mod.board_slug_of(f"https://job-boards.greenhouse.io/{slug}/jobs/1"), slug)

    def test_every_recorded_slug_can_count_at_least_one_tracker_row(self):
        # A cap is only real if the slug can reach the rows it limits. Two of them could not: `applied
        # intuition` and `onepay` are company names, and preflight_role.py is handed the slug out of the
        # posting's url (`applied`, `oneapp`), so neither entry ever fired - while the tracker went on
        # recording five submissions at Applied Intuition's board. This is the test that would have caught it.
        orphans = [entry["slug"] for entry in self.caps
                   if not any(caps_mod.row_is_on_board(r, entry["slug"]) for r in self.rows)]
        self.assertEqual(orphans, [], "these caps match no tracker row, so they can never fire")

    def test_the_two_caps_keyed_by_company_name_now_fire(self):
        # Applied Intuition's one-application-at-a-time limit is the expensive one: the board that refuses a
        # second concurrent application holds five recorded submissions.
        self.require_learned_boards()
        applied = caps_mod.blocking_rule(self.rows, self.caps, "applied", TODAY)
        self.assertIsNotNone(applied, "the Applied Intuition board is over its one-at-a-time limit")
        self.assertGreaterEqual(applied.used, 5)
        self.assertIsNotNone(caps_mod.blocking_rule(self.rows, self.caps, "oneapp", TODAY),
                             "the OnePay board is over its same-role cooldown")

    def test_the_old_company_name_spellings_match_nothing(self):
        # Kept as a guard on the fix rather than for its own sake: if normalisation ever grows loose enough to
        # equate `onepay` with `oneapp`, it has also grown loose enough to equate two different employers.
        for slug in ("applied intuition", "onepay"):
            with self.subTest(slug=slug):
                self.assertIsNone(caps_mod.blocking_rule(self.rows, self.caps, slug, TODAY))

    def test_roblox_counts_the_row_its_own_careers_site_carries(self):
        # Seven submitted Roblox rows, one of them on careers.roblox.com rather than the Greenhouse board.
        self.require_learned_boards()
        used, _ = caps_mod.count_used([r for r in self.rows if caps_mod.row_is_on_board(r, "roblox")],
                                      "roblox", "count", 30, TODAY)
        self.assertGreaterEqual(used, 5, "Roblox allows 5 in 30 days and the tracker holds more than that")
        self.assertIsNotNone(caps_mod.blocking_rule(self.rows, self.caps, "roblox", TODAY))


class ThePreflightEntryPointRefusesTheBoard(unittest.TestCase):
    """The module above is only half of it: what actually stops a round is `data/scratch/preflight_role.py`.

    This drives that script as a caller does, with a requisition id that is in no row and no bundle, so the
    verdict can only come from the cap. It is the test that would have caught the old state of the world on its
    own — the counter was never even reached, because the entry it looked for could not match the slug the
    script was handed.

    THE ENTRY POINT IS A PRIVATE ONE-OFF SCRIPT and is not part of this checkout, so with it absent these
    three tests skip: they drive that caller, not the cap module. `tenant_caps.py`'s own refusals are still
    asserted above, against this repository's caps file.
    """

    PREFLIGHT = DATA_DIR / "scratch" / "preflight_role.py"

    def setUp(self):
        if not self.PREFLIGHT.is_file():
            raise unittest.SkipTest(
                "data/scratch/preflight_role.py is a private per-role entry point and is not part of this "
                "checkout, so the caller these tests drive does not exist here")

    def run_preflight(self, ats: str, slug: str, job_id: str) -> str:
        done = subprocess.run(
            [sys.executable, str(self.PREFLIGHT), "--ats", ats, "--slug", slug, "--job-id", job_id],
            cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.returncode = done.returncode
        return done.stdout + done.stderr

    def test_a_capped_board_is_refused_at_the_entry_point(self):
        out = self.run_preflight("greenhouse", "coinbase", "1999999")
        self.assertIn("KNOWN CAP REACHED", out)
        self.assertEqual(self.returncode, 1, out[-600:])

    def test_the_board_whose_cap_never_used_to_fire_is_refused_now(self):
        # Applied Intuition: keyed `applied intuition` until 2026-10-09, so this exact call used to answer
        # "clear - not recorded in the tracker or in any bundle" for a board with five submissions on it.
        out = self.run_preflight("ashby", "applied", "00000000-1111-2222-3333-444444444444")
        self.assertIn("TENANT CAP", out)
        self.assertIn("KNOWN CAP REACHED", out)
        self.assertEqual(self.returncode, 1, out[-600:])

    def test_an_uncapped_board_is_still_cleared(self):
        # The other direction: a preflight that refuses everything is as useless as one that refuses nothing.
        out = self.run_preflight("greenhouse", "notacappedtenant", "1888888")
        self.assertIn("RESULT: clear", out)
        self.assertEqual(self.returncode, 0, out[-600:])


if __name__ == "__main__":
    unittest.main()

    def test_a_same_role_cooldown_is_counted_board_wide(self):
        """Pins a KNOWN LIMITATION, not a desired behaviour.

        Cognition's form says "we limit applications to one per role every 3 months". The kind is
        `same_role_cooldown`, and the counting is board-wide because nothing passes a role title in - so three
        board-wide submissions block a role that was never applied to. That was accepted deliberately: a false block
        costs one application, a duplicate costs the candidate's credibility.

        If this test fails, the limitation has been FIXED. Do not simply update it: the caller now matches per role,
        and the case that produced this note can be deleted for real.
        """
        self.assertIn("same_role_cooldown", tenant_caps.KINDS)
        self.assertIn("same_role_cooldown", tenant_caps.WINDOWED_KINDS)
        source = (pathlib.Path(__file__).parent / "tenant_caps.py").read_text(encoding="utf-8")
        for word in ("role_title", "title"):
            self.assertNotIn(word, source.split("KINDS =")[1].split("\n\n\n")[0],
                             "a role title has appeared in the counting logic - the limitation may be gone; "
                             "check before trusting this note")
