#!/usr/bin/env python3
"""Daily job screen for the unattended application pipeline.

Deterministic, stdlib-only, no model use:
  1. fetch every ATS board listed in <data>/screening/sources.json
  2. filter: the applicant's own field and region (`filters` in that registry, or the
     `resume_tracks` keywords in candidate_profile.json), junior->senior (no
     intern/co-op/contract), dedupe vs applications.csv and output/seen_jobs.json,
     recency window
  3. rank by keyword fit (candidate_profile.json tracks) + level + freshness
  4. for the top --jd-top candidates, fetch the JD text and classify work
     authorization by regex: hard blocks (US citizen / clearance /
     permanent residency) are excluded, explicit no-sponsorship is
     excluded, explicit sponsorship-accepting is boosted
  5. write output/daily_YYYY-MM-DD.md + .json and update seen state

Usage:
  python3 src/screening/daily_screen.py [--days 14] [--top 3] [--jd-top 15]
                                  [--no-jd] [--validate] [--limit-sources N]
"""
from __future__ import annotations

import argparse
import pathlib
import concurrent.futures
import csv
import html as html_mod
import json
import re
import sys
# tracker_index lives beside this file; make it importable without depending on the working directory.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# The tracker read is shared with the other screeners; this file carried its own copy until 2026-10-07.
from tracker_index import load_rows  # noqa: E402
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

# ONLY THE FETCHERS AND THE NEW-GRAD SIGNAL COME FROM THE OTHER SCREENER. The field and region gates
# used to arrive here as six module constants, which is why one person's field was the only field this
# screen could search for; they are now compiled once per run by `field_patterns` - see
# `screen_newgrad_postings.field_patterns` for what each one is and what it falls back to.
from screen_newgrad_postings import (  # noqa: E402
    UA,
    as_loc,
    fetch,
    field_patterns,
    is_us,
    level_patterns,
    norm_title,
    parse_dt,
    parse_posted_on,
)
from screen_newgrad_postings import (  # noqa: E402
    INTERN_RE,
    LevelPatterns,
    NEW_GRAD_RE,
    load_candidate_profile as shared_load_candidate_profile,
    load_sources as shared_load_sources,
)

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

# THE REGISTRY IS CONFIGURATION AND LIVES WITH IT. It sat in `src/screening/`, where `ATS_DATA_DIR`
# cannot reach it and `.gitignore` does not cover it - so a hand-curated list of the boards one person
# watches shipped inside the source tree, and a second person had nowhere to keep their own. Its path
# is `screen_newgrad_postings.SOURCES_PATH`, defined there next to the screening patterns read out of
# the same file, so one path serves both screeners.
CANDIDATE_PATH = DATA_DIR / "candidate_profile.json"
TRACKER_PATH = DATA_DIR / "applications.csv"
SEEN_PATH = ROOT / "output" / "seen_jobs.json"
OUT_DIR = ROOT / "output" / "screen"

# THE WORDS A SOURCING CHANNEL SEARCHES FOR ARE A FACT ABOUT THE SEARCHER, not about the tool. They
# were two software-engineering words written here; they now come from the registry, and this is only
# the fallback for a registry that names none.
DEFAULT_WORKDAY_QUERIES = ["software engineer", "software"]
WORKDAY_PAGE = 20
WORKDAY_QUERY_CAP = 60

CONTRACT_RE = re.compile(
    r"\bcontract(ual)?\b|contractor|temp(orary)?\b|freelance|\b1099\b|per diem", re.I
)
COOP_RE = re.compile(r"co-?op\b", re.I)

# THE LEVEL VOCABULARY IS CONFIGURATION TOO, and it is a SECOND block rather than four more keys in
# `filters` - "Senior" and "Staff" are not field words - so the four patterns live beside
# `field_patterns` and arrive here through `level_patterns` (see `LevelPatterns` there for what each
# one decides). The words they shipped with spell SOFTWARE's rungs, which is what an unconfigured run
# still reads; a registry states its own under `levels` in the same file as `filters`.
#
#: What a caller gets when it passes no levels: the shipped four, compiled once. `level_of` takes the
#: vocabulary as an argument so a run cannot read one it did not pass in, and this is the argument for
#: the caller that has nothing to say about levels at all.
_SHIPPED_LEVELS = level_patterns({})

# --- work-authorization classification (regex only, run on JD text) -------

