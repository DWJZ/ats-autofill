#!/usr/bin/env python3
"""harvest_board_slugs.py — widen the board registry by harvesting real slugs from HN "Who is hiring" threads.

WHY THIS EXISTS. `scan_registry_fresh.py` can only find fresh companies whose boards are already in the registry, and
the registry had drifted to 60 boards that all belonged to companies already applied to - so a scan reported ZERO
fresh-company candidates and the objective's "new company, lower-seniority" cases never surfaced. This makes the
registry self-widening instead of something that has to be hand-expanded.

A HARVEST CAN LOOK SUCCESSFUL AND YIELD NOTHING. HN's Algolia API returns HTML-ENTITY-ENCODED URLs, so a
comment reads `jobs.ashbyhq.com/&amp;hellip;`-style rather than as a plain slug: one harvest returned 1253 hits
all containing the term and ZERO slugs. Decode the entities before extracting a slug, and treat a
hundreds-of-hits-zero-slugs result as that bug rather than as an empty market.

OTHER SOURCES, AND WHAT THEY ARE WORTH. The HN Algolia trick was written for ONE ATS, but hiring comments link
Greenhouse, Lever, SmartRecruiters and Workable just as often - `data/scratch/harvest_multi_ats.py` extracts all
five shapes from a thread and diffs against the tracker, so the "exhausted" pool was really a fifth of itself.
And four aggregators that look like a wider net are worth nothing: RemoteOK, Remotive, Arbeitnow and one more
return clean JSON whose payloads AND detail pages contain ZERO greenhouse/lever/ashby URLs. **They proxy the
apply link**, so no record they return can ever yield a board slug. Do not retry them.

RULE 9 COMPLIANCE. docs/RULES.md (rule 9) says to harvest real board slugs from search and never guess them, and to verify a posting
is live before using it. So every slug here comes from a company's own link in a hiring thread, and every slug is then
verified by fetching its own board API. Slugs that answer with an error are dropped; slugs that answer with zero jobs
are kept, because an empty board is a real company that will post later.

TWO MISTAKES THIS TOOL IS BUILT TO AVOID, both made by hand first:
  - Algolia's /search endpoint sorts by relevance, so a "who is hiring" query returns threads from 2015-2020 full of
    defunct companies. This uses /search_by_date and takes the NEWEST threads.
  - Lever's API returns a bare list, not an object, so a probe written like the Greenhouse one crashes on it.

USAGE
  .venv/bin/python3 src/screening/harvest_board_slugs.py            # newest 4 threads, verify, merge
  .venv/bin/python3 src/screening/harvest_board_slugs.py --threads 8 --dry-run
"""
import argparse
import csv
import html
import json
import pathlib
import re
import sys

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from tracker_index import load_rows  # noqa: E402
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# THE REGISTRY IS CONFIGURATION AND LIVES IN THE DATA DIRECTORY - it was
# `src/screening/daily_sources.json` until it moved, and this module kept opening the old path.
from src.paths import DATA_DIR  # noqa: E402
UA = {"User-Agent": "Mozilla/5.0"}

PATS = {
    "greenhouse": r"(?:job-boards|boards)\.greenhouse\.io/([A-Za-z0-9][A-Za-z0-9._-]{1,40})",
    "lever": r"jobs\.lever\.co/([A-Za-z0-9][A-Za-z0-9._-]{1,40})",
    "ashby": r"jobs\.ashbyhq\.com/([A-Za-z0-9][A-Za-z0-9._-]{1,40})",
}

BOARD_API = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
    "lever": "https://api.lever.co/v0/postings/{slug}?mode=json",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{slug}",
}

SKIP = {"jobs", "embed", "api", "v1", "boards", "job-boards", "www", "job"}

# Boards that belong to JOB AGGREGATORS rather than to an employer. Applying through one sends the application to the
# aggregator, not to the company hiring, and its board carries thousands of rebroadcast postings that would swamp the scan.
AGGREGATOR_SLUGS = {
    "jobgether", "yubhub", "applytop", "remoteleaf", "wellfound", "jobgether", "himalayas", "remotework",
    "jobsglitch", "remotebackendjobs", "zerotaxjobs", "workway", "employbl", "getro", "startupjoblist",
    "aidevboard", "jobpin", "itjobswatch", "remowork", "cloudshalla", "wearedevelopers", "jobsnwork",
}


def get(url: str) -> str:
    """RAW fetch - for JSON APIs. Do NOT unescape here: html.unescape mangled the Algolia JSON and json.loads died at
    char 14083. Unescaping is an HTML concern, not a transport concern."""
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")


