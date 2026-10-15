#!/usr/bin/env python3
"""list_board_jobs.py — print EVERY job on a board, with no filtering.

WHY: src/screening/screen_urls.py filters for "candidate-shaped" roles, and that filter was wrong for two whole boards last round
- Runway's backend API role (3+ years, $240K-$290K) and DuckDuckGo's Senior Backend Engineer never surfaced, and
"the scanner returned zero" almost became "there is nothing there". This tool deliberately does no filtering: it lists
titles and locations so a human or the model can see what is actually on a board before deciding.

AND IT NOW DOES NO FILTERING AT ALL. `ROLE_HINTS` was `engineer|developer|swe|architect|programmer` - this file's own
idea of what a role is, which is the same defect as the filter it was written to escape, one field narrower: on a
hospital's board it printed nothing, because a nurse's title carries none of those words. There is no field-independent
vocabulary of "role", so the field does not gate this output; it MARKS it, from the same `field_include` the screeners
use (`filters.field_include` in the registry, else the profile's own `resume_tracks` keywords). A posting outside your
field is worth reading here - that is what this tool is for - and the mark says which side of the line it is on.

Usage:
  python3 src/screening/list_board_jobs.py ab:runway-ml gh:some-board lever:some-board ...
  python3 src/screening/list_board_jobs.py --file tmp/slugs.txt          # one slug per line
"""
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.screening.screen_newgrad_postings import (  # noqa: E402
    field_patterns,
    load_candidate_profile,
    load_sources,
)

UA = {"User-Agent": "Mozilla/5.0"}
US_HINTS = re.compile(r"\b(united states|usa|u\.s\.|us\b|remote|new york|san francisco|seattle|austin|boston|"
                      r"chicago|los angeles|denver|atlanta|miami|dallas|anywhere)\b", re.I)


def fetch(slug: str):
    if slug.startswith("ab:"):
        name = slug[3:]
        url = f"https://api.ashbyhq.com/posting-api/job-board/{name}"
        data = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read())
        return [(j.get("title") or "", j.get("location") or "", j.get("jobUrl") or "") for j in data.get("jobs", [])]
    if slug.startswith("gh:"):
        name = slug[3:]
        url = f"https://boards-api.greenhouse.io/v1/boards/{name}/jobs"
        data = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read())
        return [(j.get("title") or "", (j.get("location") or {}).get("name") or "", j.get("absolute_url") or "")
                for j in data.get("jobs", [])]
    if slug.startswith("lever:"):
        name = slug[6:]
        url = f"https://api.lever.co/v0/postings/{name}?mode=json"
        data = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read())
        return [(j.get("text") or "", (j.get("categories") or {}).get("location") or "", j.get("hostedUrl") or "")
                for j in data]
    return []


def main() -> int:
    args = sys.argv[1:]
    if "--file" in args:
        slugs = [s.strip() for s in pathlib.Path(args[args.index("--file") + 1]).read_text().split() if s.strip()]
    else:
        slugs = args
    if not slugs:
        print(__doc__)
        return 2

    # The field, compiled once for the run. It marks the rows rather than choosing them, which is the
    # one thing that makes this tool different from the screeners: a posting the screen would drop is
    # exactly what someone reads this output to find.
    patterns, field_note = field_patterns(load_sources(), load_candidate_profile())
    if field_note:
        print(f"# {field_note}")
    print("# F = the title is in your field (the mark, not a gate: every job on these boards is listed);"
          " U = the location looks US")

    in_field = 0
    listed = 0
    for slug in slugs:
        try:
            jobs = fetch(slug)
        except Exception as exc:                       # noqa: BLE001 - report and continue
            print(f"\n=== {slug}: unreadable ({str(exc)[:60]})")
            continue
        print(f"\n=== {slug}: {len(jobs)} jobs")
        for title, loc, url in jobs:
            mine = bool(patterns.field_include.search(title))
            us = bool(US_HINTS.search(loc))
            listed += 1
            if mine:
                in_field += 1
            mark = ("F" if mine else "-") + ("U" if us else "-")
            print(f"  {mark} {title[:70]:72s} | {loc[:34]:36s} | {url}")
    print(f"\nroles in your field: {in_field} of {listed} jobs listed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
