#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FINAL_PDF_DIR = ROOT / "output" / "pdf"
QA_ROOT = ROOT / "tmp" / "render"


def bundled_python() -> Path:
    """Interpreter used to run the DOCX renderer.

    The project's own virtualenv (.venv, see requirements.txt) wins; without it we fall back
    to whatever interpreter is running this module.
    """
    venv_python = ROOT / ".venv" / "bin" / "python3"
    return venv_python if venv_python.exists() else Path(sys.executable)


def render_docx_script() -> Path:
    """The repo's own DOCX -> PNG/PDF renderer, depending on nothing but this repo's tools."""
    script = ROOT / "src" / "pipeline" / "render_docx.py"
    if not script.exists():
        raise RuntimeError(f"DOCX renderer is missing: {script}")
    return script


def _pdf_reader(path: Path):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError(
            "pypdf is required for PDF QA. Run the pipeline through .venv "
            "(see requirements.txt)."
        ) from exc
    return PdfReader(str(path))


def _image_nonblank(path: Path) -> bool:
    try:
        from PIL import Image, ImageStat
    except ImportError:
        return path.stat().st_size > 5_000

    with Image.open(path).convert("L") as image:
        stat = ImageStat.Stat(image)
        return stat.extrema[0][0] < 245 and stat.var[0] > 5


def validate_pdf(
    pdf_path: Path,
    render_dir: Path,
    *,
    expected_terms: list[str] | None = None,
    forbidden_terms: list[str] | None = None,
    allowed_phrases: list[str] | None = None,
) -> dict:
    if not pdf_path.exists() or pdf_path.stat().st_size < 10_000:
        raise RuntimeError(f"PDF is missing or unexpectedly small: {pdf_path}")
    if pdf_path.read_bytes()[:5] != b"%PDF-":
        raise RuntimeError(f"Output is not a valid PDF file: {pdf_path}")

    reader = _pdf_reader(pdf_path)
    page_count = len(reader.pages)
    if not 1 <= page_count <= 3:
        raise RuntimeError(f"Resume PDF should contain 1-3 pages, found {page_count}")

    page_sizes = []
    text_parts = []
    for page in reader.pages:
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        page_sizes.append({"width_points": round(width, 2), "height_points": round(height, 2)})
        if abs(width - 612) > 18 or abs(height - 792) > 18:
            raise RuntimeError(f"Resume PDF page is not US Letter: {width:.1f} x {height:.1f} points")
        text_parts.append(page.extract_text() or "")

    extracted_text = "\n".join(text_parts)
    if len(extracted_text.strip()) < 1_000:
        raise RuntimeError("PDF text extraction is unexpectedly short; conversion may have failed")

    missing_terms = [term for term in expected_terms or [] if term.lower() not in extracted_text.lower()]
    if missing_terms:
        raise RuntimeError(f"PDF is missing expected text: {', '.join(missing_terms)}")

    # A forbidden term still fails the resume UNLESS every occurrence sits inside a sanctioned phrase. The sanctioned
    # phrases come from candidate_profile.json (do_not_claim_allowed_phrases) and exist because a do_not_claim term can
    # be a true fact about a project's stack while still not being a claim the candidate makes about himself.
    scrubbed = extracted_text.lower()
    for phrase in allowed_phrases or []:
        scrubbed = scrubbed.replace(phrase.lower(), " ")
    # Word-boundary aware, and deliberately not \b: a term ending in a symbol (C++) has no trailing boundary, while a
    # term inside a longer word must not match at all. "Java" is the case that proves it - a plain substring test flags
    # every mention of JavaScript, which is a core skill on this resume and was never a do_not_claim issue.
    def _hits(term: str) -> bool:
        return re.search(r"(?<![A-Za-z])" + re.escape(term.lower()) + r"(?![A-Za-z])", scrubbed) is not None

    forbidden_found = [term for term in forbidden_terms or [] if _hits(term)]
    if forbidden_found:
        raise RuntimeError(f"PDF contains forbidden text: {', '.join(forbidden_found)}")

    page_images = sorted(render_dir.glob("page-*.png"))
    if len(page_images) != page_count:
        raise RuntimeError(f"Expected {page_count} rendered page images, found {len(page_images)}")
    blank_images = [path.name for path in page_images if not _image_nonblank(path)]
    if blank_images:
        raise RuntimeError(f"Rendered PDF contains blank-looking pages: {', '.join(blank_images)}")

    return {
        "ok": True,
        "pdf": str(pdf_path),
        "page_count": page_count,
        "page_sizes": page_sizes,
        "text_characters": len(extracted_text),
        "rendered_pages": [str(path) for path in page_images],
        "visual_review_required": True,
    }


def _run_renderer_relayed(command: list[str], out=None) -> subprocess.CompletedProcess:
    """Run `command`, relaying its combined stdout+stderr to the caller's stream AS IT ARRIVES.

    WHY THIS EXISTS. `export_and_validate_pdf` ran the renderer with `subprocess.run(capture_output=True)`, so a
    first `prepare` on a machine with no LibreOffice sat for ~30 seconds downloading ~285 MiB with NOTHING on
    screen: the resolver's announcement ("LibreOffice was not found - downloading...") and the installer's own
    progress were both captured by the parent and shown only on failure - which is exactly when the person
    already knew something was wrong (cold-start smoke test, 2026-10-14). The child's stream is therefore read
    chunk by chunk and written through as each chunk arrives, so the announcement appears before the download
    finishes; the whole output is still kept, so a failed run can report the tail it always reported.

    `out` is a test seam: the caller's stream in production (default `sys.stdout`), any writable in a test.
    """
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = sys.stdout if out is None else out
    chunks: list[str] = []
    while True:
        chunk = proc.stdout.read(2048)
        if not chunk:
            break
        out.write(chunk)
        out.flush()
        chunks.append(chunk)
    return subprocess.CompletedProcess(command, proc.wait(), stdout="".join(chunks))


def export_and_validate_pdf(
    docx_path: Path,
    *,
    pdf_path: Path | None = None,
    render_dir: Path | None = None,
    expected_terms: list[str] | None = None,
    forbidden_terms: list[str] | None = None,
    allowed_phrases: list[str] | None = None,
) -> tuple[Path, dict]:
    docx_path = docx_path.resolve()
    if not docx_path.exists():
        raise FileNotFoundError(docx_path)

    pdf_path = (pdf_path or FINAL_PDF_DIR / f"{docx_path.stem}.pdf").resolve()
    render_dir = (render_dir or QA_ROOT / f"{docx_path.stem}_render").resolve()
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    render_dir.mkdir(parents=True, exist_ok=True)

    for stale in [*render_dir.glob("page-*.png"), render_dir / f"{docx_path.stem}.pdf"]:
        if stale.exists():
            stale.unlink()

    command = [
        str(bundled_python()),
        str(render_docx_script()),
        str(docx_path),
        "--output_dir",
        str(render_dir),
        "--emit_pdf",
    ]
    completed = _run_renderer_relayed(command)
    if completed.returncode != 0:
        details = (completed.stdout or "").strip()
        raise RuntimeError(f"DOCX render failed: {details}")

    rendered_pdf = render_dir / f"{docx_path.stem}.pdf"
    if not rendered_pdf.exists():
        raise RuntimeError(f"Renderer did not produce the expected PDF: {rendered_pdf}")
    shutil.copy2(rendered_pdf, pdf_path)

    report = validate_pdf(
        pdf_path,
        render_dir,
        expected_terms=expected_terms,
        forbidden_terms=forbidden_terms,
        allowed_phrases=allowed_phrases,
    )
    report_path = render_dir / "qa-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return pdf_path, report
