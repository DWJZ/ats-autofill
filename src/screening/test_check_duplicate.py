#!/usr/bin/env python3
"""The dedupe's URL parser, and the shape that actually cost a duplicate.

One Imaging:

    One Imaging's Full Stack Software Engineer (Greenhouse posting 4018408009) was submitted on 2026-09-30 from the
    embed URL `job-boards.greenhouse.io/embed/job_app?token=4018408009&for=oneimaging` and submitted AGAIN from the
    board URL `job-boards.greenhouse.io/oneimaging/jobs/4018408009`.

`parse_posting` folded the second and returned `(None, None, None)` for the first, so the pair was never compared. That
defect was still live when the case recording it was being deleted - the parser recognised an embed form that uses
`gh_jid=` and not the one that uses `token=`, which is the form this tenant actually emitted.

The first assertion here is therefore not a format test but the duplicate itself: two URLs, one identity.
"""
import contextlib
import importlib.util
import io
import pathlib
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("check_duplicate", ROOT / "src/screening/check_duplicate.py")
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)


class ParsePostingTest(unittest.TestCase):
    def test_the_two_urls_that_cost_a_duplicate_are_one_identity(self):
        # If these ever differ, the dedupe cannot see that the second application is the first one again.
        embed = cd.parse_posting(
            "https://job-boards.greenhouse.io/embed/job_app?token=4018408009&for=oneimaging")
        board = cd.parse_posting("https://job-boards.greenhouse.io/oneimaging/jobs/4018408009")
        self.assertEqual(embed, board, "the embed and board URLs must fold to the same requisition")
        self.assertEqual(embed, ("greenhouse", "oneimaging", "4018408009"))

    def test_the_boards_host_folds_into_the_job_boards_host_identity(self):
        # Greenhouse's own board, 2026-10-14 (cold-start smoke test): a real posting URL on the platform's
        # OTHER host, https://boards.greenhouse.io/greenhouse/jobs/8279799, came back
        # `REVIEW: unrecognised posting URL shape - check by hand.` and prepare-written rows then read
        # `req None | unparsed` in dedupe. The parser already knew the job-boards host of the same
        # requisition; the two hosts are one posting and must fold to one identity - platform, board slug,
        # numeric id - so a row recorded from either host is seen as the same application.
        job_boards = cd.parse_posting("https://job-boards.greenhouse.io/greenhouse/jobs/8279799")
        boards = cd.parse_posting("https://boards.greenhouse.io/greenhouse/jobs/8279799")
        self.assertEqual(boards, job_boards, "the same requisition on the two hosts must be one identity")
        self.assertEqual(boards, ("greenhouse", "greenhouse", "8279799"))

    def test_the_rejection_message_names_the_accepted_shapes(self):
        # The other half of the same finding: the refusal was a dead end - a human reading "unrecognised
        # posting URL shape - check by hand." could not tell WHICH shapes are accepted, so there was nothing
        # to act on. The message must name them, starting with the Greenhouse board shapes the finding was
        # about.
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            with mock.patch.object(cd, "load_tracker", return_value=[]):
                cd.main(["https://example.com/careers/12345"])
        out = buf.getvalue()
        self.assertIn("unrecognised posting URL shape", out)
        self.assertIn("job-boards.greenhouse.io/", out, "the message names the accepted shapes")
        self.assertIn("boards.greenhouse.io/", out, "including the host that was just added")

    def test_both_parameter_orders_work(self):
        # The tenant emitted `token=` first; the other order is what a hand-written link looks like.
        a = cd.parse_posting("https://boards.greenhouse.io/embed/job_app?token=1234567&for=acme")
        b = cd.parse_posting("https://boards.greenhouse.io/embed/job_app?for=acme&token=1234567")
        self.assertEqual(a, b)
        self.assertEqual(a, ("greenhouse", "acme", "1234567"))

    def test_the_gh_jid_embed_form_still_works(self):
        # The shape that WAS handled, kept so a future edit to the new branch cannot silently drop it.
        self.assertEqual(cd.parse_posting("https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=1234567"),
                         ("greenhouse", "acme", "1234567"))

    def test_the_posting_and_application_routes_of_one_posting_are_one_identity(self):
        # Microsoft's careers site (Eightfold) identifies a posting by a numeric pid and reaches it on two
        # routes: the posting itself and its apply route. They are one application, so the pair has to fold -
        # the same shape as the Greenhouse pair above, on a different platform. A tracker row recorded from the
        # apply route and a posting read from the board route would otherwise never be compared.
        posting = cd.parse_posting("https://apply.careers.microsoft.com/careers/job/1970393556977374")
        apply_route = cd.parse_posting("https://apply.careers.microsoft.com/careers/apply?pid=1970393556977374")
        self.assertEqual(apply_route, posting,
                         "a posting and its apply route must resolve to one requisition id")
        self.assertEqual(posting, ("eightfold", "microsoft", "1970393556977374"))

    def test_a_different_pid_is_still_a_different_posting(self):
        # The fold is on the pid, NOT on the host: folding too eagerly would hide a genuine second
        # requisition at the same employer, which is the whole reason the dedupe keys on an id.
        first = cd.parse_posting("https://apply.careers.microsoft.com/careers/job/1970393556977374")
        second = cd.parse_posting("https://apply.careers.microsoft.com/careers/apply?pid=1970393556977375")
        self.assertNotEqual(first[2], second[2])

    def test_other_platforms_are_unaffected(self):
        self.assertEqual(cd.parse_posting("https://jobs.ashbyhq.com/acme/4f3c2b1a-0000-1111-2222-333344445555")[0], "ashby")
        self.assertEqual(cd.parse_posting("https://jobs.lever.co/acme/4f3c2b1a-0000-1111-2222-333344445555")[0], "lever")

    def test_a_url_it_cannot_read_says_so(self):
        # The parser's contract: (None, None, None) rather than a guess. A guess here is a duplicate.
        self.assertEqual(cd.parse_posting("https://example.com/careers/12345"), (None, None, None))


if __name__ == "__main__":
    unittest.main()
