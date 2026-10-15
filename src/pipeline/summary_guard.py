"""summary_guard.py - refuse a resume profile whose summary is likely to blow the PDF page budget.

WHY THIS EXISTS. The summary ceiling was hit four times in one session under the OLD template: prepare refused at 1,251,
1,265 was fine, 1,271, 1,291, 1,294, 1,318 and 1,349 were refused, and 1,251 both passed and failed on different content.
Those numbers belong to a layout this file no longer produces - the ceiling is HARD_EDGE below, recalibrated from the
current window - but the reason they were recorded is unchanged: every refusal costs a full round, and each one was
avoidable by counting characters BEFORE calling prepare. This module makes that count part of building a profile instead
of a lesson to remember.

WHAT IT DOES NOT DO: it never truncates. Silently shortening a tailored summary would change what an employer reads, which
is worse than a refused prepare. It REPORTS, and it returns a non-zero exit for a script to act on.

USAGE

    from summary_guard import assert_summary_fits
    assert_summary_fits(SUMMARY)            # raises SystemExit(2) with the numbers when too long

or from the shell, on a built profile:

    .venv/bin/python3 src/pipeline/summary_guard.py data/resume_profiles/<slug>.json

The safe target is 1,150-1,200 characters. Anything above HARD_EDGE is refused before prepare is called.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

# RECALIBRATED FOR THE NEW LAYOUT (2026-10-07). The old 1,100-1,200 window came from the previous template's page
# budget. The new work-plus-projects layout carries a 570-character master summary and lands on 3 pages, so the window
# is set from what that layout actually holds - and a summary that is too SHORT is now refused as well, because a
# one-line summary wastes the space the layout reserves for it.
SAFE_MIN = 450
SAFE_MAX = 800
HARD_EDGE = 950


# FIRST PERSON IS MANDATORY (user instruction, 2026-10-05). A third-person summary reads like a profile written ABOUT the
# candidate; these are the words that make it one, and a summary with none of the first-person markers is refused too.
_THIRD_PERSON = re.compile(r"\b(he|him|his|she|her|hers)\b", re.IGNORECASE)
_FIRST_PERSON = re.compile(r"\b(i|i'm|i've|i'll|i'd|my|me|myself|mine)\b", re.IGNORECASE)


def assert_first_person(text: str) -> None:
    """SystemExit(2) when a summary slips into the third person, or never uses the first person at all."""
    t = text or ""
    third = sorted({m.group(0).lower() for m in _THIRD_PERSON.finditer(t)})
    if third:
        sys.exit(
            "REFUSING TO PROCEED: the summary uses THIRD-PERSON pronouns "
            f"({', '.join(third)}). The user's instruction is that resume summaries are written in the FIRST PERSON "
            "('I build...', 'my record...'), not about the candidate ('he builds...'). Rewrite the summary; the guard "
            "will not truncate it for you."
        )
    if not _FIRST_PERSON.search(t):
        sys.exit(
            "REFUSING TO PROCEED: the summary contains no first-person marker (I, my, me, myself). Subject-less "
            "fragments do not satisfy the first-person rule either - write it as the candidate would say it."
        )


def summarise(text: str) -> str:
    n = len(text or "")
    return f"summary is {n} characters (safe {SAFE_MIN}-{SAFE_MAX}, hard edge {HARD_EDGE})"


def assert_summary_fits(text: str, *, strict: bool = False) -> None:
    """SystemExit(2) when the summary is likely to make prepare refuse. strict=True also refuses the grey zone."""
    assert_first_person(text)
    n = len(text or "")
    # NO MINIMUM (2026-10-07). A floor was tried for one round and it refused a perfectly reasonable 254-character
    # per-JD summary. The user asked for two things - no third person, and not too long - and the user also asked for
    # per-JD customisation to stay flexible, which a floor works against. Short is a style choice, long is a page-budget
    # problem, so only the ceiling is enforced.
    if n > HARD_EDGE or (strict and n > SAFE_MAX):
        sys.exit(
            f"REFUSING TO PROCEED: {summarise(text)}. "
            f"prepare would most likely reply 'PREPARE: ?' and 'SKIPPING: prepare did not produce a bundle', costing a "
            f"round. Shorten the summary to {SAFE_MAX} or below - do not truncate it in place, because silently cutting a "
            f"tailored sentence changes what the employer reads."
        )
    print("summary guard OK:", summarise(text))


def main(argv: list[str]) -> int:
    # `--help` USED TO BE READ AS A FILENAME, so asking this tool what it does raised
    # `FileNotFoundError: '--help'`. A flag a reader will certainly try belongs with the no-argument
    # case, which already prints the usage.
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    path = pathlib.Path(argv[0])
    data = json.loads(path.read_text())
    assert_summary_fits(data.get("summary", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
