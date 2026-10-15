#!/usr/bin/env python3
"""check_duplicate.py — decide whether a posting is NEW or a re-post of something already applied to.

WHY THIS EXISTS. Employers routinely close a requisition and re-post the identical role under a fresh requisition id.
A URL comparison then says "different job" while company+title says "the same job you already applied to". Three targets
in a row were lost to this ambiguity before the test below was identified, each costing several rounds of manual
archaeology.

THE TEST. When a candidate posting's company and title match an existing tracker row but the URL differs:
  1. fetch the board's LIVE job list;
  2. is the OLD requisition still posted?  and
  3. is the NEW one the only posting carrying that exact title?
Old gone + new alone with that title  -> the employer re-posted the same opening -> DUPLICATE, do not apply.
Old still live                        -> genuinely two openings             -> NEW, applying is legitimate.

USAGE
    .venv/bin/python3 src/screening/check_duplicate.py <posting-url> [<posting-url> ...]

It prints one verdict per URL: NEW (safe), DUPLICATE (re-post of a recorded application) or REVIEW (no matching row, or
the board could not be read - decide by hand). Nothing is written; it only reads the tracker and the board API.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

TRACKER = DATA_DIR / "applications.csv"
UA = {"User-Agent": "Mozilla/5.0"}

#: The URL shapes `parse_posting` can read, spelled out in the refusal. A human who gets "unrecognised posting
#: URL shape - check by hand." could not tell which shapes ARE accepted, so the failure was unactionable - the
#: message now names them (cold-start smoke test, 2026-10-14, which arrived with a boards.greenhouse.io URL).
ACCEPTED_SHAPES = (
    "job-boards.greenhouse.io/<board>/jobs/<id>",
    "boards.greenhouse.io/<board>/jobs/<id>",
    "boards.greenhouse.io/embed/job_app?for=<board>&token=<id>",
    "boards.greenhouse.io/embed/job_app?for=<board>&gh_jid=<id>",
    "jobs.ashbyhq.com/<board>/<uuid>",
    "jobs.lever.co/<board>/<uuid>",
    "apply.careers.microsoft.com/careers/job/<pid>",
    "apply.careers.microsoft.com/careers/apply?pid=<pid>",
)

# The tracker read and the comparison normaliser are shared with the other screeners; this file carried its
# own copies of both until 2026-10-06. See src/screening/tracker_index.py for the two traps each copy had to
# rediscover (the UTF-8 BOM, and parents[2] rather than parents[1]).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tracker_index import load_rows, norm as shared_norm, same_company  # noqa: E402


def get_json(url: str):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read())


def parse_posting(url: str):
    """Return (ats, slug, requisition_id) for a posting URL, or (None, None, None)."""
    # Greenhouse serves one requisition on TWO hosts: the board host the links use (job-boards.greenhouse.io)
    # and the main host the employer's own link sometimes uses (boards.greenhouse.io). Both fold to the same
    # identity - platform, board slug, numeric id - because they are the same posting, and a row recorded from
    # one host must be seen as the row the other host is asking about. `boards.greenhouse.io/greenhouse/jobs/
    # 8279799` was refused by the parser until 2026-10-14, and prepare-written rows then read `req None |
    # unparsed` in dedupe.
    m = re.search(r"(?:job-boards|boards)\.greenhouse\.io/([^/]+)/jobs/(\d+)", url)
    if m:
        return "greenhouse", m.group(1), m.group(2)
    m = re.search(r"boards\.greenhouse\.io/(?:embed/job_app\?for=)?([^/&?]+).*?gh_jid=(\d+)", url)
    if m:
        return "greenhouse", m.group(1), m.group(2)
    # THE `embed/job_app?token=` FORM, which is what actually cost a duplicate. One Imaging's Full Stack Software
    # Engineer (Greenhouse 4018408009) was submitted on 2026-09-30 from
    # `job-boards.greenhouse.io/embed/job_app?token=4018408009&for=oneimaging` and submitted AGAIN from
    # `job-boards.greenhouse.io/oneimaging/jobs/4018408009`. This parser folded the second and returned
    # (None, None, None) for the first, so the pair was never compared - found again while deleting the case that
    # recorded it, and the `for=` parameter is the board slug rather than the id.
    m = re.search(r"greenhouse\.io/embed/job_app\?", url)
    if m:
        tok = re.search(r"[?&]token=(\d+)", url)
        board = re.search(r"[?&]for=([^/&?]+)", url)
        if tok and board:
            return "greenhouse", board.group(1), tok.group(1)
    m = re.search(r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{36})", url)
    if m:
        return "ashby", m.group(1), m.group(2)
    m = re.search(r"jobs\.lever\.co/([^/]+)/([0-9a-f-]{36})", url)
    if m:
        return "lever", m.group(1), m.group(2)
    # Microsoft's careers site runs on Eightfold and identifies a posting by a numeric pid, on either the posting route
    # (careers/job/<pid>) or the application route (careers/apply?pid=<pid>).
    m = re.search(r"careers\.microsoft\.com/careers/(?:job/|apply\?pid=)(\d+)", url)
    # WORKABLE IS DELIBERATELY ABSENT. Its search API identifies a posting as
    # `jobs.workable.com/view/<VIEWCODE>/<slug>` and the tracker records `apply.workable.com/<board>/j/<SHORTCODE>` -
    # two DIFFERENT identifiers, so a branch here would parse both sides and still never match them. Workable is
    # covered by the durable pair instead (company + title, with `same_company`'s containment test), and the id
    # comparisons are guarded, so an unparsed source matches nothing. Adding Workable back would make this function
    # look like it covers a platform it cannot.
    if m:
        return "eightfold", "microsoft", m.group(1)
    return None, None, None


def board_jobs(ats: str, slug: str):
    """Return a list of (requisition_id, title, location) for a board, or None if unreadable."""
    try:
        if ats == "greenhouse":
            data = get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
            return [(str(j.get("id")), j.get("title") or "", (j.get("location") or {}).get("name") or "")
                    for j in data.get("jobs", [])]
        if ats == "ashby":
            data = get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
            return [(str(j.get("id")), j.get("title") or "", j.get("location") or "")
                    for j in data.get("jobs", [])]
        if ats == "lever":
            data = get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json")
            return [(str(j.get("id")), j.get("text") or "", ((j.get("categories") or {}).get("location")) or "")
                    for j in data]  # Lever returns a bare list, not an object
    except Exception as exc:  # noqa: BLE001 - a board that cannot be read must not crash the check
        print(f"    (board {ats}:{slug} unreadable: {str(exc)[:70]})")
        return None
    return None


def load_tracker():
    """Delegates to the shared reader: the BOM handling and `parents[2]` root live in tracker_index.py now.

    Kept as a named wrapper because this module's `TRACKER` is referenced in its docstring and tests."""
    return load_rows(TRACKER)


