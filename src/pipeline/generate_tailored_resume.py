#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from copy import deepcopy
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.text.paragraph import Paragraph

from build_resume import APPLICATION_PROFILE, apply_overrides, build as build_resume_doc, load_master
from resume_artifacts import export_and_validate_pdf
from summary_guard import assert_summary_fits


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

OUTPUTS_DIR = ROOT / "output" / "docx"
DEFAULT_TEMPLATE = DATA_DIR / "resume_templates" / "Example_Candidate_Backend_Resume.docx"
APPLICATION_PROFILE = DATA_DIR / "application_profile.json"
CANDIDATE_PROFILE = DATA_DIR / "candidate_profile.json"


def _allowed_phrases() -> list[str]:
    """Sanctioned mentions of do_not_claim terms (see candidate_profile.json). A term stays forbidden except inside
    one of these exact phrases."""
    try:
        return load_json(CANDIDATE_PROFILE).get("do_not_claim_allowed_phrases", [])
    except Exception:
        return []


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def resolve_path(value: str | None, default: Path | None = None) -> Path:
    if not value:
        if default is None:
            raise ValueError("Missing required path")
        return default
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


# THE DEFAULT NAME CARRIES NO JOB ID, AND THAT IS A KNOWN COLLISION.
# This builds `<Name>_<company>_<role>_Resume.docx` (Name read from the profile), which worked until a tenant
# advertised the SAME TITLE twice under different requisitions (2026-10-05): two applications, one profile name, one
# bundle name, and the second overwrote the first's materials. Callers that can pass `--output` should carry the
# requisition id in the filename; this default cannot, because it has no URL to read one from. Do not treat the
# default as safe for two postings with the same title.

def slugify(value: str) -> str:
    return "_".join(part for part in "".join(c if c.isalnum() else " " for c in value).split() if part)


def build_workday_payload(role_profile: dict, app_profile: dict) -> dict:
    education = []
    for edu in app_profile.get("education", []):
        if edu.get("field_of_study_workday_preferences"):
            field_preferences = edu["field_of_study_workday_preferences"]
        elif edu.get("field_of_study_workday"):
            field_preferences = [edu["field_of_study_workday"]]
        else:
            field_preferences = []
        education.append(
            {
                "school": edu["school"],
                "degree": edu.get("degree"),
                "from_year": edu.get("start_year"),
                "to_year": edu.get("end_year"),
                "field_preferences": field_preferences,
            }
        )

    experiences = []
    role_experience = role_profile.get("work_experience") or app_profile["work_experience"]
    for exp in role_experience:
        bullets = exp.get("workday_bullets") or exp.get("resume_bullets")
        description = exp.get("description", "")
        if bullets:
            description = "\n".join(f"- {bullet.strip().lstrip('-').strip()}" for bullet in bullets)
        experiences.append(
            {
                "job_title": exp["job_title"],
                "company": exp["company"],
                "location": exp["location"],
                "from": exp["from"],
                "to": exp["to"],
                "description": description,
            }
        )

    linkedin = app_profile.get("candidate", {}).get("linkedin", "")
    if linkedin and not linkedin.startswith("http"):
        linkedin = f"https://www.{linkedin}" if linkedin.startswith("linkedin.com") else f"https://{linkedin}"

    excluded_websites = [
        item["url"] if isinstance(item, dict) else item
        for item in app_profile.get("candidate", {}).get("excluded_websites", [])
    ]

    return {
        "work_experience": experiences,
        "education": education,
        "social_networks": {"linkedin": linkedin},
        "websites": role_profile.get("websites", app_profile.get("candidate", {}).get("websites", [])),
        "excluded_websites": excluded_websites,
    }


