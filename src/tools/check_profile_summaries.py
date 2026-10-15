#!/usr/bin/env python3
"""check_profile_summaries.py — catch the over-long summary BEFORE prepare wastes a render.

An over-long summary makes the two-page render fail with "Rendered PDF contains blank-looking pages:
page-2.png". That has cost a retry three times (Updoc, Taekus, PermitFlow), so the check belongs in front of
the render rather than in the error message afterwards.

THE LIMITS COME FROM `summary_guard.py`, and that is the point of this file rather than an implementation
detail. It used to carry its own pair - 1200 and 1250, measured against a layout the project no longer
produces - while the guard the resume builders actually call enforced 800 and 950. Two gates with two
numbers meant this one could pass a summary that `prepare` would then refuse: a green light from a check
that is not the check that decides. One source, so they cannot disagree again.

Usage:
  python3 src/tools/check_profile_summaries.py <file>...  # the gate: exit 1 if one is over
  python3 src/tools/check_profile_summaries.py            # the audit: report every profile

WITH NO ARGUMENTS THIS EXITS 0, AND THAT IS NOT LAXITY. The saved profiles predate the current layout:
1005 of 1335 are over the ceiling, and none of them can be repaired by refusing anything - they were
written against a template that allowed longer summaries, and their PDFs were rendered and sent. A
sweep that always exits 1 is a sweep nobody can put in front of `prepare`, which is what the documented
workflow (`check_profile_summaries.py && prepare`) asks for. Named files are the gate.
"""
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

_guard_spec = importlib.util.spec_from_file_location("summary_guard", ROOT / "src/pipeline/summary_guard.py")
guard = importlib.util.module_from_spec(_guard_spec)
_guard_spec.loader.exec_module(guard)

TARGET = guard.SAFE_MAX        # the grey zone: warned about, still accepted
HARD_LIMIT = guard.HARD_EDGE   # the same ceiling the resume builders refuse at


def check(paths: list[pathlib.Path]) -> tuple[list[str], int]:
    """Return (lines to print, number over the hard limit). No exit, no printing: this is the testable half."""
    lines: list[str] = []
    bad = 0
    for path in paths:
        try:
            summary = json.loads(path.read_text()).get("summary", "")
        except Exception as exc:                                  # noqa: BLE001 - report and continue
            lines.append(f"  ??? {path.name}: unreadable ({exc})")
            continue
        n = len(summary)
        if n > HARD_LIMIT:
            bad += 1
            lines.append(f"  OVER  {n:5d} (hard limit {HARD_LIMIT})  {path.name}")
        elif n > TARGET:
            lines.append(f"  warn  {n:5d} (target {TARGET})       {path.name}")
    lines.append(f"checked {len(paths)} profiles; {bad} over the hard limit")
    return lines, bad


def main(argv: list[str]) -> int:
    """Check the named profiles, or every saved one when none are named. Returns the exit code."""
    targets = [pathlib.Path(a) for a in argv] or sorted((DATA_DIR / "resume_profiles").glob("*.json"))
    lines, bad = check(targets)
    print("\n".join(lines))
    # A full sweep reports; a named file gates. See the docstring for why the difference is deliberate.
    return 1 if (bad and argv) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
