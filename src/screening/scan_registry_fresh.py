#!/usr/bin/env python3
"""Scan every board in the project's registry for US, non-senior roles at companies with no prior
application, ignoring the daily screen's seen-job state so nothing is hidden by earlier runs.

Filters: title is in the applicant's field (`filters.field_include` in the registry, else the
`resume_tracks` keywords in candidate_profile.json - see `field_patterns`); level is NOT
senior/staff/principal/lead/manager; location looks US or remote; the company has no row in
data/applications.csv (case-insensitive root match).
"""
import csv
import json
import re
import urllib.request
from pathlib import Path

# The tracker read is shared with the other screeners; this file carried its own copy until 2026-10-06.
import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from tracker_index import load_rows  # noqa: E402

# parents[0] is src/screening, parents[1] is src - this file lives two levels below the repository root, so the
# tracker path resolved to src/data/applications.csv and the whole scan died with FileNotFoundError. parents[2] is the
# repo root. Nothing else in this file depends on the working directory, so the absolute form is safe.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in _sys.path:
    _sys.path.insert(0, str(ROOT))
from src.paths import DATA_DIR  # noqa: E402  (the registry is configuration, not source)
# THE FIELD IS THE APPLICANT'S, NOT THIS FILE'S. `TITLE` was an entire software-job regex written into
# the source and it was this scan's only field gate, so every posting in any other field was dropped at
# the gate with nothing said about it - the same defect the other screeners had. The gate now comes from
# the shared model, which reads the registry and the profile (see `field_patterns`).
from screen_newgrad_postings import (  # noqa: E402
    GENERAL_SKIP_TITLE,
    field_patterns,
    load_candidate_profile,
)
# The tenant-skip reader is a pure function in the caps module, so importing it here cannot fetch anything.
from tenant_caps import tenant_skip_names  # noqa: E402
UA = {"User-Agent": "Mozilla/5.0"}
US = re.compile(
    r"united states|remote|,\s?(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|"
    r"NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b", re.I)
# NONUS is tested BEFORE US and wins, so the bare "remote" in US cannot let "Remote - Poland" through. It did: a scan
# listed Remote Poland, Remote Spain and Remote Canada roles as US candidates because US matched the word "remote" and
# the original NONUS list simply did not name those countries.
NONUS = re.compile(r"india|bengaluru|bangalore|dublin|warsaw|london|berlin|paris|tel aviv|singapore|tokyo|sydney|"
                   r"toronto|vancouver|mexico|brazil|são paulo|hyderabad|china|shanghai|beijing|"
                   r"poland|spain|portugal|romania|ireland|united kingdom|\buk\b|germany|france|netherlands|sweden|"
                   r"norway|denmark|finland|switzerland|austria|italy|belgium|czech|hungary|bulgaria|serbia|ukraine|"
                   r"canada|australia|new zealand|japan|korea|taiwan|hong kong|israel|argentina|chile|colombia|peru|"
                   r"costa rica|philippines|vietnam|thailand|malaysia|indonesia|pakistan|bangladesh|sri lanka|"
                   r"egypt|nigeria|kenya|south africa|turkey|armenia|georgia country|kazakhstan|remote -", re.I)
# "senior" USED TO BE IN THIS LIST AND THAT WAS WRONG. The objective weights lower-seniority postings first but says in
# the same sentence that strong Senior roles stay in scope, and docs/RULES.md repeats it ("Strong Senior roles stay in
# scope, and an exceptional Staff role may be taken"). Excluding the word "senior" therefore discarded exactly the roles
# the contract wanted to keep. What must be excluded is the MANAGER/LEAD track, not seniority: staff, principal, manager,
# lead, director, head and architect remain out, as do intern and the non-target families (qa, test, data engineer,
# machine learning, devops, sre, analyst, sales, support, solutions) and mobile.
#
# AND THE LIST IS TWO KINDS OF WORD, WHICH IS WHY IT IS NO LONGER ONE REGEX HERE. `manager`, `director`, `intern` and
# the family words are what every field calls them - `GENERAL_SKIP_TITLE` holds that half, and `levels.management` names
# the same judgement for a field that spells a management title with its own word ("Director of Nursing"). The other
# half is SOFTWARE's own: `qa`, `ios`, `mobile`, `devops`, `data engineer` say nothing about a hospital's board, so
# they come from the registry as `filters.skip_title` - see `field_patterns` - and a nursing registry replaces them.