HARD_BLOCK_PATTERNS = [
    # A CLEARANCE THE APPLICANT MUST ALREADY HOLD, as against one they must be ABLE TO OBTAIN. The two read
    # the same to a keyword screen and mean opposite things to a citizen: "ability to obtain a security
    # clearance" is an open door, "active final DoD Secret clearance required" is a wall. This entry is
    # why that distinction survives the bare `\bclearance\b` further down, which exists for Rackner.
    (re.compile(r"active (?:final )?(?:dod |top secret |ts/sci )?clearance|existing clearance|"
                r"clearance (?:is |are )?required|must (?:currently )?hold .{0,24}clearance", re.I),
     "requires_active_clearance"),
    (re.compile(r"\bu\.?s\.?\s+person\b", re.I), "requires_u_s_person"),
    (re.compile(r"\bu\.?s\.?\s+citizen", re.I), "requires_u_s_citizenship"),
    (re.compile(r"citizenship (is |will be )?required", re.I), "requires_citizenship"),
    (re.compile(r"u\.?s\.? (citizens|persons) only", re.I), "requires_u_s_citizenship"),
    (re.compile(r"security clearance", re.I), "requires_clearance"),
    (re.compile(r"(must|required to|will (?:have to|need to)) (?:be |hold )?(?:a |an )?permanent resident", re.I), "requires_permanent_residency"),
    (re.compile(r"green card (is |will be )?required", re.I), "requires_green_card"),
    (re.compile(r"must (?:be|hold) (?:a )?(?:permanent resident|green card)", re.I), "requires_permanent_residency"),
]

NO_SPONSOR_PATTERNS = [
    (re.compile(r"\bno (?:visa )?sponsorship\b", re.I), "states_no_sponsorship"),
    (re.compile(r"will not sponsor", re.I), "states_no_sponsorship"),
    (re.compile(r"do(es)? not (?:provide|offer|support) (?:visa )?sponsorship", re.I), "states_no_sponsorship"),
    (re.compile(r"(?:we|our (?:company|team|firm)) (?:do|does|don't) not (?:sponsor|provide|offer)", re.I), "states_no_sponsorship"),
    # "unable to SPONSOR" ITSELF, which the entry below does not cover. Every alternative here required a verb
    # between "unable to" and the noun - provide / offer / support - and "we are unable to sponsor or take over
    # sponsorship of an employment visa" has none of them, so the pattern set had no form of the commonest way
    # this sentence is written. Measured: that exact sentence classified as `likely_accepts`, which is the wrong
    # direction to be wrong in - it says the employer WILL sponsor, about one that has just said it will not.
    (re.compile(r"(?:unable|unwilling) to sponsor|will not be able to sponsor|not (?:be )?able to sponsor", re.I),
     "states_no_sponsorship"),
    (re.compile(r"(?:unable|unwilling) to (?:provide|offer|support) (?:visa )?sponsorship", re.I), "states_no_sponsorship"),
    (re.compile(r"not (?:able|willing) to (?:provide|offer|support) (?:visa )?sponsorship", re.I), "states_no_sponsorship"),
    # "DO NOT REQUIRE SPONSORSHIP" IS A DEMAND ON THE APPLICANT, not an offer from the employer, and it had
    # no pattern at all - it came back `unclear`. The applicant it excludes is the one who does need it.
    (re.compile(r"\b(?:do(?:es)? not|must not|won't|will not|cannot) require sponsorship", re.I),
     "no_sponsorship_required"),
    # A STUDENT-STATUS BAR IS NOT THE NO-SPONSORSHIP FAMILY. "OPT / CPT / F-1 students are not eligible"
    # excludes exactly the applicant `authorized_no_sponsorship_needed` describes, so it needs its own
    # reason: mapping it onto `states_no_sponsorship` - which a TN or EAD holder MEETS - would have kept the
    # posting for the one person it is written against.
    (re.compile(r"\bopt\b.{0,40}\bnot\s+eligible", re.I), "opt_not_eligible"),
    (re.compile(r"\bcpt\b.{0,40}\bnot\s+eligible", re.I), "cpt_not_eligible"),
    (re.compile(r"\bf-1\b.{0,40}\bnot\s+eligible", re.I), "f1_not_eligible"),
    (re.compile(r"without (?:the (?:need|requirement) for) (?:visa )?sponsorship", re.I), "no_sponsorship_required"),
    (re.compile(r"(?:not|no) (?:available|offered|provided|supported) (?:visa )?sponsorship", re.I), "states_no_sponsorship"),
    # `(?:not|un)available` MATCHED "notavailable". The alternation ran straight into the word, so the
    # pattern only ever fired on the ONE-WORD spelling - "sponsorship is unavailable" - and never on
    # "sponsorship is not available", which is how the sentence is normally written. A space in the
    # alternation is the whole fix. Found by a test that listed the wordings instead of trusting the list.
    # A NEGATION IS REQUIRED BEFORE THE VERB, or this matches the sentence that says the opposite. Two forms,
     # because "unavailable" fuses its negation and the rest do not:
    (re.compile(r"sponsorship (?:is|will be) (?:not |no longer |never )"
                r"(?:available|offered|provided|supported|possible)", re.I), "states_no_sponsorship"),
    (re.compile(r"sponsorship (?:is|will be) unavailable", re.I), "states_no_sponsorship"),
    (re.compile(r"not (?:eligible|open) (?:for|to) (?:visa )?sponsorship", re.I), "states_no_sponsorship"),
]

