#!/usr/bin/env python3
"""screen_urls.py — screen a list of Greenhouse/Ashby posting URLs through the boards' own APIs.

Generalises the one-off shortlist screener: give it URLs (or a file of them, one per line) and it resolves each to
its board API, then reports the title, location, years asked, stack keywords, the pay band the posting publishes with
its top derived (`candidate_profile.json -> candidate.standing_answers.compensation` supplies the answer when it
publishes none), whether the authorisation SENTENCES contain a hard bar, and whether the requisition is already in
data/applications.csv. No browser is opened, so the user's focus is never touched, and nothing is tailored until a
posting passes.

USAGE
  .venv/bin/python3 src/screening/screen_urls.py <url> [<url> ...]
  .venv/bin/python3 src/screening/screen_urls.py --file urls.txt
"""
import csv
import html
import json
import pathlib
import re
import sys
# tracker_index lives beside this file; make it importable without depending on the working directory.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# The tracker read is shared with the other screeners; this file carried its own copy until 2026-10-07.
from tracker_index import load_rows  # noqa: E402
import urllib.request
# The compensation fallback is not re-derived here. `candidate_profile.json -> candidate.standing_answers.compensation`
# is its one home, and `src/forms/draft_form_spec.py` is the module that already resolves it for the toolkit - the
# band-beats-fallback rule, the parse, and the refusal to produce a number when the entry is missing. A second copy in
# this file is exactly what drifted before, with the figure in three places and two of them wrong, so the screener
# asks the same resolver the drafter asks. `tracker_index` has just put the repository root on sys.path.
from src.forms.draft_form_spec import compensation_rule  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
UA = {"User-Agent": "Mozilla/5.0"}
BAD = re.compile(
    r"(us citizen|u\.s\. citizen|green card|permanent resident|security clearance|active clearance|"
    # Rackner's posting says "Clearance: Active final DoD Secret clearance required" and matched NOTHING above, so a
    # defence role with a hard clearance bar was reported as bar-free. Unlike "citizenship", the word "clearance" does
    # not appear in EEO boilerplate, so the bare word is safe to match, along with the usual clearance vocabulary.
    r"\bclearance\b|\bclearances\b|secret clearance|top secret|ts/sci|dod secret|public trust|"
    r"must (be able to )?obtain a (security )?clearance|clearance (is )?required|"
    r"\bitar\b|\bu\.s\. person\b|not (able|available) to (provide|offer) (visa|sponsorship)|"
    r"(do(es)? not|cannot|will not|unable to) sponsor|no visa sponsorship|without sponsorship|"
    # "unable to SUPPORT sponsorship" is the same bar written with one more word, and it missed every
    # alternative above: a live JD reading "We are unable to support sponsorship at this time." came back
    # "bars: none found in the authorisation sentences" until 2026-10-14 (Greenhouse's own board, req 8279799).
    r"not eligible for sponsorship|sponsorship is not available|(we are )?unable to (sponsor|support sponsorship)|"
    r"not (currently )?able to sponsor|no sponsorship|"
    # Enrollment/graduation bars: Retell AI's New Grad posting is "only open to candidates who have already completed
    # their bachelor's degree and are no longer enrolled in a bachelor's or master's program", which excludes a student
    # finishing an M.S. in December 2026. Invisible in a normal requirement list, so it is matched explicitly.
    r"only open to candidates who have already|already completed (their|your) bachelor|"
    r"no longer enrolled|not (currently )?(be )?enrolled in a (bachelor|master|graduate)|must have already graduated|"
    r"must be a (current )?(new )?graduate|recent graduates only)",
    re.I,
)
STACK = ("Python", "TypeScript", "JavaScript", "React", "Node", "Go", "PostgreSQL", "MySQL", "Redis",
         "AWS", "GCP", "Azure", "Kubernetes", "Docker", "GraphQL", "REST", "Rust", "C++", "Java", "Kotlin",
         "C#", "PHP", "Ruby")
DROP_STACK = {"Java", "Kotlin", "C#", "PHP", "Ruby"}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()