# Tenants not to apply to again are a DECISION about an employer, so they live in the configuration file
# (`data/tenant_policies.json`, `policy: skip`) and are read from there rather than copied. This was a literal
# set with a comment telling the next reader to keep it in step with a prose reference file, and it had
# already drifted: five tenants the policy file records as `skip` were missing from it, so their roles kept
# surfacing as candidates. A literal cannot be kept in step by a comment - either the file is read or the
# list is a second source of truth.
#
# THE READER LIVES IN `tenant_caps.py` AND IS CALLED FROM HERE, where the scan runs, rather than at import
# scope: this module's body IS the scan, so anything at import scope is a network fetch waiting for whoever
# imports it. That is a real hazard and not a hypothetical - a test that imported this module to check this
# very set started a live scan of every board in the registry.
DO_NOT_RETRY = tenant_skip_names(DATA_DIR / "tenant_policies.json")

rows = load_rows()
seen = {(r["company"] or "").lower() for r in rows}
seen_tokens = set()
for c in seen:
    for tok in re.split(r"[^a-z0-9]+", c):
        if len(tok) > 3:
            seen_tokens.add(tok)
# The company-name test above is not enough: a board's slug often has nothing to do with the tenant's name.
# The cssmerge board is Lab37 Robotics (Atoms), so three roles already submitted by the tool were reported as a
# "fresh company" and one round started by looking at my own work. The URLs in the tracker are authoritative,
# so a slug that appears in any recorded source counts as a returning tenant too - and the display below now
# names the tenant as the tracker knows it.
board_company = {}
for r in rows:
    src = (r.get("source") or "")
    m = re.search(r"(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.ashbyhq\.com|jobs\.lever\.co)/"
                  r"(?:embed/job_app\?for=)?([A-Za-z0-9_.\-]+)", src, re.I)
    if m:
        board_company.setdefault(m.group(1).lower(), (r.get("company") or "").strip())
sources_blob = " ".join((r.get("source") or "").lower() for r in rows)

# THE REGISTRY IS CONFIGURATION AND LIVES IN THE DATA DIRECTORY. It was `src/screening/daily_sources.json`
# until it moved; this line kept opening the old path, so the module raised FileNotFoundError at import.
# Read with a `with`, as utf-8 like every other reader of this file - the one-liner it replaced left the
# handle to the garbage collector, and the scan now runs this line in every test that loads the module.
with open(DATA_DIR / "screening" / "sources.json", encoding="utf-8") as registry_file:
    src = json.load(registry_file)
# THE FIELD GATE IS BUILT HERE, WHERE THE REGISTRY IS READ - not at module scope, because this module's
# body IS the scan: it fetches every board below as it is imported, so the gates have to be settled
# before the first fetch and they have to come from the registry that was just opened. The note is
# printed for the same reason the other screeners print it: a gate decides what nobody ever sees, and
# "nothing in my field today" reads the same whether the field is right or the words are software's.
patterns, field_note = field_patterns(src, load_candidate_profile())
if field_note:
    print(f"# {field_note}")
# THE TITLE GATES ARE BUILT BESIDE IT, from the same registry read, for the same reason: this module's body
# IS the scan, so the vocabulary has to be settled before the first fetch. `GENERAL_SKIP_TITLE` is the words
# no field translates and `patterns.skip_title` is the field's own - the pair this file used to hold as one
# `BADLVL` regex, and the reason a nursing registry no longer has `qa|ios|devops` applied to its board.
title_gates = [GENERAL_SKIP_TITLE, *([patterns.skip_title] if patterns.skip_title else [])]
entries = []
for platform in ("greenhouse", "lever", "ashby", "workday"):
    for slug, name in (src.get(platform) or {}).items():
        entries.append({"slug": slug, "platform": platform, "name": name})
# A slug -> name map, because the display below used to read `e.get("name")` where `e` was the LEFTOVER loop variable
# from the block above. After that loop `e` is the LAST registry entry, so every board the tracker did not know about
# printed the name of whichever board happened to be added most recently. That is how K2 Space's roles were displayed as
# "Voladynamics", and how Loft Orbital's were displayed as "Prior Labs" a round earlier - and it sent me looking at the
# wrong company. The URLs were always right; only the label lied.
name_by_slug = {e["slug"].lower(): (e.get("name") or e["slug"]) for e in entries}
print("registry entries:", len(entries), "| by platform:",
      {p: len(src.get(p) or {}) for p in ("greenhouse", "lever", "ashby", "workday")})

