#!/usr/bin/env python3
"""The resolver asks for what it needs instead of telling the person to install it by hand.

WHAT PAID FOR THIS. `find_soffice` raised a message naming two install commands, and `prepare` stopped
there - on a fresh machine the ONLY blocker the toolkit could have removed on its own. The download
itself is not what a unit test runs; what is tested is the decision and the two outcomes around it.
"""
from __future__ import annotations

import io
import os
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src" / "pipeline"))

import render_docx


def _fake_installer(stdout: str = "", returncode: int = 0, order: list | None = None):
    """A `Popen` RESULT stand-in whose stdout is already written and whose `wait` records when it is asked.

    `order` records the call sequence ("relay" per chunk the caller passes through, then "wait"), which is how
    the test proves the relay happens BEFORE the run is over rather than after capture. (Patched as the return
    value of `Popen`, so it is an instance, not the callable itself.)
    """

    class FakeInstaller:
        def __init__(self):
            self.stdout = io.StringIO(stdout)

        def wait(self):
            if order is not None:
                order.append("wait")
            return returncode

    return FakeInstaller()


class SofficeResolutionTest(unittest.TestCase):
    def test_the_project_local_copy_is_among_the_candidates(self):
        paths = [str(p) for p in render_docx.candidate_soffice_paths()]
        self.assertTrue(any("cache" in p and "libreoffice" in p and p.endswith("soffice") for p in paths),
                        "the installer's target is not a candidate the resolver would use")

    def test_the_escape_hatch_turns_the_download_off(self):
        with mock.patch.dict(os.environ, {"ATS_NO_SOFFICE_DOWNLOAD": "1"}):
            self.assertFalse(render_docx.auto_download_allowed())

    def test_an_existing_candidate_is_returned_without_downloading(self):
        # Point the override at any file that exists; the resolver must take it and never consult the installer.
        with mock.patch.dict(os.environ, {"SOFFICE_PATH": "/bin/ls"}), \
                mock.patch("render_docx.subprocess.Popen") as popen:
            self.assertEqual(render_docx.find_soffice(), "/bin/ls")
            popen.assert_not_called()

    def test_a_missing_binary_runs_the_installer_and_uses_its_result(self):
        # The download branch, without the download: the first candidate pass finds nothing, the installer
        # "succeeds", and the second pass finds the installed copy. The installer is invoked with its real
        # path - a wrong path here is a broken resolve nobody would notice until a real download.
        target = pathlib.Path("/tmp/soffice-test-target")
        target.write_text("")
        try:
            calls = {"paths": 0}
            real_candidates = render_docx.candidate_soffice_paths

            def staged_candidates():
                calls["paths"] += 1
                return [] if calls["paths"] == 1 else [target]

            with mock.patch("render_docx.candidate_soffice_paths", side_effect=staged_candidates), \
                    mock.patch("render_docx.subprocess.Popen") as popen, \
                    mock.patch.object(render_docx.sys, "stdout", io.StringIO()), \
                    mock.patch("render_docx.sys.platform", "darwin"):
                proc = mock.Mock()
                proc.stdout = io.StringIO("")
                proc.wait.return_value = 0
                popen.return_value = proc
                self.assertEqual(render_docx.find_soffice(), str(target))
                installer = popen.call_args[0][0][-1]
                self.assertIn("install_libreoffice.sh", installer,
                              "the download ran something other than the project's own installer")
        finally:
            target.unlink(missing_ok=True)

    def test_the_announcement_precedes_the_installer_and_its_output_is_relayed_not_buffered(self):
        # Cold-start smoke test, 2026-10-14: the resolver's announcement ("LibreOffice was not found -
        # downloading...") never reached the user and neither did the installer's progress, so a first
        # `prepare` sat ~30 seconds downloading ~285 MiB with nothing on screen. Both were captured by
        # subprocess.run(capture_output=True) and shown only on failure. The contract now is: the announcement
        # is on the stream BEFORE the installer starts, and the installer's own lines appear AS THEY ARRIVE -
        # the relay must happen before the wait, or the ~30 s pause is unexplained in real time.
        target = pathlib.Path("/tmp/soffice-test-target")
        target.write_text("")
        try:
            calls = {"paths": 0}
            real_candidates = render_docx.candidate_soffice_paths

            def staged_candidates():
                calls["paths"] += 1
                return [] if calls["paths"] == 1 else [target]

            order: list[str] = []

            class Relay:
                def __init__(self):
                    self.parts: list[str] = []

                def write(self, text):
                    self.parts.append(text)
                    order.append("relay")

                def flush(self):
                    pass

            relay = Relay()
            installer_output = "downloading https://download.documentfoundation.org/...\n[########  ] 45%\n"
            with mock.patch("render_docx.candidate_soffice_paths", side_effect=staged_candidates), \
                    mock.patch("render_docx.subprocess.Popen", return_value=_fake_installer(stdout=installer_output,
                                                                                            order=order)), \
                    mock.patch.object(render_docx.sys, "stdout", relay), \
                    mock.patch("render_docx.sys.platform", "darwin"):
                self.assertEqual(render_docx.find_soffice(), str(target))

            streamed = "".join(relay.parts)
            self.assertIn("LibreOffice was not found - downloading", streamed,
                          "the resolver's announcement reaches the caller before the download wait")
            self.assertIn("downloading https://", streamed,
                          "the installer's own output must be relayed to the caller, not captured until the end")
            self.assertIn("[########  ] 45%", streamed, "curl's progress updates are relayed as they arrive")
            self.assertLess(order.index("relay"), order.index("wait"),
                            "the relay happens BEFORE the run finishes - afterwards is the ~30s silence again")
        finally:
            target.unlink(missing_ok=True)

    def test_a_failed_download_still_reports_the_installers_tail(self):
        # The failure half of the same finding: whatever was gained by streaming, the reason a download failed
        # must stay in the reported line, not only on the stream.
        buffer = io.StringIO()
        with mock.patch.object(render_docx.sys, "stdout", buffer), \
                mock.patch("render_docx.candidate_soffice_paths", return_value=[]), \
                mock.patch("render_docx.subprocess.Popen",
                           return_value=_fake_installer(
                               stdout="curl: (22) The requested URL returned error: 404\n", returncode=22)), \
                mock.patch("render_docx.sys.platform", "darwin"):
            with self.assertRaises(SystemExit):
                render_docx.find_soffice()
        self.assertIn("curl: (22)", buffer.getvalue(),
                      "the installer's tail is attached to the failure report, not only relayed past")


if __name__ == "__main__":
    unittest.main()
