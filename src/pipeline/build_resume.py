#!/usr/bin/env python3
"""build_resume.py - render the resume view of application_profile.json onto the project template.

LIBRARY ONLY. The single script that generates a resume is src/pipeline/generate_tailored_resume.py, which calls
build() here. Anything else that writes a resume DOCX is a duplicate.

Replaces the previous markdown-driven builder and is the layout the user signed off on:

  * header centred, name only
  * section headings with a grey rule under them
  * dates right-aligned on every role and project line
  * bullets with the template's own 20.1 / -8.7pt hanging indent
  * blocks separated by 13pt
  * EDUCATION in the previous template's two-line, four-field style
  * Times New Roman 22 / 14 / 11, single spacing - read off the template, not invented

Content comes from data/application_profile.json (see load_master below). A --profile may override the summary (and
the project order) for one application; everything else stays as written.

Usage:
    python3 src/pipeline/build_resume.py [--profile p.json] [--output out.docx] [--pdf-output out.pdf]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from summary_guard import assert_summary_fits

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

APPLICATION_PROFILE = DATA_DIR / 'application_profile.json'
TEMPLATE = DATA_DIR / 'resume_templates/Example_Candidate_Backend_Resume.docx'
SERIF = 'Times New Roman'
BLOCK_GAP = Pt(10)


BOLD_MARKUP = re.compile(r"\*\*(.+?)\*\*")


def add_rich(paragraph, text: str):
    """Render `**bold**` inside the source text. The markdown-driven builder did this; the JSON one did not, so the
    literal asterisks were printing in the PDF ("**cutting production failures by 30%**")."""
    pos = 0
    for m in BOLD_MARKUP.finditer(text):
        if m.start() > pos:
            paragraph.add_run(text[pos:m.start()])
        paragraph.add_run(m.group(1)).bold = True
        pos = m.end()
    if pos < len(text):
        paragraph.add_run(text[pos:])
    for r in paragraph.runs:
        r.font.name = SERIF
    return paragraph

def load_master(path: pathlib.Path | None = None) -> dict:
    """Build the resume view out of application_profile.json - the single source of truth.

    A --profile may override summary / skills / projects / bullets per JD. Nothing about the layout is overridable, so
    a tailored resume can say different things but can never look different.
    """
    ap = json.loads((path or APPLICATION_PROFILE).read_text(encoding='utf-8'))
    resume = ap.get('resume', {})
    cand = ap.get('candidate', {})
    education = []
    for e in ap.get('education', []):
        education.append({
            'school': e.get('school', ''),
            'location': e.get('resume_location', ''),
            'degree': e.get('resume_degree', e.get('degree', '')),
            'date': e.get('resume_date', ''),
        })
    return {
        'name': cand.get('name', ''),
        'contact': cand.get('resume_contact_lines', []),
        'summary': resume.get('summary', ''),
        'skills': resume.get('skills', []),
        'experience': [
            {'title': e.get('resume_title', e.get('job_title', '')),
             'dates': e.get('resume_dates', ''),
             'location': e.get('location', ''),
             'bullets': e.get('resume_bullets', [])}
            for e in ap.get('work_experience', [])
        ],
        'projects': resume.get('projects', []),
        'education': education,
    }


def apply_overrides(master: dict, profile: dict | None) -> dict:
    """Per-JD customisation: the SUMMARY may change, the record may not.

    What the user asked for is a resume that can be angled at a job without any chance of a second, older version of the
    facts appearing. So the work-experience descriptions are NOT overridable - the 1,301 stored profiles used to carry
    their own `resume_bullets` (40 of them still do), and honouring those would print the older, thinner descriptions
    the user has just had rewritten. Skills are accepted in either shape because the stored profiles hold them as a
    {label: value} dict while this module builds a list.
    """
    if not profile:
        return master
    out = dict(master)
    if profile.get('summary'):
        out['summary'] = profile['summary']
    skills = profile.get('skills')
    if isinstance(skills, dict):
        out['skills'] = [{'label': k, 'value': v} for k, v in skills.items()]
    elif isinstance(skills, list) and skills and isinstance(skills[0], dict):
        out['skills'] = skills
    if profile.get('projects'):
        out['projects'] = profile['projects']
    return out


def rule_under(paragraph) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '2')
    bottom.set(qn('w:color'), '808080')
    borders.append(bottom)
    pPr.append(borders)


def build(master: dict, profile: dict | None) -> Document:
    # THE MASTER RESUME IS THE USER'S OWN FILE AND DOES NOT SHIP, so this is the first thing a new checkout
    # meets. Without this check the failure came out as
    # `docx.opc.exceptions.PackageNotFoundError: Package not found at '...'` from six frames inside python-docx,
    # which names neither what the file is for nor what to do. Note WHICH path is opened: the module constant
    # below, not the role profile's `template_docx` - `generate_tailored_resume` existence-checks that one, so a
    # profile naming a different template passes its check and then fails here. That is documented current
    # behaviour (docs/CONFIGURATION.md), and the message says where the file it really opens has to be.
    if not TEMPLATE.is_file():
        raise SystemExit(
            f"Master resume template not found: {TEMPLATE}\n"
            "This repository ships no resume: that path is where YOUR master .docx goes. Put your own resume "
            "there under the name build_resume.TEMPLATE expects (or edit that constant), then re-run "
            "src/pipeline/generate_tailored_resume.py."
        )
    doc = Document(str(TEMPLATE))
    body = doc.element.body
    for child in list(body):
        if not child.tag.endswith('}sectPr'):
            body.remove(child)

    sec = doc.sections[0]
    sec.top_margin = sec.bottom_margin = Inches(0.45)
    width = Emu(sec.page_width - sec.left_margin - sec.right_margin).inches

    normal = doc.styles['Normal']
    normal.font.name = SERIF
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(1)
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    for style_name, size in (('ResumeName', 22), ('SectionHead', 14)):
        try:
            doc.styles[style_name].font.name = SERIF
            doc.styles[style_name].font.size = Pt(size)
        except KeyError:
            pass

    def heading(text: str, break_before: bool = False):
        p = doc.add_paragraph(text.upper(), style='SectionHead')
        p.paragraph_format.space_before = Pt(10)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        p.paragraph_format.page_break_before = break_before
        rule_under(p)
        return p

    def two_column(left: str, right: str, *, left_bold=False, right_bold=False, right_italic=False,
                   space_after=Pt(1), space_before=Pt(0)):
        p = doc.add_paragraph()
        p.paragraph_format.tab_stops.add_tab_stop(Inches(width), WD_TAB_ALIGNMENT.RIGHT)
        p.paragraph_format.space_before = space_before
        p.paragraph_format.space_after = space_after
        a = p.add_run(left)
        a.bold = left_bold
        p.add_run('\t')
        b = p.add_run(right)
        b.bold = right_bold
        b.italic = right_italic
        for r in p.runs:
            r.font.name = SERIF
        return p

    def bullet(text: str):
        p = doc.add_paragraph('• ')
        add_rich(p, text)
        pf = p.paragraph_format
        pf.left_indent = Pt(20.1)
        pf.first_line_indent = Pt(-8.7)
        pf.space_after = Pt(1.2)
        for r in p.runs:
            r.font.name = SERIF
        return p

    def plain(text: str):
        p = doc.add_paragraph()
        add_rich(p, text)
        p.paragraph_format.space_after = Pt(1)
        return p

    # Header - centred, name only.
    name = doc.add_paragraph(master['name'], style='ResumeName')
    name.alignment = WD_ALIGN_PARAGRAPH.CENTER
    name.paragraph_format.space_after = Pt(3)
    for line in master['contact']:
        c = plain(line)
        c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        c.paragraph_format.space_after = Pt(2)

    heading('Summary')
    summary = (profile or {}).get('summary') or master['summary']
    plain(summary)

    if master.get('skills'):
        heading('Core Skills')
        for skill in master['skills']:
            p = doc.add_paragraph()
            p.add_run(skill['label']).bold = True
            p.add_run(' ' + skill['value'])
            p.paragraph_format.space_after = Pt(0.3)
            for r in p.runs:
                r.font.name = SERIF

    if master.get('experience'):
        heading('Work Experience')
        for block in master['experience']:
            two_column(block['title'], block['dates'], left_bold=True, right_bold=True,
                       space_before=BLOCK_GAP, space_after=Pt(1)).paragraph_format.keep_with_next = True
            if block.get('location'):
                # THE LOCATION LINE. The previous template carried one under every role (italic, left aligned) and the
                # new layout dropped it, leaving the city only inside the company name. Restored to match.
                loc = doc.add_paragraph()
                r = loc.add_run(block['location'])
                r.italic = True
                r.font.name = SERIF
                loc.paragraph_format.space_after = Pt(1)
                loc.paragraph_format.keep_with_next = True
            for b in block['bullets']:
                bullet(b)

    if master.get('projects'):
        # No forced page break: keep_with_next keeps the heading with its first block, and a hard break here
        # stranded most of a page whenever the work section ended early.
        heading('Project Experience')
        for block in master['projects']:
            two_column(block['title'], block['dates'], left_bold=True, right_bold=True,
                       space_before=BLOCK_GAP, space_after=Pt(1)).paragraph_format.keep_with_next = True
            if block.get('description'):
                plain(block['description'])
            if block.get('stack'):
                p = doc.add_paragraph()
                p.add_run('Stack: ').bold = True
                add_rich(p, block['stack'])
                p.paragraph_format.space_after = Pt(1)
                for r in p.runs:
                    r.font.name = SERIF
            for b in block['bullets']:
                bullet(b)

    if master.get('education'):
        heading('Education')
        for entry in master['education']:
            two_column(entry['school'], entry['location'], left_bold=True, right_italic=True).paragraph_format.keep_with_next = True
            two_column(entry['degree'], entry['date'], right_bold=True, space_after=Pt(7))

    return doc


if __name__ == "__main__":
    raise SystemExit(
        "build_resume.py is a library. The one script that generates a resume is\n"
        "src/pipeline/generate_tailored_resume.py - use that."
    )
