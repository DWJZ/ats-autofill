"""Scan every Greenhouse tenant the tracker already knows, for unapplied US-based roles in the applicant's field.

This is the "re-read a known tenant's live board" method applied to the whole tracker instead of one board at a time.
It exists because the registry snapshot under-reports badly - it showed one xAI role where the live board held 37 - and
because tenants already in the tracker have forms this pipeline has already driven successfully.

The field is not this file's to name: `TITLES` was a tuple of software job titles, so a tenant's nursing or legal
postings were dropped by a substring test with nothing said about it. It now comes from the shared model, which reads
`filters.field_include` from the registry and the profile's own `resume_tracks` keywords (see `field_patterns`).
"""
import csv
import json
import pathlib
import re
import sys
import urllib.request
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)
from src.screening.screen_newgrad_postings import (  # noqa: E402
    GENERAL_SKIP_TITLE,
    field_patterns,
    load_candidate_profile,
    load_sources,
)

TRACKER = DATA_DIR / 'applications.csv'
NON_US = ('London', 'Dublin', 'Tokyo', 'Singapore', 'India', 'Israel', 'Australia', 'France', 'Germany', 'Poland',
          'Romania', 'Brazil', 'Mexico', 'Toronto', 'Montreal', 'Vancouver', 'Canada', 'UK', 'Ireland', 'Japan',
          'Netherlands', 'Spain', 'Sweden', 'Switzerland', 'Italy', 'Korea', 'Taiwan', 'China', 'Sydney')
# THE TITLE AND LEVEL VOCABULARY IS TWO KINDS OF WORD, WHICH IS WHY IT IS NO LONGER ONE TUPLE HERE. `manager`,
# `director` and `intern` are words every field writes, and `recruiter`/`account` are no field's either, so
# `GENERAL_SKIP_TITLE` holds that half. The other half is the FIELD's - `SKIP_TITLE` never carried any, but the
# tuple was the same kind of judgement `scan_registry_fresh.BADLVL` made with `qa|ios|mobile`, and it is read
# from the registry through `patterns.skip_title` so this scan and that one cannot drift apart.

# The field gate, compiled once from the registry and the profile - see `field_patterns`. The note is printed, because
# this scan decides what the applicant never sees and "no roles" reads the same whether the gate is right or software's.
patterns, field_note = field_patterns(load_sources(), load_candidate_profile())
if field_note:
    print(f'# {field_note}')
title_gates = [GENERAL_SKIP_TITLE, *([patterns.skip_title] if patterns.skip_title else [])]

have = set()
slugs = Counter()
with open(TRACKER, encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        src = (r.get('source') or '').strip().rstrip('/')
        if src:
            have.add(src)
        m = re.search(r'job-boards\.greenhouse\.io/([a-z0-9_.-]+)/jobs', src)
        if m:
            slugs[m.group(1)] += 1

print('greenhouse tenants in the tracker:', len(slugs))
found = []
for slug in slugs:
    try:
        d = json.load(urllib.request.urlopen(f'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs', timeout=25))
    except Exception:
        continue
    for j in d.get('jobs', []):
        url = f'https://job-boards.greenhouse.io/{slug}/jobs/{j["id"]}'
        if url in have:
            continue
        title = j.get('title', '')
        loc = (j.get('location') or {}).get('name', '')
        if not patterns.field_include.search(title) or any(g.search(title) for g in title_gates):
            continue
        if any(x in loc for x in NON_US):
            continue
        found.append((slug, j['id'], title[:56], loc[:34]))

print('unapplied US-ish roles in your field across those tenants:', len(found))
for slug, jid, title, loc in found[:30]:
    print(f'   {slug[:18]:18} | {jid} | {title} | {loc}')