def ensure_docx_is_readable(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as docx:
        count = docx.namelist().count("word/document.xml")
        if count != 1:
            raise RuntimeError(f"DOCX should contain one word/document.xml, found {count}")


def generate(role_profile_path: Path, template_path: Path | None = None, output_docx: Path | None = None) -> tuple[Path, dict]:
    role_profile = load_json(role_profile_path)
    app_profile = load_json(APPLICATION_PROFILE)
    template = template_path or resolve_path(role_profile.get("template_docx"), DEFAULT_TEMPLATE)
    if not template.exists():
        raise SystemExit(f"Template not found: {template}")

    company = role_profile["company"]
    role = role_profile["role"]
    # THE CANDIDATE'S NAME COMES FROM THE PROFILE, NOT FROM A LITERAL. It names the output file, the DOCX title and
    # the DOCX author, and all three used to read "Example Candidate" - so a corrected profile would have produced
    # materials still filed under the placeholder, and the name in the document metadata was not the candidate's.
    name = (app_profile.get("candidate") or {}).get("name") or ""
    # parents=True, because `output/` is gitignored and does not exist in a fresh checkout: creating the leaf
    # alone raised FileNotFoundError on `output/docx` for every new user, on the first real run.
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    output_docx = output_docx or OUTPUTS_DIR / f"{slugify(name)}_{slugify(company)}_{slugify(role)}_Resume.docx"
    output_docx = output_docx if output_docx.is_absolute() else ROOT / output_docx
    output_docx.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(template, output_docx)

    # RESUME RENDERING IS PLATFORM-INDEPENDENT (user, 2026-10-07). This used to open a DOCX template and patch its
    # paragraphs in place, which tied the resume to whichever template a role happened to carry. It now renders the
    # master content onto the layout the user signed off on, and the ONLY platform-specific artefact left in this
    # module is the Workday payload below.
    master = apply_overrides(load_master(APPLICATION_PROFILE), role_profile)
    assert_summary_fits(master["summary"])   # first person, and inside the length window for this layout
    doc = build_resume_doc(master, None)
    doc.core_properties.title = f"{name} - {role} Resume"
    # THE SUBJECT IS METADATA ON A DOCUMENT THE EMPLOYER RECEIVES, so it must not name a field the
    # applicant is not in. It said "Tailored software engineering resume for {company}" on every
    # applicant's file - verified present in the metadata of a nurse's rendered resume - which is a
    # claim about a person written where they will never see it. The role is the fact this function
    # already has, and it is the applicant's own.
    doc.core_properties.subject = f"Tailored resume for {company} - {role}"
    doc.core_properties.author = name
    doc.save(output_docx)
    ensure_docx_is_readable(output_docx)

    return output_docx, build_workday_payload(role_profile, app_profile)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a tailored resume by patching a reusable DOCX template.")
    parser.add_argument("--profile", required=True, help="Role tailoring JSON profile.")
    parser.add_argument("--template", help="Optional DOCX template override.")
    parser.add_argument("--output", help="Optional output DOCX path. Defaults to output/docx/<Name>_<company>_<role>_Resume.docx, with <Name> read from the profile.")
    parser.add_argument("--payload-output", help="Optional Workday payload JSON output path.")
    parser.add_argument("--jd-output", help="Optional JD text output path.")
    parser.add_argument("--pdf-output", help="Optional final PDF path. Defaults to output/pdf/<DOCX stem>.pdf.")
    parser.add_argument("--render-dir", help="Optional directory for PDF QA page images and report.")
    parser.add_argument("--docx-only", action="store_true", help="Skip the default Mac PDF export and QA pass.")
    args = parser.parse_args()

    role_profile_path = resolve_path(args.profile)
    role_profile = load_json(role_profile_path)
    output_docx, payload = generate(
        role_profile_path,
        resolve_path(args.template) if args.template else None,
        resolve_path(args.output) if args.output else None,
    )

    if args.payload_output:
        payload_path = resolve_path(args.payload_output)
    else:
        # THE GENERATED PAYLOAD IS PER-JOB STATE AND BELONGS WITH THE OTHER PER-JOB CONFIG. This was a
        # SECOND writer of `src/autofill/workday/<slug>_payload.json`, after the one in application_pipeline.py
        # was moved: the file carries the applicant's own job title, employer and location, `src/autofill/`
        # also holds real source, and nothing in .gitignore covers it - so a configured checkout committed
        # them. The README beside that directory had already been corrected to say `<data>/autofill/...`
        # while this line still said otherwise.
        payload_path = DATA_DIR / "autofill" / "workday" / f"{role_profile_path.stem}_payload.json"
    payload_path.parent.mkdir(parents=True, exist_ok=True)
    payload_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    jd_text = role_profile.get("jd_text")
    jd_path = None
    if jd_text:
        jd_path = resolve_path(args.jd_output) if args.jd_output else OUTPUTS_DIR / f"{role_profile_path.stem}_jd.txt"
        jd_path.parent.mkdir(parents=True, exist_ok=True)
        jd_path.write_text(jd_text, encoding="utf-8")

    pdf_path = None
    qa_report = None
    if not args.docx_only:
        app_profile = load_json(APPLICATION_PROFILE)
        excluded_websites = [
            item["url"] if isinstance(item, dict) else item
            for item in app_profile.get("candidate", {}).get("excluded_websites", [])
        ]
        # THE NAME EXPECTATION IS THE PROFILE'S OWN NAME. It used to be the literal "Example Candidate", which the
        # QA pass looks for in the rendered PDF: the moment the header started printing the real profile name, a
        # hardcoded expectation would have failed every resume for saying a name nobody wrote in the file.
        pdf_path, qa_report = export_and_validate_pdf(
            output_docx,
            pdf_path=resolve_path(args.pdf_output) if args.pdf_output else None,
            render_dir=resolve_path(args.render_dir) if args.render_dir else None,
            expected_terms=[(app_profile.get("candidate") or {}).get("name") or "", "EDUCATION", "EXPERIENCE"],
            allowed_phrases=_allowed_phrases(),
            forbidden_terms=excluded_websites,
        )

    print(f"Output DOCX: {output_docx}")
    if pdf_path:
        print(f"Output PDF: {pdf_path}")
        print(f"PDF QA: {qa_report['page_count']} pages; rendered page review required")
    print(f"Workday payload: {payload_path}")
    if jd_path:
        print(f"JD text: {jd_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
