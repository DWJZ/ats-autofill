#!/usr/bin/env python3
"""Write a master resume DOCX that the renderer can patch.

WHY THIS EXISTS. The resume pipeline is template-driven and the template is yours: no `.docx` ships
with this repository, because the one it was built against is somebody's actual resume. That left a
gap for a new checkout - `prepare` stops with `Template not found: <path>`, and the only way forward
was to reverse-engineer which named styles the renderer needs. This writes a scaffold with exactly
those, so the first run has something to open.

WHAT THE RENDERER ACTUALLY READS OUT OF A MASTER, because it is less than people expect:

  * the PAGE SETUP - `page_width` and the left/right margins decide the width of the right-aligned
    tab stop that every two-column line (job title, dates) uses. `src/pipeline/build_resume.py`
    overwrites the top and bottom margins itself, so those do not matter;
  * THREE NAMED PARAGRAPH STYLES - `ResumeName` for the name line, `SectionHead` for section
    headings, `Normal` for everything else. The renderer sets the font on each one and then writes
    the document with them, so a master missing either named style fails at the first heading;
  * NOTHING ELSE. The body is deleted and rebuilt from `application_profile.json` on every run -
    `build_resume.py` keeps only the final `sectPr` element and drops every other child. The text
    below is therefore a placeholder: edit the styles and the page setup to make the resume look the
    way you want, and edit nothing here to change what it says.

Usage:
  .venv/bin/python3 src/pipeline/make_master_resume.py                       # writes the default path
  .venv/bin/python3 src/pipeline/make_master_resume.py --name "Your Name"
  .venv/bin/python3 src/pipeline/make_master_resume.py --out data/resume_templates/my_master.docx

Through the virtualenv, not bare `python3`: python-docx is a project dependency and lives in `.venv`
(requirements.txt), so `python3 src/pipeline/make_master_resume.py` stops on `No module named 'docx'`.
The check below says so, because this is the first command a new checkout is told to run and the
traceback it used to print named the symptom rather than the fix.

Then point the toolkit at it: `resume_tracks.<track>.template_docx` in `data/candidate_profile.json`,
or `--template` on `generate_tailored_resume.py` for one run. See docs/CONFIGURATION.md.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

if str(Path(__file__).resolve().parents[2]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

try:
    from docx import Document                                    # noqa: E402
    from docx.enum.text import WD_ALIGN_PARAGRAPH                # noqa: E402
    from docx.shared import Inches, Pt                           # noqa: E402
except ImportError as exc:  # pragma: no cover - environment problem, not logic
    # The reason this guard exists is in the docstring: this file is the ONE command a fresh checkout
    # is told to run to get a master resume, and running it as `python3 …` (which the docs used to say)
    # failed with `No module named 'docx'` and nothing about the virtualenv that holds it. Same shape as
    # the environment guards in render_docx.py, resume_artifacts.py and job_app_assistant.py: name the
    # interpreter and the command that creates it, then exit non-zero.
    raise SystemExit(
        "python-docx is required to write the master resume, and it is installed in this project's\n"
        "virtualenv rather than in the system Python. Run this through the virtualenv:\n"
        "  .venv/bin/python3 src/pipeline/make_master_resume.py\n"
        "and create the virtualenv first if it does not exist:\n"
        "  python3 -m venv .venv && .venv/bin/python3 -m pip install -r requirements.txt"
    ) from exc


from src.pipeline import build_resume                         # noqa: E402

#: The styles the renderer writes with. The font is set on each by `build_resume.py`, so only the
#: style's existence and its paragraph-level character are set here.
NAME_STYLE = "ResumeName"
HEADING_STYLE = "SectionHead"

#: WHERE THE RENDERER ACTUALLY OPENS THE MASTER, not a path guessed here. `build_resume.py` opens a
#: module constant while `generate_tailored_resume.py` checks the profile's `template_docx`, so the
#: two can disagree and the constant is the one that wins at render time. Reading it means this
#: scaffold always lands where the renderer looks, even if that constant is renamed.
DEFAULT_OUT = build_resume.TEMPLATE

#: Sensible page geometry for a one-page resume. The renderer keeps the width and overrides the
#: vertical margins, so left/right are the ones worth changing here.
PAGE_MARGIN_X = Inches(0.6)
PAGE_MARGIN_Y = Inches(0.45)


def make_master(name: str = "YOUR NAME") -> Document:
    """A Word document with the three named styles and nothing the renderer will keep."""
    doc = Document()

    section = doc.sections[0]
    section.top_margin = section.bottom_margin = PAGE_MARGIN_Y
    section.left_margin = section.right_margin = PAGE_MARGIN_X

    normal = doc.styles["Normal"]
    normal.font.size = Pt(11)

    # `add_style` raises if the name is taken; a fresh Document has neither, but a user re-running
    # this over an existing file should get a clear message rather than a traceback from inside
    # python-docx, and re-creating it is the caller's decision, not this module's.
    for style_name, size, bold in ((NAME_STYLE, 22, True), (HEADING_STYLE, 14, True)):
        style = doc.styles.add_style(style_name, 1)          # 1 == WD_STYLE_TYPE.PARAGRAPH
        style.base_style = doc.styles["Normal"]
        style.font.size = Pt(size)
        style.font.bold = bold

    # A body that demonstrates the styles. Every paragraph below is discarded on the first render.
    name_paragraph = doc.add_paragraph(name.upper(), style=NAME_STYLE)
    name_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

    doc.add_paragraph("SUMMARY", style=HEADING_STYLE)
    doc.add_paragraph(
        "This text is a placeholder. The renderer deletes everything in this document except the "
        "styles and the page setup, then rebuilds the resume from application_profile.json - so what "
        "you edit here to change the LOOK is the style definitions, not these words."
    )

    doc.add_paragraph("EXPERIENCE", style=HEADING_STYLE)
    doc.add_paragraph("Job Title\tMonth Year - Month Year").add_run("  <- a right-aligned tab stop")
    doc.add_paragraph("An employer line, a project line, a bullet - all rebuilt from your profile.")

    return doc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"where to write the master (default: {DEFAULT_OUT})")
    parser.add_argument("--name", default="YOUR NAME",
                        help="the name line, shown only as a placeholder in this scaffold")
    parser.add_argument("--force", action="store_true",
                        help="overwrite an existing file at that path")
    args = parser.parse_args(argv)

    out = Path(args.out)
    if out.exists() and not args.force:
        print(f"refusing to overwrite {out} - pass --force to replace it", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    make_master(args.name).save(out)

    print(f"wrote {out}")
    print(f"  styles it defines: {NAME_STYLE}, {HEADING_STYLE}, and the built-in Normal")
    print("  next: point your profile at it - resume_tracks.<track>.template_docx in "
          "data/candidate_profile.json")
    print("  and read `The master resume DOCX` in docs/CONFIGURATION.md for what the renderer keeps")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