found = []
for e in entries:
    if not isinstance(e, dict):
        continue
    slug = e.get("slug") or e.get("board") or ""
    platform = (e.get("platform") or e.get("ats") or "").lower()
    if not slug:
        continue
    low = slug.lower()
    prior = (low in seen or any(tok in low for tok in seen_tokens if len(tok) > 4)
             or f"/{low}/" in sources_blob or f"for={low}" in sources_blob)
    jobs = []
    try:
        if "greenhouse" in platform or platform == "":
            d = json.loads(urllib.request.urlopen(
                urllib.request.Request(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", headers=UA),
                timeout=20).read())
            jobs = [(j.get("title") or "", (j.get("location") or {}).get("name") or "",
                     f"https://job-boards.greenhouse.io/{slug}/jobs/{j.get('id')}") for j in d.get("jobs", [])]
        elif "ashby" in platform:
            d = json.loads(urllib.request.urlopen(
                urllib.request.Request(f"https://api.ashbyhq.com/posting-api/job-board/{slug}", headers=UA),
                timeout=20).read())
            jobs = [(j.get("title") or "", j.get("location") or "",
                     f"https://jobs.ashbyhq.com/{slug}/{j.get('id')}") for j in d.get("jobs", [])]
        elif "workday" in platform:
            # Registry form is "host|tenant|site"; the tenant is the slug the tracker matches on.
            parts = slug.split("|")
            whost, wtenant, wsite = (parts + ["", "", ""])[:3]
            if not (whost and wtenant and wsite):
                raise ValueError(f"unparseable workday key: {slug}")
            wbase = f"https://{whost}/wday/cxs/{wtenant}/{wsite}/jobs"
            jobs = []
            for wq in ("software engineer", "backend engineer", "full stack engineer"):
                woff = 0
                while woff < 100:
                    body = json.dumps({"appliedFacets": {}, "limit": 20, "offset": woff,
                                       "searchText": wq}).encode()
                    req = urllib.request.Request(wbase, data=body, headers={**UA,
                                              "Content-Type": "application/json", "Accept": "application/json"})
                    wd = json.loads(urllib.request.urlopen(req, timeout=25).read())
                    postings = (wd or {}).get("jobPostings") or []
                    if not postings:
                        break
                    for j in postings:
                        ext = (j.get("externalPath") or "").strip()
                        if not ext:
                            continue
                        jobs.append((j.get("title") or "",
                                     j.get("locationsText") or j.get("locationText") or "",
                                     f"https://{whost}/{wsite}{ext}"))
                    if len(postings) < 20:
                        break
                    woff += 20
        elif "lever" in platform:
            d = json.loads(urllib.request.urlopen(
                urllib.request.Request(f"https://api.lever.co/v0/postings/{slug}?mode=json", headers=UA),
                timeout=20).read())
            jobs = [(j.get("text") or "", ((j.get("categories") or {}).get("location") or ""),
                     j.get("hostedUrl") or "") for j in d]
    except Exception:
        continue
    for title, loc, url in jobs:
        if not patterns.field_include.search(title) or any(g.search(title) for g in title_gates):
            continue
        if NONUS.search(loc) or not US.search(loc):
            continue
        # Skip tenants the contract says not to re-apply to, by resolved company name or by slug.
        cname = (board_company.get(slug.lower()) or e.get("name") or slug or "").lower()
        if cname in DO_NOT_RETRY or (slug or "").lower() in DO_NOT_RETRY:
            continue
        found.append((slug, title[:52], loc[:28], url, prior))

print("candidates:", len(found))
fresh = [f for f in found if not f[4]]
prior = [f for f in found if f[4]]
print("fresh-company candidates:", len(fresh), "| returning-tenant candidates:", len(prior))
print("--- fresh companies")
# Print EVERY candidate, not the first twelve, and print the URL in full. Truncating both lists to [:12] hid 242 of
# 255 candidates in one scan, and url[:56] cut the requisition id off the end - the one part of the line that has to be
# copied exactly. Pipe the output through a URL-level dedupe against the tracker; this script only knows whether a
# COMPANY has appeared before, which is why it says "role-level dedupe still required".
for slug, title, loc, url, _ in fresh:
    print(f"  {(board_company.get(slug.lower()) or name_by_slug.get(slug.lower()) or slug)[:22]:24s} | {title:54s} | {loc:26s} | {url}")
print("--- returning tenants (role-level dedupe still required)")
for slug, title, loc, url, _ in prior:
    print(f"  {(board_company.get(slug.lower()) or name_by_slug.get(slug.lower()) or slug)[:22]:24s} | {title:54s} | {loc:26s} | {url}")
