#!/usr/bin/env python3
"""filter_unapplied.py — keep only the scanner candidates whose requisition is NOT already in the tracker.

WHY THIS EXISTS. `scan_registry_fresh.py` decides freshness at the COMPANY level, so it lists every open role at
companies already applied to and its own output says "role-level dedupe still required". Acting on that list by eye
wasted a round: three Affirm "Software Engineer II, Backend (Remote US)" roles looked like perfect fresh targets -
exactly the band the objective weights first - and all three were already `submitted_by_agent`.

This reads the scanner's output on stdin (or a file argument) and prints only candidates whose requisition id does not
appear anywhere in `data/applications.csv`. Requisition ids are extracted from both the candidate URL and each tracker
source, so the comparison works whether the URL carries a Greenhouse token, an Ashby uuid, or a numeric job id.

USAGE
  .venv/bin/python3 src/screening/scan_registry_fresh.py | .venv/bin/python3 src/screening/filter_unapplied.py
  .venv/bin/python3 src/screening/filter_unapplied.py data/scratch/registry_scan.txt [--all]
"""
import re
import sys
from pathlib import Path

# The tracker read, the BOM handling and the requisition-id regex live in one shared module; this file used to
# carry its own copies of all three. See src/screening/tracker_index.py for why.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tracker_index import load_rows, req_ids  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith("--")]
show_all = "--all" in sys.argv
text = Path(args[0]).read_text() if args else sys.stdin.read()

known: set[str] = set()
for row in load_rows():
    known |= req_ids(row.get("source"))

line_re = re.compile(r"^\s{2}(\S.*?)\s+\|\s+(.*?)\s+\|\s+(.*?)\s+\|\s+(\S+)\s*$")
kept, skipped, unparsed = [], 0, 0
for line in text.splitlines():
    m = line_re.match(line)
    if not m:
        # A LINE THAT DOES NOT PARSE IS NOT A CLEAN RESULT (fixed 2026-10-07). Fed a plain list of URLs - the
        # obvious thing to feed a dedupe tool - every line failed this regex, the loop kept nothing, and the tool
        # printed "unapplied candidates: 0", which reads as "nothing here is already applied to". The expected
        # shape is `  company | title | location | url`, which is what scan_registry_fresh.py emits, and the
        # docstring said so only for the piped case.
        if line.strip():
            unparsed += 1
        continue
    company, title, loc, url = (g.strip() for g in m.groups())
    ids = req_ids(url)
    if ids & known and not show_all:
        skipped += 1
        continue
    kept.append((company, title, loc, url))

if unparsed and not kept:
    print(
        f"REFUSING TO REPORT A CLEAN RESULT: {unparsed} non-blank input line(s) did not match the expected "
        "`  company | title | location | url` shape, so NOTHING was checked. Do not read '0' as 'nothing is "
        "already applied to'.",
        file=sys.stderr,
    )
    raise SystemExit(2)

print(f"unapplied candidates: {len(kept)}  (skipped {skipped} already in the tracker"
      + (f", {unparsed} line(s) unparsed" if unparsed else "") + ")")
for company, title, loc, url in kept:
    print(f"  {company[:22]:24s} | {title[:52]:54s} | {loc[:24]:26s} | {url}")