def clean(h):
    t = re.sub(r"<li>", "\n- ", h or "")
    t = re.sub(r"</(p|ul|h1|h2|h3|div)>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"[ \t]+", " ", html.unescape(t))


def sentences(t):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n", t) if s.strip()]


# A published amount and the currency it is written in. THE CURRENCY TOKEN USED TO BE `$` AND NOTHING ELSE, and the cost
# was a band reported as none: "CAD 78,000 to 96,000" matched nothing at all, so a posting that had published its range
# came back as "none published" and the reader was handed a fallback instead of the employer's own figure - the same
# class of error as inventing one. A `$` stays USD, a three-letter code (or a £/€) is reported as that currency, and
# from there it is the RUNNING currency, because a band is usually spelled with its code once and then continued bare
# ("CAD 78,000 to 96,000"). The word boundaries keep a code from being carved out of a longer word - without them the
# tail of an all-caps "SALARY" reads as a currency code.
AMOUNT_RE = re.compile(
    r"(?:(?<![A-Za-z])(?P<code>[A-Z]{3})(?![A-Za-z])\s*\$?\s*|(?P<symbol>[$€£])\s*)?"
    r"(?P<whole>\d{2,3})(?:,(?P<thousands>\d{3}))?(?:\.\d+)?\s?(?P<k>[Kk])?"
)
CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP"}
# Figures outside this range are not salaries: a signing bonus, a headcount, a funding round.
MIN_AMOUNT, MAX_AMOUNT = 40000, 900000


def money(value: int, currency: str) -> str:
    """An amount written in the currency the posting named: `$127,100` for USD, `CAD 96,000` for anything else."""
    return f"${value:,}" if currency == "USD" else f"{currency} {value:,}"


def pay_amounts(desc: str) -> list:
    """Every published amount as `(currency, value)`, in the order it is written.

    A number with NO currency named before it is not counted - "50,000 users", "80,000 downloads" - because two such
    figures would add up to a band nobody published, and a band that was never published is worse than one that was
    missed. A number that follows a currency IS counted and inherits it, which is what makes the second half of
    "CAD 78,000 to 96,000" an amount of Canadian dollars rather than a bare figure.
    """
    out = []
    currency = ""
    for m in AMOUNT_RE.finditer(desc or ""):
        code = (m.group("code") or "").upper() or CURRENCY_SYMBOLS.get(m.group("symbol") or "", "")
        if code:
            currency = code
        whole, thousands, k = m.group("whole"), m.group("thousands"), m.group("k")
        if thousands:
            value = int(whole) * 1000 + int(thousands)
        elif k:
            value = int(whole) * 1000
        else:
            continue          # "3 years", "401(k)" - a number, but not an amount of money
        if currency:
            out.append((currency, value))
    return out


def pay_answer(desc):
    """Return (band_text, suggested_answer) from any published compensation range.

    WHY THIS EXISTS. The contract says compensation is answered with the TOP OF THE PUBLISHED BAND, and the recorded
    fallback applies only when nothing is published. On Replit that went wrong: the posting published "$180K - $250K",
    but the tailoring profile's jd_text had been written from this screener's SUMMARY rather than from the posting, so
    the compensation text never reached the model and the fallback figure was submitted instead. The ATS was uneditable
    by then. Reporting the band here - with the answer already derived - means the number is in front of the model at
    the moment it writes the profile, so the fallback cannot be reached by accident.

    ONE BAND PER CURRENCY. A multi-region posting lists a US range and a Canadian one, and they are not comparable
    without an exchange rate, so both are reported side by side rather than folded into one range that adds dollars to
    loonies. A currency with fewer than two figures is not a band - the rule the single-currency version already had.
    """
    by_currency = {}
    for currency, value in pay_amounts(desc):
        if MIN_AMOUNT <= value <= MAX_AMOUNT:
            by_currency.setdefault(currency, []).append(value)
    bands, tops = [], []
    for currency, values in by_currency.items():
        figures = sorted(set(values))
        if len(figures) < 2:
            continue
        bands.append(f"{money(figures[0], currency)} - {money(figures[-1], currency)}")
        tops.append(f"{money(figures[-1], currency)} (top of band)")
    if not bands:
        return None, None
    return " | ".join(bands), " / ".join(tops)


def recorded_fallback(candidate: dict | None = None) -> dict:
    """The candidate's own compensation fallback, resolved by the module that owns the rule.

    THE NUMBER HAS ONE HOME - `candidate_profile.json -> candidate.standing_answers.compensation`, which
    docs/CONFIGURATION.md names as the place to record it - and `src/forms/draft_form_spec.py` already resolves it.
    Reading it a second time here, with a second parser and a second set of rules for what counts as valid, is how it
    drifted before: the figure was in the contract, in a script and in the user's memory at once, and two of the three
    were wrong. `candidate` is a parameter so the resolution can be exercised against a profile this checkout does not
    have - the same reason the drafter's `compensation_rule` takes one.
    """
    return compensation_rule(candidate)


def pay_line(band: str | None, answer: str | None, candidate: dict | None = None) -> str:
    """The `pay` line: a published band with its top, or the RECORDED fallback, marked as one.

    A posting that publishes nothing is answered from the profile, and when the profile records nothing either the
    line says so and names the field to fill: a figure this screener invented would be typed into a real application as
    the candidate's expectation, which is the one thing this project refuses to do.
    """
    if band:
        return (f"{band}  -> top of the ranges found: {answer}; CHECK which range is the US one, because a "
                f"multi-region posting lists several (Cohere's Canada tier and Discord's second tier both inflate this)")
    rule = recorded_fallback(candidate)
    if not rule:
        return ("none published -> NO fallback recorded either: candidate_profile.json -> "
                "candidate.standing_answers.compensation is absent or malformed, so ask the user - this screener "
                "will not invent a number")
    return (f"none published -> answer {money(rule['fallback'], rule['currency'])} (the recorded fallback in "
            f"candidate_profile.json -> standing_answers.compensation, not a published band)")


def report(label, title, loc, desc, url, applied):
    bars = [s for s in sentences(desc) if BAD.search(s) and len(s) < 400]
    years = re.findall(r"(\d+(?:\.\d+)?)\+?\s*(?:to\s*\d+\s*)?years", desc, re.I)
    stack = [k for k in STACK if re.search(rf"(?<![A-Za-z]){re.escape(k)}(?![A-Za-z])", desc, re.I)]
    core_dropped = [k for k in stack if k in DROP_STACK]
    band, answer = pay_answer(desc)
    dup = any(url.split("?")[0].rstrip("/").endswith(a.strip().rstrip("/")) for a in applied if a.strip())
    print(f"\n=== {label} — {title}")
    print(f"    loc    : {loc}")
    print(f"    years  : {years[:3]}")
    print(f"    stack  : {stack}")
    print(f"    pay    : {pay_line(band, answer)}")
    if core_dropped:
        print(f"    NOTE   : mentions {core_dropped} - check whether that is the CORE stack (skip) or incidental")
    if bars:
        # Print the MATCHED PHRASE with the words around it. Printing the start of the sentence instead once made a
        # genuine "applicants MUST BE US Citizens" bar look like a false positive about a trade association, and the
        # screener was nearly overruled on that basis (CapitalT, 2026-10-01).
        m = BAD.search(bars[0])
        start = max(0, m.start() - 70)
        print(f"    bars   : [{m.group(0).strip()}] ...{bars[0][start:m.end() + 90].strip()}")
    else:
        print("    bars   : none found in the authorisation sentences")
    if dup:
        print("    DUPLICATE: this url is already in the tracker")
    print(f"    url    : {url}")


def from_greenhouse(url):
    # The token can follow the board on a "?" or an "&": the canonical embed form is
    #   job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>
    # and requiring "?token=" made the screener call that URL "unrecognised board" (Keeper Security, 2026-10-02).
    m = re.search(r"greenhouse\.io/(?:embed/job_app\?.*?for=)?([A-Za-z0-9_.-]+)(?:/jobs/|[?&].*?token=)(\d+)", url)
    if not m:
        m2 = re.search(r"gh_jid=(\d+)", url)
        if m2:
            for cand in re.findall(r"greenhouse\.io/([A-Za-z0-9_.-]+)", url):
                m = (cand, m2.group(1))
                break
            if not m:
                # Many employers host the form on their OWN domain and pass the id as gh_jid, e.g.
                # https://seatgeek.com/jobs/8156627?gh_jid=8156627 . list_board_jobs.py emits exactly that
                # shape, so the screener could not read back its own listings. Greenhouse's board token is
                # very often the company's domain label, so try that before giving up.
                host = re.search(r"https?://(?:www\.)?([A-Za-z0-9-]+)\.", url)
                if host:
                    m = (host.group(1), m2.group(1))
    if not m:
        return None
    board, jid = m.group(1), m.group(2)
    d = json.loads(get(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jid}"))
    return board, d.get("title", "?"), (d.get("location") or {}).get("name", "?"), clean(d.get("content", "")), \
        d.get("absolute_url") or f"https://job-boards.greenhouse.io/{board}/jobs/{jid}"


def from_ashby(url):
    m = re.search(r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{36})", url, re.I)
    if not m:
        return None
    board, uuid = m.group(1), m.group(2)
    d = json.loads(get(f"https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true"))
    job = next((j for j in d.get("jobs", []) if j.get("id") == uuid), None)
    if not job:
        return board, "(not active)", "?", "", url
    # THE COMPENSATION LIVES IN A STRUCTURED FIELD, NOT IN THE DESCRIPTION. Ashby exposes it as `compensation`, so a
    # text search over descriptionHtml alone reports "none published" for a posting that publishes a band perfectly
    # clearly - which is exactly how Replit's "$180K - $250K" was missed and the fallback figure was submitted. The
    # scraped salary summary is appended to the description so the pay line below can see it.
    comp = job.get("compensation") or {}
    pay_text = " ".join(str(comp.get(k) or "") for k in
                        ("scrapeableCompensationSalarySummary", "compensationTierSummary"))
    tiers = " ".join(str((t or {}).get("tierSummary") or "") for t in (comp.get("compensationTiers") or []))
    desc = clean(job.get("descriptionHtml", "")) + " " + pay_text + " " + tiers
    return board, job.get("title", "?"), job.get("location", "?"), desc, job.get("jobUrl", url)



def from_lever(url):
    m = re.search(r"jobs\.lever\.co/([^/]+)/([0-9a-f-]{36})", url, re.I)
    if not m:
        return None
    board, jid = m.group(1), m.group(2)
    d = json.loads(get(f"https://api.lever.co/v0/postings/{board}/{jid}"))
    text = (d.get("descriptionPlain") or "") + "\n" + "\n".join(
        (l.get("text") or "") + " " + (l.get("content") or "") for l in (d.get("lists") or [])
    ) + "\n" + (d.get("additionalPlain") or "")
    return board, d.get("text", "?"), (d.get("categories") or {}).get("location", "?"), clean(text), d.get("hostedUrl", url)


def main():
    args = sys.argv[1:]
    urls = []
    if "--file" in args:
        urls = [l.strip() for l in pathlib.Path(args[args.index("--file") + 1]).read_text().splitlines() if l.strip()]
    else:
        urls = [a for a in args if a.startswith("http")]

    rows = load_rows()
    applied = {(r.get("source") or "").strip() for r in rows}

    for url in urls:
        try:
            res = from_ashby(url) or from_greenhouse(url) or from_lever(url)
            if not res:
                print(f"\n=== {url}\n    unrecognised board")
                continue
            board, title, loc, desc, real = res
            report(board, title, loc, desc, real, applied)
        except Exception as e:
            print(f"\n=== {url}\n    POSTING UNAVAILABLE — fetch failed: {str(e)[:80]}")
            print("    Do NOT tailor for this job. A board API 404 usually means the requisition is closed;")
            # AND THE REVERSE IS NOT TRUE: a board API 200 does NOT mean the page works. An Ashby job can be
            # LIVE in the board API while its public page 404s (2026-10-05), so a reader who has learned the
            # line above will trust the API as proof of life. The PAGE is what a candidate opens; the API is a
            # database view. Verify the page before tailoring.
            print("    confirm in the tab, because the duplicate check can still report can_prepare: True on a dead URL")


if __name__ == "__main__":
    main()