def get_html(url: str) -> str:
    """Unescaped fetch - for HN pages only.

    HN hex-escapes every slash in a posted URL, so the page really contains
    "&#x2F;job-boards.greenhouse.io&#x2F;wikimedia&#x2F;jobs" and a regex looking for a normal URL matches NOTHING. The
    first, inline version of this harvest had html.unescape; rewriting it into this file dropped that line, and the run
    then reported zero slugs across five threads - the exact "a rewrite silently lost a proven detail" failure.
    Measured on the September 2026 thread: raw gives 0 greenhouse / 0 lever / 0 ashby, unescaped gives 7 / 3 / 32.
    """
    return html.unescape(get(url))


CC_PREFIX = {
    "greenhouse": "job-boards.greenhouse.io/*",
    "lever": "jobs.lever.co/*",
    "ashby": "jobs.ashbyhq.com/*",
}


# The gateway repeatedly serves a few hundred records in one response and drops the connection on a few thousand, so a
# larger request is CHUNKED rather than sent as one enormous query (measured: 900 served, 2,200 dropped).
CC_PAGE_CAP = 900
CC_INDEX_FALLBACK = "CC-MAIN-2026-39"


def cc_index_id() -> str:
    """Newest Common Crawl index, e.g. CC-MAIN-2026-39. Read live, and RETRIED: this fetch used to have no try at all,
    so a single dropped connection aborted the whole harvest (2026-10-05)."""
    last = ""
    for _ in range(3):
        try:
            info = json.loads(get("https://index.commoncrawl.org/collinfo.json"))
            return info[0]["id"]
        except Exception as exc:  # noqa: BLE001
            last = str(exc)[:60]
    # A known-good index id from the last successful read. collinfo is the source of truth; this only keeps the harvest
    # usable while their gateway is refusing requests (which it did on 2026-10-05).
    print(f"  cc: collinfo unavailable ({last}); falling back to the last known index id {CC_INDEX_FALLBACK}")
    return CC_INDEX_FALLBACK


def cc_urls(prefix: str, limit: int = 300, tries: int = 3) -> list[str]:
    """Real URLs under an ATS host prefix, straight from the Common Crawl index.

    The index takes one URL-prefix query and streams newline-delimited JSON. Lever's prefix intermittently answers 504,
    so it is retried; a failure returns fewer URLs rather than aborting the whole harvest.
    """
    import urllib.parse
    idx = cc_index_id()
    collected: list[str] = []
    remaining = limit
    offset = 0
    while remaining > 0:
        page = min(remaining, CC_PAGE_CAP)
        url = (f"https://index.commoncrawl.org/{idx}-index"
               f"?url={urllib.parse.quote(prefix)}&output=json&limit={page}&page={offset // CC_PAGE_CAP}")
        last = ""
        got: list[str] = []
        for _ in range(tries):
            try:
                raw = get(url)
                for line in raw.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        got.append(json.loads(line).get("url") or "")
                    except Exception:
                        continue
                break
            except Exception as exc:  # noqa: BLE001 - a flaky gateway must not kill the harvest
                last = str(exc)[:60]
                got = []
        if not got:
            print(f"  cc {prefix}: page {offset // CC_PAGE_CAP} unavailable ({last}); stopping at {len(collected)}")
            if not collected:
                print(f"  cc {prefix}: NOTHING harvested - Common Crawl is very likely rate-limiting this host. "
                      f"Wait and retry, or widen through another source; the run continues with what it has.")
            break
        collected.extend(got)
        remaining -= len(got)
        offset += len(got)
        if len(got) < page:
            break
    return [u for u in collected if u]


def thread_ids(n: int):
    """Newest HN threads whose title is a Who-is-hiring post. Sorted by DATE, not relevance."""
    url = ("https://hn.algolia.com/api/v1/search_by_date"
           "?query=%22Who%20is%20hiring%22&tags=story&hitsPerPage=60")
    hits = json.loads(get(url)).get("hits", [])
    out = []
    for h in hits:
        title = (h.get("title") or "").lower()
        if "who is hiring" not in title or not h.get("objectID"):
            continue
        out.append((h.get("created_at", "")[:7], h["objectID"], h.get("title", "")))
    out.sort(reverse=True)
    return out[:n]


def extract(text: str):
    found = {k: set() for k in PATS}
    for plat, pat in PATS.items():
        for m in re.finditer(pat, text):
            s = m.group(1).lower().rstrip(".")
            if s not in SKIP:
                found[plat].add(s)
    return found


