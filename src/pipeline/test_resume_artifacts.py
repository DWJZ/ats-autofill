#!/usr/bin/env python3
"""The renderer's output reaches the caller as it happens, not when the run is over.

WHAT PAID FOR THIS. `export_and_validate_pdf` ran the renderer with `subprocess.run(capture_output=True)`, so a
first `prepare` on a machine with no LibreOffice sat ~30 seconds downloading ~285 MiB with nothing on screen:
the resolver's announcement ("LibreOffice was not found - downloading...") and the installer's progress were
both captured by the parent and shown only on failure - which is exactly when the person already knew something
was wrong (cold-start smoke test, 2026-10-14). The relay is tested here without a real download: the child's
output is a fake stream, and what is asserted is WHEN each line reaches the caller and that a failed run still
reports its tail.
"""
from __future__ import annotations

import io
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src" / "pipeline"))

import resume_artifacts


class _FakeRenderer:
    """A `Popen` RESULT stand-in whose stdout holds the child's whole output.

    `order` records "relay" for every chunk the caller passes through and "wait" when it waits - the sequence
    that proves the relay happens BEFORE the run is over rather than after capture. (Patched as the return
    value of `Popen`, so it is an instance, not the callable itself.)
    """

    def __init__(self, stdout: str = "", returncode: int = 0, order: list | None = None):
        self.stdout = io.StringIO(stdout)
        self.returncode = returncode
        self.order = order

    def wait(self):
        if self.order is not None:
            self.order.append("wait")
        return self.returncode


class RendererOutputIsRelayedTest(unittest.TestCase):
    def test_the_childs_output_reaches_the_caller_before_the_run_finishes(self):
        # The finding's minimum: the announcement explains the ~30 s pause IN REAL TIME. It is the renderer
        # child's first line here, exactly where the real one prints it - before the installer runs.
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
        child_output = ("LibreOffice was not found - downloading the project-local copy into .cache/ "
                        "(about 300 MB, cached, one time). Set ATS_NO_SOFFICE_DOWNLOAD=1 to skip this.\n"
                        "rendered 2 page(s) -> /tmp/render\n")
        with mock.patch("resume_artifacts.subprocess.Popen",
                        return_value=_FakeRenderer(stdout=child_output, order=order)):
            completed = resume_artifacts._run_renderer_relayed(["python3", "render_docx.py"], out=relay)

        self.assertEqual(completed.returncode, 0)
        self.assertIn("LibreOffice was not found - downloading", "".join(relay.parts),
                      "the resolver's announcement is part of what the caller must see")
        self.assertIn("rendered 2 page(s)", "".join(relay.parts),
                      "the renderer's own success line is relayed too, not only the announcement")
        self.assertLess(order.index("relay"), order.index("wait"),
                        "the relay happens BEFORE the run finishes - afterwards is the silent 30 s again")
        self.assertEqual(completed.stdout, child_output,
                         "the whole output is still kept, for the failure message to quote")

    def test_a_failed_render_still_reports_the_childs_tail(self):
        # The failure half of the same change: whatever is gained by streaming, a failed run must still raise
        # with the child's tail in the message - the capture-then-report behaviour that already existed. The
        # relay itself is directed at a buffer here, so the suite's own log stays clean.
        with tempfile.TemporaryDirectory() as tmp:
            docx = pathlib.Path(tmp) / "resume.docx"
            docx.write_bytes(b"PK")
            render_dir = pathlib.Path(tmp) / "render"
            tail = "LibreOffice conversion failed for resume.docx: Error: source file could not be loaded"
            with mock.patch("resume_artifacts.subprocess.Popen",
                            return_value=_FakeRenderer(stdout=f"some progress line\n{tail}\n", returncode=1)), \
                    mock.patch.object(resume_artifacts.sys, "stdout", io.StringIO()):
                with self.assertRaises(RuntimeError) as raised:
                    resume_artifacts.export_and_validate_pdf(
                        docx,
                        pdf_path=pathlib.Path(tmp) / "out.pdf",
                        render_dir=render_dir,
                    )
        self.assertIn("DOCX render failed", str(raised.exception))
        self.assertIn(tail, str(raised.exception), "the reason the render failed is in the raised error")


if __name__ == "__main__":
    unittest.main()