def norm(text: str) -> str:
    return shared_norm(text)


def main(argv):
    # A FLAG A READER WILL CERTAINLY TRY BELONGS WITH THE NO-ARGUMENT CASE. `--help` used to fall
    # through to the loop below and be checked AS A URL, printing "REVIEW: unrecognised posting URL
    # shape" - a plausible-looking verdict for a question nobody asked.
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 1
    rows = load_tracker()
    for url in argv:
        ats, slug, req = parse_posting(url)
        print(f"\n=== {url}")
        if not ats:
            print("    REVIEW: unrecognised posting URL shape - check by hand. Accepted shapes: "
                  + ", ".join(ACCEPTED_SHAPES) + ".")
            continue
        board = board_jobs(ats, slug)
        if board is None:
            print("    REVIEW: the board could not be read, so the re-post test cannot run.")
            continue
        title = next((t for i, t, _ in board if i == req), None)
        if title is None:
            print(f"    REVIEW: requisition {req} is not on the live board ({len(board)} postings) - "
                  f"it may have just closed.")
            continue
        same_title = [(i, t, loc) for i, t, loc in board if norm(t) == norm(title)]
        print(f"    live posting: {title} | {len(same_title)} posting(s) with this exact title on a {len(board)}-job board")

        # FIRST, and before any re-post reasoning: has THIS EXACT requisition already been applied to? A same-requisition row
        # is deliberately excluded from the re-post test further down, because it may be a note this tool wrote on an earlier
        # run. But a same-requisition row that records a SUBMISSION is not a note - it means the application was already made,
        # and re-applying is exactly what the contract forbids. Bestow "Software Engineer II" was missed this way on
        # 2026-10-03: the tracker held the very same requisition as submitted_by_agent (rejected the next day), but the tracker
        # URL carried an /application suffix that the query URL did not, so the string comparison saw two different postings
        # and the verdict came out NEW.
        SUBMITTED_STATUSES = {"submitted_by_agent", "submitted_by_user"}
        # A requisition id is unique to one opening, so a tracker row that parses to THIS req and records a SUBMISSION is the
        # same application - the title must NOT be required to match. Requiring it reintroduced the very failure this block
        # exists to prevent: on 2026-10-03 Acorns "Senior Full-Stack Software Engineer, Community" (submitted) versus the live
        # "..., Community Building" and Close 01fc4ad7 (submitted 2026-10-02) both came back NEW despite a submitted row for
        # the identical requisition, because the employer had edited the title. Two false NEW verdicts in one round, either of
        # which would have re-applied to a job already applied to. The req guard stays so an unparsed source cannot match.
        same_req = [r for r in rows
                    if req
                    and parse_posting(r.get("source") or "")[2] == req
                    and (r.get("status") or "").strip() in SUBMITTED_STATUSES]
        if same_req:
            r = same_req[0]
            drifted = "" if norm(r.get("title")) == norm(title) else \
                f" (tracker title {r.get('title')!r} differs from the live {title!r})"
            print(f"    DUPLICATE: this exact requisition is already in the tracker as {r.get('status')} "
                  f"({r.get('date_added')}, req {req}){drifted}. Do not apply - a submission here already exists.")
            continue

        # rows in the tracker that look like the same company + role.
        # CRUCIALLY: a row pointing at THIS SAME requisition is not evidence about a different posting - it may be a
        # note this tool wrote itself on an earlier run - so it is excluded before any verdict is formed.
        company_hint = norm(slug)
        matches = [r for r in rows
                   if norm(r.get("title")) == norm(title)
                   # BY WORD, NOT BY SUBSTRING. This was a containment test on the normalised forms, so the
                   # slug `loft` matched a tracker row for `Agiloft` and two unrelated employers were weighed
                   # as one whenever their titles agreed. See `same_company` for what that costs.
                   and (same_company(company_hint, r.get("company"))
                        or company_hint[:6] in norm(r.get("source")))
                   and parse_posting(r.get("source") or "")[2] != req]
        if not matches:
            print(f"    NEW: no tracker row matches this company and title under a DIFFERENT requisition. Safe to apply.")
            continue
        verdict = "NEW"
        old_gone = False
        for r in matches:
            old_ats, old_slug, old_req = parse_posting(r.get("source") or "")
            old_live = any(i == old_req for i, _, _ in board) if old_req else None
            print(f"    existing row: {r.get('status')} | {r.get('date_added')} | req {old_req} | "
                  f"{'STILL LIVE' if old_live else ('GONE from the board' if old_live is False else 'unparsed')}")
            if old_live is False:
                old_gone = True
        if old_gone and len(same_title) == 1:
            verdict = "DUPLICATE"
        elif old_gone:
            verdict = "REVIEW"
        if verdict == "DUPLICATE":
            print("    DUPLICATE: the matching row's requisition is gone and this one is the only posting with that "
                  "title, so the employer re-posted the same opening. Do not apply.")
        elif verdict == "REVIEW":
            print(f"    REVIEW: the matching row's requisition is gone, BUT {len(same_title)} postings now carry that "
                  "exact title, so this may be a re-post split by team or location, or genuinely several openings. "
                  "Compare the postings' contents by hand before applying.")
        else:
            print("    NEW: a matching row exists but its requisition is still live, so these are two openings. "
                  "Applying is legitimate - confirm the titles differ in scope if they look identical.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