SPONSOR_OK_PATTERNS = [
    (re.compile(r"will (?:be able to|be willing to|gladly|certainly) sponsor", re.I), "will_sponsor"),
    (re.compile(r"visa sponsorship (?:is|will be) (?:available|provided|offered|supported|welcome)", re.I), "sponsorship_available"),
    (re.compile(r"sponsorship (?:is|will be) (?:available|provided|offered|supported|welcome)", re.I), "sponsorship_available"),
    (re.compile(r"open to (?:visa |h-?1b )?sponsorship", re.I), "open_to_sponsorship"),
    (re.compile(r"(?:we|we're|our team|the company) (?:will|can) (?:provide|offer|support) (?:visa |h-?1b )?sponsorship", re.I), "will_sponsor"),
    (re.compile(r"can (?:provide|offer) (?:visa |h-?1b )?sponsorship", re.I), "will_sponsor"),
    (re.compile(r"(?:visa |h-?1b )?sponsorship (?:is|will be) (?:encouraged|welcomed)", re.I), "sponsorship_available"),
    (re.compile(r"h-?1b (?:visa )?sponsorship", re.I), "h1b_sponsorship"),
    (re.compile(r"(?:will|can) (?:support|process|handle) (?:your |an? |their )?(?:h-?1b|visa) (?:sponsorship|transfer)", re.I), "will_sponsor"),
]

SPONSOR_WEAK_PATTERNS = [
    (re.compile(r"\bopt\b", re.I), "mentions_opt"),
    (re.compile(r"\bcpt\b", re.I), "mentions_cpt"),
    (re.compile(r"\bf-?1\b", re.I), "mentions_f1"),
    (re.compile(r"\bh-?1b\b", re.I), "mentions_h1b"),
    (re.compile(r"\bvisa\b", re.I), "mentions_visa"),
]

JD_TEXT_CAP = 120_000


def load_sources() -> dict:
    """The registry, through the shared reader - see `screen_newgrad_postings.load_sources`."""
    return shared_load_sources()


def load_tracks() -> dict:
    """The applicant's own field descriptions, one keyword list per resume track.

    These are what the field gate is built from when the registry names no `field_include`: the words
    that describe the applicant's field are already in their profile, and the screen used to ignore
    them in favour of a software-engineering pattern.
    """
    return (shared_load_candidate_profile().get("resume_tracks") or {})


def load_applicant_status() -> str:
    """`candidate.standard_answers.work_authorization`, or "" when the profile does not state one.

    Read defensively and lazily: this screen runs unattended, and a missing or malformed profile must
    make the screening MORE conservative - keep everything, filter nothing - never less.
    """
    try:
        answers = ((json.loads(CANDIDATE_PATH.read_text(encoding="utf-8")).get("candidate") or {})
                   .get("standard_answers") or {})
    except Exception:  # noqa: BLE001 -- an unreadable profile must not stop a scan
        return ""
    return str(answers.get("work_authorization") or "").strip()


def load_tracker_rows() -> list[dict]:
    """The tracker rows, or [] when the file is absent.

    The read delegates to the shared module; the existence check stays, because this screen runs
    unattended and a missing tracker must not be an error."""
    if not TRACKER_PATH.exists():
        return []
    return load_rows(TRACKER_PATH)


