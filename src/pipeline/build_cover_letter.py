#!/usr/bin/env python3
"""Build a one-page cover-letter DOCX (and PDF) from profile facts plus a body file.

Usage:
  build_cover_letter.py --company "Snowflake" --role "Senior/Staff Forward Deployed Engineer, Applied AI" \
      --body /path/to/body.txt --slug snowflake_senior_staff_forward_deployed_engineer_applied_ai

The body file holds the letter paragraphs (blank-line separated). Contact details come from
data/application_profile.json, so no personal facts are ever invented here. Output:
  output/docx/<stem>.docx and output/pdf/<stem>.pdf where stem follows the resume naming used
  elsewhere in the repo - "<Name>_<Company>_<Role>_Cover_Letter", with <Name> read from the
  profile rather than written here, so the letter and the resume cannot be named for two
  different candidates. "Follows the resume naming" is asserted, not hoped for: the company and the
  role go through the resume's own `slugify`, and the name through a tokenizer that keeps every letter
  of it - see `letter_stem`, and test_build_cover_letter.py, which compares the two stems the two
  builders produce for the same application.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "pipeline"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from resume_artifacts import export_and_validate_pdf  # noqa: E402
from generate_tailored_resume import slugify  # noqa: E402  (the resume's own stem builder, one definition)
from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

DOCX_DIR = ROOT / "output" / "docx"
PDF_DIR = ROOT / "output" / "pdf"


def load_profile() -> dict:
    return json.loads((DATA_DIR / "application_profile.json").read_text(encoding="utf-8"))


def letter_stem(name: str, company: str, role: str) -> str:
    # THE NAME IS A PARAMETER, NOT A LITERAL. It used to be the string "Example_Candidate", which meant the cover
    # letter and the resume generated for the same application had different stems - so the file names disagreed about
    # who the candidate was, and a rename of the canonical name would not have reached here.
    #
    # AND THE STEM HAS TO BE THE RESUME'S STEM. One application, two files, and a filer matches them by name; the
    # resume's stem comes from `slugify` in src/pipeline/generate_tailored_resume.py, so both halves of this name are
    # read from that side rather than re-invented here. The name is the person's own capitalisation; the company and the
    # role are slugified exactly as the resume slugifies them, which is why this module no longer camel-capitalises
    # them: that capitalisation made "Électricité de France" name the letter `..._De_France_...` and the resume
    # `..._de_France_...`, and "Toronto General Hospital" survived only because every word in it starts with a capital.
    return f"{_name_part(name)}_{slugify(company)}_{slugify(role)}_Cover_Letter"


def _name_part(name: str) -> str:
    """The candidate's name, as a filename part that a filer can still recognise as that name.

    `re.findall(r"[A-Za-z0-9]+")` - the original - is not a sanitizer but an ASCII filter: `Łukasz Żółkiewski` came
    out `Ukasz_Kiewski`, two words the person is not called with the letters that make the name his removed, and a
    name in Chinese came out as nothing at all. `\\w` is the same pass with the unicode-aware letters kept, and what it
    drops is what a filename must not carry: path separators, `.`, and the reserved punctuation. Each word keeps the
    person's own capitalisation, so `ClickHouse` and `SQL` survive as typed - the same thing `slugify` does to the
    name when the resume is built, which is what makes the two stems equal for every name this project has seen.
    """
    return "_".join(re.findall(r"\w+", name))


def contact_value(candidate: dict, *keys: str) -> str:
    """The first of `keys` the profile answers, as a string; `""` when it answers none of them.

    AN ABSENT OPTIONAL KEY AND AN EMPTY ONE MEAN THE SAME THING. `candidate['github']` was read with a subscript, so a
    profile without a GitHub account - the normal state for most people - stopped the letter with
    `AttributeError`/`KeyError: 'github'` before a single sentence was rendered. Everywhere else in this project the
    two states are folded together the same way (`IDENTITY` in src/forms/ashby_finish_form.mjs, `greenhouse_scaffold` in
    the pipeline): ask for the value, get `""`, and drop the segment rather than the run.
    """
    if not isinstance(candidate, dict):
        return ""
    for key in keys:
        value = candidate.get(key)
        if value:
            return str(value)
    return ""


def _contact_line(*parts) -> str:
    """One line of the letter's header, made of the parts this person actually has.

    A missing part drops its segment instead of leaving `Toronto, Ontario |  | 416...` behind: the separator is a
    claim that something follows it, and the header is the first thing a reader sees.
    """
    return " | ".join(str(part).strip() for part in parts if str(part or "").strip())


def contact_lines(candidate: dict) -> list[str]:
    """The letter's header lines, built from the contact facts this profile holds and no others.

    THIS IS A FUNCTION BECAUSE THE HEADER IS WHERE THE ABSENT-KEY DEFECT SHOWED. `candidate['github']` was read with a
    subscript into the second line, so a person with no GitHub account - or no GitHub key, which is the same fact
    written differently - lost the whole letter to an exception. Reading every part through `contact_value` and joining
    only the parts that are really there means the same code covers the account-less profile, the empty-string profile
    and the ordinary one.
    """
    address = candidate.get("address") or {}
    phone = candidate.get("phone")
    location = ", ".join(part for part in (address.get("city"), address.get("state")) if part)
    return [line for line in (
        _contact_line(location, contact_value(candidate, "email"),
                      (phone.get("formatted") if isinstance(phone, dict) else phone) or ""),
        _contact_line(contact_value(candidate, "linkedin"),
                      contact_value(candidate, "github").replace("https://", "")),
    ) if line]


def build_docx(path: Path, name: str, contact_lines: list[str], paragraphs: list[str], company: str, role: str) -> None:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    document = Document()
    style = document.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)
    for section in document.sections:
        section.top_margin = Pt(54)
        section.bottom_margin = Pt(54)
        section.left_margin = Pt(72)
        section.right_margin = Pt(72)

    header = document.add_paragraph()
    header.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = header.add_run(name)
    run.bold = True
    run.font.size = Pt(16)
    for line in contact_lines:
        paragraph = document.add_paragraph(line)
        paragraph.paragraph_format.space_after = Pt(0)

    document.add_paragraph("")
    document.add_paragraph(date.today().strftime("%B %-d, %Y"))
    document.add_paragraph("")
    document.add_paragraph("Hiring Team")
    document.add_paragraph(company)
    document.add_paragraph(f"Re: {role}")
    document.add_paragraph("")
    document.add_paragraph("Dear Hiring Manager,")
    for text in paragraphs:
        document.add_paragraph(text)
    document.add_paragraph("Thank you for your time and consideration.")
    document.add_paragraph("")
    document.add_paragraph("Sincerely,")
    document.add_paragraph(name)

    path.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(path))


def render_body(company: str, role: str) -> str:
    """The letter body, rendered from data/cover_letter/template.txt by name from the two profiles.

    Both guards live in cover_letter_template: an unresolved placeholder is an error rather than a hole in a
    letter, and the rendered text is checked against do_not_claim - through the pipeline's own bounded matcher,
    so a confirmed `JavaScript` is not read as a claim about `Java`. Extracted from `main` so that
    `prepare --cover-letter` renders the SAME wording the interactive builder renders.
    """
    from cover_letter_template import TemplateError, build_context, check_no_banned_terms, render

    # `profile` is the APPLICATION profile (contact block, education, history). The template also needs the
    # CANDIDATE profile - the confirmed skills, the approved metrics and the do_not_claim list all live there -
    # so it is read as its own file rather than assumed to be the same shape.
    cand_profile = json.loads((DATA_DIR / "candidate_profile.json").read_text(encoding="utf-8"))
    tmpl = (DATA_DIR / "cover_letter" / "template.txt").read_text(encoding="utf-8")
    ctx = build_context(cand_profile, load_profile(), company, role)
    try:
        body = render(tmpl, ctx)
        check_no_banned_terms(body, cand_profile.get("do_not_claim"))
    except TemplateError as exc:
        raise SystemExit(f"cover letter template refused: {exc}") from exc
    return body


def paragraphs_of(body: str) -> list[str]:
    """The letter's paragraphs: the body split on blank lines, each block re-flowed onto one line."""
    return [block.strip().replace("\n", " ") for block in re.split(r"\n\s*\n", body) if block.strip()]


