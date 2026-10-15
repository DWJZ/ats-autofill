#!/usr/bin/env python3
"""render_docx.py - render a DOCX to page PNGs (and optionally a PDF).

Keeps resume generation depending only on this repo plus tools that can be installed without
admin rights:

    LibreOffice: either `brew install --cask libreoffice` or a project-local copy extracted
    from the official .dmg into .cache/libreoffice (src/tools/install_libreoffice.sh does that,
    no admin rights needed - Homebrew's prefix is not writable on this machine).
    Page rasterisation uses pypdfium2 (pip, no system poppler needed).

Usage:
    python3 src/pipeline/render_docx.py <file.docx> --output_dir <dir> [--emit_pdf]
                                        [--dpi 110]

Outputs (names match what resume_artifacts.validate_pdf expects):
    <dir>/page-1.png, <dir>/page-2.png, ...
    <dir>/<stem>.pdf          when --emit_pdf is given
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MACOS_SOFFICE = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")


def candidate_soffice_paths() -> list[Path]:
    paths: list[Path] = []
    # An explicit override wins over every guess below, because a machine can have several LibreOffice
    # installs and only the person who installed one knows which is meant.
    for name in ("SOFFICE_PATH",):
        if os.environ.get(name):
            paths.append(Path(os.environ[name]))
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            paths.append(Path(found))
    paths.append(
        ROOT / ".cache" / "libreoffice" / "LibreOffice.app" / "Contents" / "MacOS" / "soffice"
    )
    paths.append(MACOS_SOFFICE)
    return paths


def auto_download_allowed() -> bool:
    """May this run download LibreOffice on its own? The one decision, separated out so a test can ask it."""
    return sys.platform == "darwin" and not os.environ.get("ATS_NO_SOFFICE_DOWNLOAD")


def _run_installer_relayed(command: list[str], out=None) -> subprocess.CompletedProcess:
    """Run the installer with its output relayed to this process's stdout AS IT ARRIVES.

    WHY THIS EXISTS. The download takes ~30 s, and the installer's own lines ("downloading <url>", curl's
    progress bar) are the only sign of life during it. `subprocess.run(capture_output=True)` held every one of
    them until the process ended - on success that meant they were never shown at all, which is how a first
    `prepare` came to sit silent through a ~285 MiB download (cold-start smoke test, 2026-10-14). The chunks are
    written through as they arrive, and the whole output is still kept so a failed download can report the tail
    it always reported.

    `out` is a test seam: this process's stdout in production, any writable in a test.
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


def find_soffice() -> str:
    for path in candidate_soffice_paths():
        if path.exists():
            return str(path)
    # WHAT USED TO HAPPEN. A checkout with no LibreOffice stopped here with a message telling the person
    # to install it by hand - the one blocker on a fresh machine that this toolkit could remove on its own.
    # The installer for the project-local copy already exists (`src/tools/install_libreoffice.sh`, cached
    # in `.cache/`); the resolver now runs it, ONCE, on macOS, and says so before the download starts. A
    # failed download still raises the old message, with the installer's own tail attached so the reason
    # is not lost.
    if auto_download_allowed():
        print("LibreOffice was not found - downloading the project-local copy into .cache/ "
              "(about 300 MB, cached, one time). Set ATS_NO_SOFFICE_DOWNLOAD=1 to skip this.")
        installer = ROOT / "src" / "tools" / "install_libreoffice.sh"
        result = _run_installer_relayed(["bash", str(installer)])
        if result.returncode == 0:
            for path in candidate_soffice_paths():
                if path.exists():
                    return str(path)
        tail = (result.stdout or "").strip()[-400:]
        print(f"the LibreOffice download did not complete: {tail}")
    raise SystemExit(
        "LibreOffice was not found. Install it with `brew install --cask libreoffice` or run "
        "`bash src/tools/install_libreoffice.sh` to keep a project-local copy in .cache/libreoffice."
    )


def convert_to_pdf(docx_path: Path, work_dir: Path) -> Path:
    """Convert a DOCX to PDF with headless LibreOffice, using a throwaway LO profile."""
    profile = work_dir / "lo-profile"
    profile.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # Some shells and desktop apps hand Python a per-app TMPDIR that makes headless
    # LibreOffice abort on macOS.
    if sys.platform == "darwin":
        env["TMPDIR"] = "/private/tmp"
    command = [
        find_soffice(),
        "--headless",
        "--norestore",
        "--nolockcheck",
        f"-env:UserInstallation=file://{profile}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(work_dir),
        str(docx_path),
    ]
    completed = subprocess.run(command, text=True, capture_output=True, check=False, env=env)
    produced = work_dir / f"{docx_path.stem}.pdf"
    if completed.returncode != 0 or not produced.exists():
        details = (completed.stderr or completed.stdout or "").strip()
        raise SystemExit(f"LibreOffice conversion failed for {docx_path.name}: {details}")
    return produced


def render_pages(pdf_path: Path, output_dir: Path, dpi: int) -> list[Path]:
    """Rasterise every PDF page to page-N.png with pypdfium2 (no poppler needed)."""
    for stale in output_dir.glob("page-*.png"):
        stale.unlink()
    try:
        import pypdfium2 as pdfium
    except ImportError as exc:  # pragma: no cover - environment problem, not logic
        raise SystemExit(
            "pypdfium2 is required to rasterise PDF pages. Run: "
            ".venv/bin/python3 -m pip install -r requirements.txt"
        ) from exc

    scale = dpi / 72
    document = pdfium.PdfDocument(str(pdf_path))
    pages: list[Path] = []
    try:
        for index in range(len(document)):
            image = document[index].render(scale=scale).to_pil()
            target = output_dir / f"page-{index + 1}.png"
            image.save(target)
            pages.append(target)
    finally:
        document.close()
    if not pages:
        raise SystemExit(f"PDF has no pages to render: {pdf_path}")
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a DOCX to page PNGs / PDF")
    parser.add_argument("docx")
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--emit_pdf", action="store_true")
    parser.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args()

    docx_path = Path(args.docx).resolve()
    if not docx_path.exists():
        raise SystemExit(f"DOCX not found: {docx_path}")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="render-docx-") as tmp:
        pdf_path = convert_to_pdf(docx_path, Path(tmp))
        if args.emit_pdf:
            shutil.copy2(pdf_path, output_dir / f"{docx_path.stem}.pdf")
        pages = render_pages(pdf_path, output_dir, args.dpi)

    print(f"rendered {len(pages)} page(s) -> {output_dir}")
    for page in pages:
        print(f"  {page.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