def load_seen() -> dict:
    if SEEN_PATH.exists():
        try:
            return json.loads(SEEN_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_seen(seen: dict) -> None:
    cap = 4000
    if len(seen) > cap:
        items = sorted(seen.items(), key=lambda kv: kv[1].get("first_seen", ""))
        seen = dict(items[-cap:])
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SEEN_PATH.with_name(SEEN_PATH.name + ".tmp")
    tmp.write_text(json.dumps(seen, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(SEEN_PATH)


def board_workday(key: str, name: str, queries: list[str] | None = None):
    host, tenant, site = key.split("|")
    base = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    seen_ids: set[str] = set()
    out: list[dict] = []
    # The search words are an argument. This used to read a module global named `sources` that only a
    # different function ever assigned, so a Workday board raised NameError unless that other function
    # had run first in the same process - configuration reached the fetcher by accident or not at all.
    for q in (queries or DEFAULT_WORKDAY_QUERIES):
        offset = 0
        for _ in range(WORKDAY_QUERY_CAP // WORKDAY_PAGE):
            data = fetch(base, payload={"appliedFacets": {}, "limit": WORKDAY_PAGE,
                                        "offset": offset, "searchText": q})
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(f"workday error: {data['error']}")
            jobs = (data or {}).get("jobPostings") or []
            if not jobs:
                break
            for j in jobs:
                ext = (j.get("externalPath") or "").strip()
                jid = ext or str(j.get("id") or "")
                if not jid or jid in seen_ids:
                    continue
                seen_ids.add(jid)
                out.append({
                    "company": name,
                    "title": j.get("title", ""),
                    "location": j.get("locationsText") or j.get("locationText") or "",
                    "url": (f"https://{host}/{site}{ext}" if ext.startswith("/") else ""),
                    "platform": "workday",
                    "posted": parse_posted_on(j.get("postedOn")),
                    "extra": " / ".join(j.get("bulletFields") or [])[:80],
                })
            if len(jobs) < WORKDAY_PAGE:
                break
            offset += WORKDAY_PAGE
    return out


def board_generic(platform: str, key: str, name: str) -> list[dict]:
    if platform == "greenhouse":
        data = fetch(f"https://boards-api.greenhouse.io/v1/boards/{key}/jobs")
        return [{
            "company": name,
            "title": j.get("title", ""),
            "location": as_loc(j.get("location")),
            # canonical job-board URL (not the company's absolute_url, which may
            # be a custom proxy like careerpuck that the pipeline can't detect)
            "url": f"https://job-boards.greenhouse.io/{key}/jobs/{j.get('id', '')}",
            "gh_id": str(j.get("id", "")),
            "platform": "greenhouse",
            "posted": parse_dt(j.get("first_published") or j.get("updated_at")),
            "extra": j.get("department") or "",
        } for j in data.get("jobs", [])]
    if platform == "lever":
        data = fetch(f"https://api.lever.co/v0/postings/{key}?mode=json")
        out = []
        for j in data if isinstance(data, list) else []:
            locs = [as_loc(j.get("location"))]
            for al in j.get("allLocations") or []:
                locs.append(as_loc(al))
            out.append({
                "company": name,
                "title": j.get("text", ""),
                "location": "; ".join(x for x in locs if x),
                "url": j.get("hostedUrl", ""),
                "platform": "lever",
                "posted": parse_dt(j.get("created")),
                "extra": " / ".join(j.get("categories") or [])[:80],
            })
        return out
    if platform == "ashby":
        data = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{key}?includeCompensation=false")
        out = []
        for j in data.get("jobs", []):
            if j.get("isListed") is False:
                continue
            locs = [as_loc(j.get("location"))]
            for s in j.get("secondaryLocations") or []:
                if isinstance(s, dict):
                    locs.append(as_loc(s.get("location")))
            jid = j.get("id") or ""
            out.append({
                "company": name,
                "title": j.get("title", ""),
                "location": "; ".join(x for x in locs if x),
                "url": j.get("jobUrl") or (f"https://jobs.ashbyhq.com/{key}/{jid}" if jid else ""),
                "platform": "ashby",
                "posted": parse_dt(j.get("publishedAt")),
                "extra": j.get("department") or "",
                "jd_text": (j.get("descriptionPlain") or "")[:JD_TEXT_CAP],
            })
        return out
    if platform == "workable":
        data = fetch(f"https://apply.workable.com/api/v1/accounts/{key}/jobs")
        return [{
            "company": name,
            "title": j.get("title", ""),
            "location": as_loc(j.get("location")),
            "url": j.get("url") or "",
            "platform": "workable",
            "posted": parse_dt(j.get("published_at")),
            "extra": j.get("department") or "",
        } for j in data.get("jobs", [])]
    if platform == "smartrecruiters":
        data = fetch(f"https://api.smartrecruiters.com/{key}/jobs?limit=100")
        out = []
        for j in data.get("data", []):
            locs = j.get("locations") or []
            loc = ""
            if locs and isinstance(locs[0], dict):
                l = locs[0]
                loc = ", ".join(x for x in [l.get("city"), l.get("state"), l.get("country")] if x)
            out.append({
                "company": name,
                "title": j.get("title", ""),
                "location": loc,
                "url": j.get("url", ""),
                "platform": "smartrecruiters",
                "posted": parse_dt(j.get("publishedAt")),
                "extra": ", ".join(j.get("categories") or [])[:80],
            })
        return out
    raise ValueError(f"unknown platform: {platform}")


def build_tasks(sources: dict, limit: int = 0) -> list[tuple[str, str]]:
    tasks: list[tuple[str, str]] = []
    for platform in ("greenhouse", "lever", "ashby", "workable", "smartrecruiters"):
        for key, name in (sources.get(platform) or {}).items():
            tasks.append((platform, f"{key}={name}"))
    for key, name in (sources.get("workday") or {}).items():
        tasks.append(("workday", f"{key}={name}"))
    if limit:
        tasks = tasks[:limit]
    return tasks


def source_jobs_from(tasks: list[tuple[str, str]],
                     queries: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """Fetch a list of sources in parallel. Returns (jobs, source_report).

    `queries` are the registry's Workday search words, passed down to the one fetcher that uses them
    rather than read from a global.
    """
    jobs: list[dict] = []
    report: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {}
        for platform, label in tasks:
            key, name = label.split("=", 1)
            if platform == "workday":
                futs[pool.submit(board_workday, key, name, queries)] = (platform, label)
            else:
                futs[pool.submit(board_generic, platform, key, name)] = (platform, label)
        for fut in concurrent.futures.as_completed(futs):
            platform, label = futs[fut]
            try:
                batch = fut.result()
                jobs.extend(batch)
                report.append({"source": label, "ok": True, "count": len(batch), "platform": platform})
            except Exception as exc:  # noqa: BLE001 - per-source isolation
                report.append({"source": label, "ok": False, "error": str(exc)[:200]})
    # Boards throttled into an empty 200 (common on Greenhouse under
    # concurrent load) are retried serially with backoff until they return
    # jobs or the retry budget is exhausted.
    for wait in (3, 10, 25):
        empties = [r for r in report if r["ok"] and r["count"] == 0]
        if not empties:
            break
        time.sleep(wait)
        for r in empties:
            platform = r["platform"]
            key, name = r["source"].split("=", 1)
            try:
                if platform == "workday":
                    batch = board_workday(key, name, queries)
                else:
                    batch = board_generic(platform, key, name)
            except Exception:  # noqa: BLE001 - keep the empty result
                continue
            jobs.extend(batch)
            r["count"] = len(batch)
    return jobs, report


def dedupe_key(job: dict) -> str:
    # Greenhouse job ids are globally unique and stable across a company's
    # custom career domains (careers.roblox.com, careerpuck, ...), so key on
    # the id instead of the URL to survive URL-format changes.
    if job.get("platform") == "greenhouse" and job.get("gh_id"):
        return f"gh:{job['gh_id']}"
    return job["url"].rstrip("/").lower()


def level_of(title: str, extra: str, levels: LevelPatterns | None = None) -> str:
    """Which rung a posting's title (and department) names, or `unknown` when none is named.

    `unknown` is not an error - plenty of postings are titled without one - but it is also what every
    posting in a field whose rungs are not configured comes back as, which is why the vocabulary is
    passed in rather than read from module state: one call site reads a nursing registry's levels and
    another the shipped software ones, from the same helper.
    """
    levels = levels or _SHIPPED_LEVELS
    t = f"{title} {extra}"
    if INTERN_RE.search(t) or COOP_RE.search(t):
        return "intern"
    if CONTRACT_RE.search(t):
        return "contract"
    if NEW_GRAD_RE.search(t):
        return "new_grad"
    if levels.senior.search(t):
        return "senior"
    if levels.mid.search(t):
        return "mid"
    if levels.junior.search(t):
        return "junior"
    return "unknown"


def fit_scores(text: str, tracks: dict) -> tuple[dict, dict]:
    low = text.lower()
    scores: dict[str, int] = {}
    hits: dict[str, list[str]] = {}
    for key, track in tracks.items():
        matched = []
        for kw in track.get("keywords") or []:
            if re.search(rf"\b{re.escape(kw.lower())}\b", low):
                matched.append(kw)
        scores[key] = len(matched)
        if matched:
            hits[key] = matched
    return scores, hits


def fetch_jd_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(
        url,
        headers=dict(UA, Accept="text/html,application/xhtml+xml,*/*;q=0.8"),
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    text = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", raw)
    text = re.sub(r"(?is)</(p|div|li|h[1-6]|tr)>|<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)<.*?>", " ", text)
    text = re.sub(r"\s+", " ", html_mod.unescape(text))
    return text[:JD_TEXT_CAP]



# --------------------------------------------------------------------------- who the applicant is
#
# A REQUIREMENT IS ONLY A BAR FOR SOMEONE WHO CANNOT MEET IT. "Must be a U.S. citizen" is a wall for a
# candidate on a student visa and an open door for a citizen; "we are unable to sponsor" is a wall for one
# and irrelevant to a green-card holder. What a posting DEMANDS is a fact about the posting and stays in
# the patterns above. Whether it disqualifies is a fact about the APPLICANT, and only that belongs here.

#: Which applicant statuses can meet each requirement the patterns above detect.
REQUIREMENT_MET_BY: dict[str, frozenset] = {
    "requires_u_s_citizenship": frozenset({"us_citizen"}),
    "requires_citizenship": frozenset({"us_citizen"}),
    "requires_u_s_person": frozenset({"us_citizen", "permanent_resident"}),
    "requires_permanent_residency": frozenset({"us_citizen", "permanent_resident"}),
    "requires_green_card": frozenset({"us_citizen", "permanent_resident"}),
    # Citizenship is what one OBTAINS a clearance with; nothing supplies one already held.
    "requires_clearance": frozenset({"us_citizen"}),
    "requires_active_clearance": frozenset(),
    "states_no_sponsorship": frozenset({"us_citizen", "permanent_resident",
                                        "authorized_no_sponsorship_needed"}),
    # `without the need for sponsorship` - "must be able to work without sponsorship", which is a demand on
    # the APPLICANT and a bar for one who needs it. The name reads like the good direction and the sentence
    # is the bad one, so it is spelled out here rather than inferred from the name.
    "no_sponsorship_required": frozenset({"us_citizen", "permanent_resident",
                                          "authorized_no_sponsorship_needed"}),
    # A STUDENT-STATUS BAR EXCLUDES THE STUDENT-STATUS APPLICANT SPECIFICALLY, so it is met by the two
    # statuses that are not one. It is NOT a bar for someone who needs sponsorship - an H-1B transfer
    # candidate is not on OPT either.
    "opt_not_eligible": frozenset({"us_citizen", "permanent_resident"}),
    "cpt_not_eligible": frozenset({"us_citizen", "permanent_resident"}),
    "f1_not_eligible": frozenset({"us_citizen", "permanent_resident"}),
}

#: The values `candidate.standard_answers.work_authorization` may take. Anything else is "not stated".
APPLICANT_STATUSES = ("us_citizen", "permanent_resident", "authorized_no_sponsorship_needed",
                      "requires_sponsorship")


def requirement_applies(reason: str, applicant: str | None) -> bool:
    """Is this posting's requirement a bar for THIS applicant?

    AN UNSTATED OR UNRECOGNISED STATUS FILTERS NOTHING. Every posting is kept and its requirement is
    reported instead, because the two mistakes are not symmetric: a posting wrongly dropped is invisible
    and cannot be recovered by reading harder, while a posting wrongly kept costs one reading before it is
    set aside. A caller that passes nothing gets today's screening with nothing removed.
    """
    if applicant not in APPLICANT_STATUSES:
        return False
    met = REQUIREMENT_MET_BY.get(reason)
    if met is None:
        return True  # an unrecognised reason is treated as a bar, and named in the report
    return applicant not in met


def classify_auth(text: str) -> tuple[str, str]:
    """Returns (status, evidence). status in
    {hard_block, no_sponsorship, accepts, likely_accepts, unclear}."""
    for rx, reason in HARD_BLOCK_PATTERNS:
        m = rx.search(text)
        if m:
            return "hard_block", reason
    for rx, reason in NO_SPONSOR_PATTERNS:
        m = rx.search(text)
        if m:
            return "no_sponsorship", reason
    for rx, reason in SPONSOR_OK_PATTERNS:
        m = rx.search(text)
        if m:
            return "accepts", reason
    for rx, reason in SPONSOR_WEAK_PATTERNS:
        m = rx.search(text)
        if m:
            return "likely_accepts", reason
    return "unclear", ""


def rank_score(level: str, sponsorship: str, best_fit: int, posted, now) -> int:
    score = best_fit
    score += {"new_grad": 4, "junior": 3, "mid": 2, "senior": 1}.get(level, 0)
    if sponsorship == "accepts":
        score += 15
    elif sponsorship == "likely_accepts":
        score += 5
    if posted:
        age = (now - posted).days
        if age <= 3:
            score += 3
        elif age <= 7:
            score += 2
        elif age <= 14:
            score += 1
    return score


def screen(args) -> dict:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)
    sources = load_sources()
    tracks = load_tracks()
    seen = load_seen()
    tracker_rows = load_tracker_rows()
    # The field and region gates, compiled once for the run from the registry and the profile. This
    # screen runs unattended, so when neither names a field the fallback is reported rather than
    # silently applied - see `field_patterns`.
    patterns, field_note = field_patterns(sources, {"resume_tracks": tracks})
    if field_note:
        print(f"# {field_note}")
    # The level vocabulary, compiled once for the run from the same registry. It is a separate
    # question from the field gate - see `LevelPatterns` - and a registry that states its field and
    # not its levels is read with software's rungs, which shows up as `level: unknown` on its own
    # postings rather than as a silent change to what is kept.
    levels = level_patterns(sources)
    # failed/incomplete attempts may resurface and be retried; everything else
    # (submitted, in-flight, awaiting user) stays blocked
    _non_blocking = {"", "not_prepared", "fill_failed", "posting_not_found"}
    active_rows = [r for r in tracker_rows
                   if r.get("status", "") not in _non_blocking]
    tracker_urls = {r.get("source", "").rstrip("/").lower() for r in active_rows if r.get("source")}
    tracker_ct = {norm_title(r.get("company", "")) + norm_title(r.get("title", "")) for r in active_rows}
    # failed attempts (not_prepared) bypass the seen guard so they resurface
    # and get retried on the next run
    retry_keys: set[str] = set()
    for r in tracker_rows:
        if r.get("status") == "not_prepared" and r.get("source"):
            src = r["source"].rstrip("/").lower()
            retry_keys.add(src)
            m = re.search(r"gh_jid=(\d+)", src)
            if m:
                retry_keys.add(f"gh:{m.group(1)}")

    jobs, source_report = source_jobs_from(build_tasks(sources, args.limit_sources),
                                           sources.get("queries") or None)

    excluded: dict[str, int] = {}
    candidates: list[dict] = []
    seen_now = now.date().isoformat()
    run_urls: set[str] = set()
    run_ct: set[str] = set()
    jd_cache: dict[str, str] = {}
    for job in jobs:
        title = job.get("title") or ""
        loc = job.get("location") or ""
        extra = job.get("extra") or ""
        if not job.get("url"):
            excluded["no_url"] = excluded.get("no_url", 0) + 1
            continue
        if (not patterns.field_include.search(title)
                or (patterns.field_exclude and patterns.field_exclude.search(title))
                or (patterns.title_topics_exclude and patterns.title_topics_exclude.search(title))):
            excluded["not_engineering"] = excluded.get("not_engineering", 0) + 1
            continue
        level = level_of(title, extra, levels)
        if level in ("intern", "contract"):
            excluded[level] = excluded.get(level, 0) + 1
            continue
        if levels.management.search(title):
            excluded["management"] = excluded.get("management", 0) + 1
            continue
        us = is_us(loc, patterns)
        if us is None:
            # The title is the second place a region can be written. It is consulted only when the
            # location field does not say, because most multi-region boards list one location per
            # posting and a title that names another country is usually the region the role is really
            # in. `None` is a registry with no region gate at all - an absent pattern is not a gate.
            title_region = patterns.title_region_exclude
            if title_region and (title_region.search(title) or title_region.search(loc)):
                excluded["not_us"] = excluded.get("not_us", 0) + 1
                continue
            us_flag = "unknown"
        elif us:
            us_flag = "us"
        else:
            excluded["not_us"] = excluded.get("not_us", 0) + 1
            continue
        posted = job.get("posted")
        if posted and posted < cutoff:
            excluded["stale"] = excluded.get("stale", 0) + 1
            continue
        url_key = dedupe_key(job)
        ct_key = norm_title(job["company"]) + norm_title(title)
        if url_key in run_urls or ct_key in run_ct:
            excluded["duplicate_in_run"] = excluded.get("duplicate_in_run", 0) + 1
            continue
        if url_key in tracker_urls or ct_key in tracker_ct:
            excluded["already_tracked"] = excluded.get("already_tracked", 0) + 1
            continue
        if url_key in seen and url_key not in retry_keys:
            excluded["already_seen"] = excluded.get("already_seen", 0) + 1
            continue
        run_urls.add(url_key)
        run_ct.add(ct_key)
        # remember every basic-passing job so it does not resurface tomorrow
        seen.setdefault(url_key, {"first_seen": seen_now,
                                  "company": job["company"], "title": title})
        text = f"{job['company']} {title} {extra}"
        scores, hits = fit_scores(text, tracks)
        best_track, best_fit = (max(scores.items(), key=lambda kv: kv[1])
                                if scores else ("", 0))
        if job.get("jd_text"):
            jd_cache[url_key] = job["jd_text"]
        job.pop("jd_text", None)  # kept out of the serialized report
        candidates.append({
            **job,
            "level": level,
            "us_flag": us_flag,
            "posted_iso": posted.isoformat() if posted else None,
            "fit": scores,
            "best_track": best_track,
            "best_fit": best_fit,
            "matched": hits.get(best_track, [])[:8] if best_track else [],
            "sponsorship": "unclear",
            "sponsor_evidence": "",
            "jd_fetched": False,
            "rank": 0,
        })

    # preliminary ranking to decide who gets a JD deep-dive
    candidates.sort(
        key=lambda c: (c["best_fit"], c["posted_iso"] or ""),
        reverse=True,
    )
    applicant = load_applicant_status()
    kept_by_status = 0
    jd_pool = candidates[: args.jd_top]
    for c in jd_pool:
        try:
            text = jd_cache.get(dedupe_key(c)) or fetch_jd_text(c["url"])
            status, evidence = classify_auth(f"{c['title']} {c['extra']} {text}")
            c["sponsorship"] = status
            c["sponsor_evidence"] = evidence
            c["jd_fetched"] = True
            c["jd_text"] = text
            if status in ("hard_block", "no_sponsorship"):
                # THE POSTING ASKS FOR SOMETHING. Whether that disqualifies is the applicant's fact, not
                # the posting's - see `requirement_applies`. A posting kept for this reason carries the
                # requirement so the report can name it and the reader can check the wording.
                if requirement_applies(evidence, applicant):
                    c["excluded_reason"] = status
                    excluded[status] = excluded.get(status, 0) + 1
                else:
                    c["requirement_noted"] = evidence or status
                    kept_by_status += 1
        except Exception:  # noqa: BLE001 - JD fetch failure is non-fatal
            c["jd_fetch_error"] = True
    survivors = [c for c in candidates if "excluded_reason" not in c]

    for c in survivors:
        c["rank"] = rank_score(c["level"], c["sponsorship"], c["best_fit"],
                               c.get("posted"), now)
    survivors.sort(key=lambda c: (c["rank"], c["best_fit"], c["posted_iso"] or ""),
                   reverse=True)
    for i, c in enumerate(survivors):
        c["rank"] = i + 1
        c.pop("posted", None)  # datetime; posted_iso carries the value

    # keep JD text only on the top entries (for the model profile step);
    # it stays out of the report body and out of "others"
    top_list = survivors[: args.top]
    for c in top_list:
        if c.get("jd_text"):
            c["jd_text"] = c["jd_text"][:6000]
    for c in survivors[args.top:]:
        c.pop("jd_text", None)

    save_seen(seen)
    # THE ZONE DECIDES THE FILENAME'S DATE, so it has to be the runner's. A run at 01:00 in Sydney
    # filed its results under the previous day. See the registry's `timezone`.
    date_str = datetime.now(ZoneInfo(sources.get("timezone") or "UTC")).date().isoformat()
    result = {
        "date": date_str,
        "scanned": {
            "sources_total": len(source_report),
            "sources_ok": sum(1 for s in source_report if s["ok"]),
            "sources_failed": [s for s in source_report if not s["ok"]],
            "jobs_total": len(jobs),
        },
        "excluded": excluded,
        "kept_by_status": kept_by_status,
        # Carried in the file as well as printed, because this screen runs unattended: when nothing
        # configured a field, the note is the only record that today's `not_engineering` count was a
        # default speaking rather than the searcher's own choice.
        "field_note": field_note,
        "top": top_list,
        "others": survivors[args.top: args.top + 25],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.joinpath(f"daily_{date_str}.json").write_text(
        json.dumps(result, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    write_report(result, source_report)
    return result


def write_report(result: dict, source_report: list[dict]) -> None:
    date = result["date"]
    lines = [f"# Daily Job Screen — {date}", ""]
    s = result["scanned"]
    lines.append(
        f"Scanned {s['sources_ok']}/{s['sources_total']} sources, {s['jobs_total']} jobs. "
        f"New candidates: {len(result['top']) + len(result['others'])} "
        f"(top {len(result['top'])} below)."
    )
    ex = result["excluded"]
    if ex:
        lines.append("Excluded: " + ", ".join(f"{k} {v}" for k, v in sorted(ex.items())))
    if result.get("kept_by_status"):
        # NAMED, NOT SILENT. These are postings that a screening with the old assumption would have
        # dropped: they state a work-authorisation requirement the configured applicant can meet.
        lines.append(f"Kept despite a stated requirement (not a bar for this applicant's work "
                     f"authorization): {result['kept_by_status']}")
    lines.append("")
    lines.append("## Top picks")
    for c in result["top"]:
        posted = (c.get("posted_iso") or "unknown")[:10]
        lines.append(f"### {c['rank']}. {c['company']} — {c['title']}")
        lines.append(f"- level: {c['level']} | loc: {c['location'] or 'unknown'} | posted: {posted} | {c['platform']}")
        lines.append(f"- sponsorship: {c['sponsorship']}"
                     + (f" ({c['sponsor_evidence']})" if c.get("sponsor_evidence") else "")
                     + (" - requires it, and this applicant meets it"
                        if c.get("requirement_noted") else ""))
        fit = ", ".join(f"{k} {v}" for k, v in sorted(c["fit"].items(), key=lambda kv: -kv[1]) if v)
        lines.append(f"- fit: {fit or 'no track match'}"
                     + (f" | matched: {', '.join(c['matched'])}" if c.get("matched") else ""))
        lines.append(f"- {c['url']}")
        lines.append("")
    if result["others"]:
        lines.append("## Other new candidates")
        lines.append("| # | Company | Title | Level | Loc | Posted | Sponsorship | Fit |")
        lines.append("|---|---------|-------|-------|-----|--------|-------------|-----|")
        for c in result["others"]:
            posted = (c.get("posted_iso") or "?")[:10]
            best = max(c["fit"].values()) if c["fit"] else 0
            loc = (c["location"] or "?")[:30]
            title = c["title"][:48]
            lines.append(
                f"| {c['rank']} | {c['company']} | {title} | {c['level']} | {loc} "
                f"| {posted} | {c['sponsorship']} | {best} |")
        lines.append("")
    failed = [sr for sr in source_report if not sr["ok"]]
    if failed:
        lines.append("## Failed sources")
        for sr in failed:
            lines.append(f"- {sr['source']}: {sr.get('error', '?')[:120]}")
        lines.append("")
    OUT_DIR.joinpath(f"daily_{date}.md").write_text("\n".join(lines), encoding="utf-8")


def validate(args) -> int:
    sources = load_sources()
    jobs, report = source_jobs_from(build_tasks(sources), sources.get("queries") or None)
    ok = sum(1 for r in report if r["ok"])
    print(f"sources ok: {ok}/{len(report)}, jobs fetched: {len(jobs)}")
    for r in report:
        if not r["ok"]:
            print(f"  FAIL {r['source']}: {r.get('error', '?')[:120]}")
    empty = [r["source"] for r in report if r["ok"] and r["count"] == 0]
    if empty:
        print(f"  empty boards ({len(empty)}): {', '.join(empty)}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--days", type=int, default=14, help="recency window (default 14)")
    p.add_argument("--top", type=int, default=3, help="number of top picks (default 3)")
    p.add_argument("--jd-top", type=int, default=15,
                   help="how many top candidates get a JD fetch (default 15)")
    p.add_argument("--no-jd", action="store_true",
                   help="skip JD fetch / sponsorship classification")
    p.add_argument("--validate", action="store_true",
                   help="only probe sources, report health, do not screen")
    p.add_argument("--limit-sources", type=int, default=0,
                   help="test: only fetch first N sources")
    args = p.parse_args()
    if args.no_jd:
        args.jd_top = 0
    if args.validate:
        return validate(args)
    result = screen(args)
    s = result["scanned"]
    print(f"sources ok {s['sources_ok']}/{s['sources_total']}, jobs {s['jobs_total']}")
    print(f"new candidates: {len(result['top']) + len(result['others'])}")
    for c in result["top"]:
        print(f"  {c['rank']}. {c['company']} — {c['title']} "
              f"({c['level']}, {c['sponsorship']}, fit {c['best_fit']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