def assemble_letter(company: str, role: str, body: str, stem: str | None = None) -> tuple[Path, str]:
    """One application's letter as a DOCX on disk; returns (docx_path, candidate_name).

    The name, the contact block and the paragraph flow are the same for the interactive builder and for
    `prepare --cover-letter`, which is why both call this: two copies of the letter's header is how a letter
    and a resume come to be named for two different candidates.

    THE CONTACT BLOCK IS BUILT FROM WHAT THIS PERSON HAS - see `contact_lines`. It used to name
    `candidate['linkedin']` and `candidate['github']` outright, so a profile without a GitHub account stopped
    the run, and a profile with an empty LinkedIn printed a line whose second half was a bare separator.
    """
    profile = load_profile()
    candidate = profile["candidate"]
    full_name = candidate.get("name") or f"{candidate.get('first_name', '')} {candidate.get('last_name', '')}".strip()
    header_lines = contact_lines(candidate)
    paragraphs = paragraphs_of(body)
    if not paragraphs:
        raise SystemExit("body file produced no paragraphs")
    stem = stem or letter_stem(full_name, company, role)
    docx_path = DOCX_DIR / f"{stem}.docx"
    build_docx(docx_path, full_name, header_lines, paragraphs, company, role)
    return docx_path, full_name


def build_letter_pdf(company: str, role: str) -> Path:
    """The cover letter one `prepare --cover-letter` run produces, and the path it returns.

    The README's walk attaches `output/pdf/<...>_Cover_Letter.pdf` in the drafter step; this function is what
    produces that file, named with the resume's own stem convention (letter_stem, asserted by
    test_build_cover_letter.py) and validated by the same PDF QA the resume goes through. The DOCX is written
    beside it under output/docx, as the interactive builder writes it.
    """
    docx_path, _name = assemble_letter(company, role, render_body(company, role))
    pdf_path, _report = export_and_validate_pdf(
        docx_path,
        pdf_path=PDF_DIR / f"{docx_path.stem}.pdf",
        expected_terms=[company],
    )
    return pdf_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a cover letter DOCX/PDF from profile facts")
    parser.add_argument("--company", required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--body", help="Text file with the letter body. Omit to render the template in\n                        data/cover_letter/template.txt from canonical facts - which refuses to leave a\n                        placeholder unresolved, or to state anything in do_not_claim.")
    parser.add_argument("--stem", help="Override the output file stem")
    parser.add_argument("--no-pdf", action="store_true", help="Only write the DOCX")
    args = parser.parse_args()

    if args.body:
        body = Path(args.body).read_text(encoding="utf-8")
    else:
        body = render_body(args.company, args.role)

    docx_path, _name = assemble_letter(args.company, args.role, body, args.stem)
    print(f"docx: {docx_path}")

    if not args.no_pdf:
        pdf_path, report = export_and_validate_pdf(
            docx_path,
            pdf_path=PDF_DIR / f"{docx_path.stem}.pdf",
            expected_terms=[args.company],
        )
        print(f"pdf:  {pdf_path} (pages={report.get('page_count')}, ok={report.get('ok')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
