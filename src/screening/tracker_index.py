#!/usr/bin/env python3
"""tracker_index.py — the shared reader of `data/applications.csv`, and the normaliser for comparison.

IT IS NOT THE ONLY READER, and saying it was is what let the BOM trap it exists to centralise be
re-implemented elsewhere: `application_pipeline.py` has its own `read_tracker`, `scan_tracker_tenants.py`
opens the file itself, and `job_app_assistant.py` opens it to write. The screeners below are the readers
this module was consolidated for.

WHY THIS EXISTS. Five screeners each opened the tracker themselves: `check_duplicate`, `daily_screen`,
`filter_unapplied`, `scan_registry_fresh` and `screen_newgrad_postings`. Every copy repeated the same three
things, and each had to rediscover the same two traps:

  * **the file carries a UTF-8 BOM**, so the first column key is `\\ufeffdate_added` and a plain
    `open(..., encoding="utf-8")` raises `KeyError: 'date_added'` on the very first row;
  * **`ROOT` must be `parents[2]`**. One copy used `parents[1]`, resolved to `src/data/applications.csv`, and the
    whole scan died with `FileNotFoundError` — recorded in `scan_registry_fresh.py`'s own comment.

This module is those two facts plus the normalisers, so a sixth screener inherits them instead of re-learning them.
It deliberately does NOT try to unify the screeners' *matching* rules: they dedupe at different granularities on
purpose — a requisition id (`filter_unapplied`, `check_duplicate`), a company (`scan_registry_fresh`,
`harvest_board_slugs`), a company+title pair (`screen_newgrad_postings`). Those are not the same test, and merging
them would change what each tool reports.

Read-only helpers. Nothing here writes.
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

# parents[2], never parents[1]: this file is src/screening/tracker_index.py, so the repo root is two levels up.
# The same line in another screener once resolved to src/data/applications.csv.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# The tracker is read from the configured data directory, not from a path built here: `ATS_DATA_DIR` is what
# points a run at a fixture tree or at a second person's configuration, and `src/paths.py` is its one definition.
from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

TRACKER = DATA_DIR / "applications.csv"

# A requisition id in a job URL, whatever shape the ATS uses: an Ashby uuid, a Greenhouse `/jobs/<id>` or
# `token=<id>` number, or a bare long number. Lower-cased by the caller before set comparison.
REQ_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}[0-9a-f-]{4,}|(?<=/jobs/)\d{5,}|(?<=token=)\d{5,}|\b\d{7,}\b", re.I)

# Statuses that mean "this requisition was applied to". Kept here so every screener agrees on the set.
SUBMITTED_STATUSES = ("submitted_by_agent", "submitted_by_user")


def load_rows(path: Path | str = TRACKER) -> list[dict]:
    """Every tracker row, BOM handled. `encoding="utf-8-sig"` is the whole point of this function.

    A MISSING TRACKER IS THE FIRST-RUN STATE, NOT A FAULT, and it is worth saying so here rather
    than letting the open() below raise it. Every screener comes through this function, so on a
    checkout that has not been configured yet the whole `src/screening/` half of the toolkit used
    to die with a FileNotFoundError naming a path the reader had never heard of.
    """
    path = Path(path)
    if not path.is_file():
        raise SystemExit(
            f"no tracker at {path}\n"
            "Every screener reads it - whether a posting is already applied to, how many a board\n"
            "has already taken - so it has to exist before one can run. Create it with the setup\n"
            "step:\n"
            "    bash scripts/setup-examples.sh\n"
            "or point ATS_DATA_DIR at a directory that holds one. See src/paths.py."
        )
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def norm(text: str | None) -> str:
    """Comparison form: lower-cased, punctuation collapsed to single spaces, trimmed.

    `Bestow Software Engineer II` and `bestow  software  engineer ii` must compare equal; so must
    `Senior Full-Stack Software Engineer, Community` and `Senior Full Stack Software Engineer Community`.
    """
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def same_company(hint: str | None, company: str | None) -> bool:
    """Is `hint` the same employer as `company`, compared by whole WORDS rather than substrings?

    driving-widgets-cases-3: "match names by WORD, not by substring - `grep -i loft` returned Agiloft". A
    plain containment test on the normalised forms does exactly that: the board slug `loft` sits inside
    `Agiloft`, so `check_duplicate` treated two unrelated employers as one whenever their titles happened to
    agree - and `Software Engineer` is a title that agrees constantly. The verdict then turned on which of
    the two employers' requisitions was still live: old one gone and this the only posting carrying that
    title reads as a re-post, and a legitimate application is skipped as a duplicate.

    Whole words keep the case the containment test was written for - slug `agiloft` inside the tracker's
    `Agiloft, Inc.` - and drop the one it gets wrong. `norm` collapses punctuation to single spaces, which is
    what makes a padded containment test mean "as a word" rather than "as a run of characters".

    BOTH directions are kept, because the original checked both: a tracker row may carry the longer legal name,
    or the shorter one a slug was derived from. Only the boundary rule changed.
    """
    h, c = norm(hint), norm(company)
    if not h or not c:
        return False
    return h == c or f" {h} " in f" {c} " or f" {c} " in f" {h} "


def req_ids(text: str | None) -> set[str]:
    """Every requisition id that appears in a URL or a free-text field, lower-cased.

    Used for set intersection, so a candidate matches the tracker when the two share ANY id.
    """
    return {found.lower() for found in REQ_ID.findall(text or "")}


def submitted_rows(rows: list[dict] | None = None) -> list[dict]:
    """The rows that represent an actual application — what a dedupe must never let through again."""
    return [r for r in (rows if rows is not None else load_rows())
            if (r.get("status") or "").strip() in SUBMITTED_STATUSES]