def probe(plat: str, slug: str):
    """Return (live, job_count). Handles Lever's bare-list response, which crashed the hand-written probe."""
    try:
        data = json.loads(get(BOARD_API[plat].format(slug=slug)))
    except Exception as exc:
        return False, str(exc)[:40]
    if isinstance(data, list):
        jobs = data
    else:
        jobs = data.get("jobs") or []
    return True, len(jobs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--source", choices=("hn", "cc", "both"), default="hn",
                    help="hn = newest Who-is-hiring threads (original); cc = Common Crawl ATS URL index; both = merge")
    ap.add_argument("--cc-limit", type=int, default=300, help="URLs to pull per ATS prefix from Common Crawl")
    ap.add_argument("--from-urls", metavar="FILE",
                    help="also harvest from board URLs found in FILE (any text; e.g. saved search results)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    harvested = {k: set() for k in PATS}

    if args.source in ("hn", "both"):
        threads = thread_ids(args.threads)
        print(f"newest hiring threads: {len(threads)}")
        for month, tid, title in threads:
            print(f"  {month} | {tid} | {title[:52]}")
        for _month, tid, _t in threads:
            try:
                harvested_page = extract(get_html(f"https://news.ycombinator.com/item?id={tid}"))
            except Exception as exc:
                print(f"  fetch {tid} failed: {str(exc)[:50]}")
                continue
            for plat in harvested:
                harvested[plat] |= harvested_page[plat]

    if args.source in ("cc", "both"):
        print(f"common crawl: pulling up to {args.cc_limit} URLs per ATS prefix")
        for plat, prefix in CC_PREFIX.items():
            urls = cc_urls(prefix, args.cc_limit)
            page = extract(" ".join(urls))
            harvested[plat] |= page[plat]
            print(f"  {plat:11} urls={len(urls):4}  slugs={len(page[plat])}")
    if args.from_urls:
        # Anything can find a board URL - a search engine, a newsletter, a hand-written list. Reduce the text with the
        # SAME patterns the crawlers use, then let the live probe below decide what is real.
        blob = pathlib.Path(args.from_urls).read_text(errors="ignore")
        page = extract(blob)
        for plat in harvested:
            harvested[plat] |= page[plat]
        print("  from-urls:", {k: len(v) for k, v in page.items()})
    print("harvested:", {k: len(v) for k, v in harvested.items()},
          "| total", sum(len(v) for v in harvested.values()))

    # THE REGISTRY IS CONFIGURATION AND LIVES IN THE DATA DIRECTORY - it was `src/screening/`
    # `daily_sources.json` until it moved, and this line kept opening the old path.
    reg_path = DATA_DIR / "screening" / "sources.json"
    reg = json.loads(reg_path.read_text())
    known = set()
    for plat in PATS:
        known |= {f"{plat}:{s}" for s in (reg.get(plat) or {})}
    for row in load_rows():
        src = (row.get("source") or "").lower()
        for plat, pat in PATS.items():
            known |= {f"{plat}:{m.group(1)}" for m in re.finditer(pat, src)}

    added, empty, dead = [], [], []
    refused = []
    for plat, slugs in harvested.items():
        bucket = reg.setdefault(plat, {})
        for slug in sorted(slugs):
            if f"{plat}:{slug}" in known:
                continue
            if slug.lower() in AGGREGATOR_SLUGS:
                # A job aggregator is not an employer: applying through its board reaches the aggregator, not the company
                # hiring, and thousands of rebroadcast postings would swamp every later scan.
                refused.append(f"{plat}:{slug}")
                continue
            live, info = probe(plat, slug)
            if not live:
                dead.append(f"{plat}:{slug} ({info})")
                continue
            entry = f"{plat}:{slug} ({info} jobs)"
            if info == 0:
                empty.append(entry)
            else:
                added.append(entry)
            bucket[slug] = bucket.get(slug) or slug.replace("-", " ").title()

    print(f"\nlive boards added: {len(added)}   empty-but-live: {len(empty)}   dead/unreachable: {len(dead)}")
    if refused:
        print(f"refused as job-aggregator boards ({len(refused)}): {', '.join(refused)}")
    for label, items in (("added", added), ("empty but live", empty), ("dropped as dead", dead)):
        if items:
            print(f"  {label}: " + json.dumps(items[:30], ensure_ascii=False))
    print("registry now:", {k: len(reg.get(k) or {}) for k in PATS},
          "| total", sum(len(reg.get(k) or {}) for k in PATS))

    if args.dry_run:
        print("\n--dry-run: registry NOT written")
        return 0
    reg_path.write_text(json.dumps(reg, indent=1, ensure_ascii=False) + "\n")
    print("registry written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
