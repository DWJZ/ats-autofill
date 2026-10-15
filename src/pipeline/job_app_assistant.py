#!/usr/bin/env python3
"""
Local job application assistant, driven by the profile in data/candidate_profile.json.

MVP features:
- Analyze a JD from a URL, text file, or stdin.
- Classify the posting's work-authorization requirement, and ask the candidate's own
  `standard_answers.work_authorization` whether that requirement disqualifies them.
- Score the resume tracks the profile defines.
- Recommend a resume track and capture cautious notes.
- Append an application target to a local CSV tracker.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import json
import re
import shutil
import sys
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

# WHETHER A POSTING'S REQUIREMENT IS A BAR IS ONE QUESTION, ASKED ONCE. `daily_screen.py` owns the
# answer: the posting's wording is classified into a REQUIREMENT, and `requirement_applies` decides
# whether that requirement disqualifies this applicant, from `standard_answers.work_authorization`.
# This module held a second, cruder copy of it - a list of patterns under a comment saying that a
# citizenship or U.S.-person requirement is disqualifying for EVERYONE - which is wrong for exactly the
# applicants those postings are open to, and had no idea what the profile said.
#
# IMPORTED RATHER THAN COPIED, and in one direction only (pipeline -> screening, the same direction
# `application_pipeline.py` already takes into `src/forms/` for its degree mapping): a second copy of a
# pattern list is a copy that drifts, and the whole point of the 2026-10-13 change on the screening side
# is that there is one definition of this model rather than several. `daily_screen.py` is untouched: it
# remains the owner, and nothing here may be added to it.
from src.screening.daily_screen import (  # noqa: E402
    HARD_BLOCK_PATTERNS,
    NO_SPONSOR_PATTERNS,
    APPLICANT_STATUSES,
    requirement_applies,
)
# THE WORDS A POSTING'S OWN TITLE IS FOUND BY ARE THE APPLICANT'S FIELD, the same one the screening
# gates on, so they are asked for rather than restated here: `title_phrases` reads
# `filters.field_include` from the board registry and, when the registry names none, the profile's own
# `resume_tracks[*].keywords`. This module used to carry three software phrases of its own.
from src.screening.screen_newgrad_postings import (  # noqa: E402
    load_sources,
    title_phrases,
)
# THE WORDS A POSTING'S OWN RUNGS ARE SPELLED WITH ARE THE APPLICANT'S FIELD, and the registry already
# states them: `filters` says what the field is called and `levels` says how it numbers its rungs, so a
# report of "this posting names Software Engineer II" is readable only against the vocabulary the
# registry configured. `SENIORITY_HINTS` below keeps the words that are NOT a field's - see it.
from src.screening.screen_newgrad_postings import level_vocabulary  # noqa: E402

#: What a run that names no field falls back to: the three software phrases this module carried, which
#: `title_phrases` also returns for a registry and a profile that say nothing about a field.
DEFAULT_FIELD_PHRASES = title_phrases()

#: `infer_title`'s answer for a posting that carries no title of its own. It is a report ABOUT THE
#: POSTING, so nothing that describes the APPLICANT may carry it as if it were a title: the header
#: resolver below refuses it, and a resume whose header read "Unknown role" would name nobody.
UNKNOWN_ROLE = "Unknown role"

PROFILE_PATH = DATA_DIR / "candidate_profile.json"
# The summary and the resume view live in the OTHER profile: candidate_profile.json holds the
# answers to questions, application_profile.json holds the history and the prose that goes on a
# resume. Two files, two loaders, and a fact belongs in exactly one of them.
APPLICATION_PROFILE_PATH = DATA_DIR / "application_profile.json"
TRACKER_PATH = DATA_DIR / "applications.csv"
OUTPUTS_DIR = ROOT / "output" / "docx"


#: The posting wordings that make it a hard requirement, as `(reason, pattern)` and taken from the
#: screening model rather than restated. The requirement is a fact about the POSTING and belongs here;
#: `APPLICANT_STATUSES`, `REQUIREMENT_MET_BY` and `requirement_applies` in that same module are the facts
#: about the APPLICANT, and they are asked rather than duplicated.
NEGATIVE_PATTERNS = [
    (reason, rx) for rx, reason in (*HARD_BLOCK_PATTERNS, *NO_SPONSOR_PATTERNS)
]

#: The wordings that are merely relevant, unchanged: they say nothing about whether this applicant meets
#: them, so they earn a read rather than a verdict.
POSITIVE_PATTERNS = [
    (r"\bsponsor(ship)?\b", "Mentions sponsorship"),
    (r"\bh-?1b\b", "Mentions H-1B"),
    (r"\bf-1\b", "Mentions F-1"),
    (r"\bopt\b", "Mentions OPT"),
    (r"\bcpt\b", "Mentions CPT"),
]

# THE WORDS A POSTING USES TO SAY WHICH RUNG IT IS ON ARE TWO KINDS, AND ONLY ONE OF THEM IS A FIELD'S.
# "new grad", "entry level" and "early career" are what any field calls the bottom of its ladder; the
# spellings a field gives its own numbered rungs are the registry's (`levels`), and the list below used to
# carry three of software's - "software engineer i", "software engineer ii" and "ic2" - so a nursing or
# legal registry could replace every level word the screen ranks by and this report would still print
# software's. That is the defect `level_vocabulary` exists to remove; the generic words stay because they
# are nobody's field, and `_SOFTWARE_RUNG_HINTS` stays only so that a run which configures nothing is
# still reported in exactly the words it was reported in before `levels` existed.
SENIORITY_HINTS = [
    "new grad",
    "university graduate",
    "early career",
    "entry level",
    "entry-level",
]
#: The three rung spellings this module carried, kept as the vocabulary for a registry that names no
#: levels - the software words a run without a `levels` block has always been reported in. Written out
#: so `test_job_title_and_positioning.py` compares the fallback with the text that shipped rather than
#: with a description of it.
_SOFTWARE_RUNG_HINTS = ["software engineer i", "software engineer ii", "ic2"]


def seniority_hints_for(registry: dict | None) -> list[str]:
    """The words that mark a posting as junior or mid: the generic ones, then the rungs a field spells.

    `level_vocabulary` returns the junior and mid spellings the registry configured, so a registry that
    numbers its rungs "Nurse I" and "RN II" is reported in those words - and software's three are not in
    the list to leak. A registry that names NO levels keeps the three this module shipped with, and keeps
    them ALONE: `level_vocabulary({})` resolves the shipped software defaults, and reporting all eleven of
    them for a run that configures nothing would be a different sentence from the one that run has always
    printed. A configured registry replaces the three the same way, because a field that has said how it
    numbers its rungs has said it in full.
    """
    levels = (registry or {}).get("levels")
    words: list[str] = list(SENIORITY_HINTS)
    configured = levels if isinstance(levels, dict) else {}
    if not configured:
        rungs = _SOFTWARE_RUNG_HINTS
    else:
        rungs = level_vocabulary(registry)
    for word in rungs:
        if word.lower() not in [w.lower() for w in words]:
            words.append(word)
    return words


@dataclass
class Analysis:
    title: str
    company: str
    source: str
    eligibility: str
    eligibility_notes: list[str]
    track_scores: dict[str, int]
    recommended_track: str
    #: The track this profile falls back to when the posting names none of its keywords - the profile's
    #: declared default, or the first track it declares. Carried on the analysis so that a later step
    #: asking "is this the profile's ordinary track?" has the name the PROFILE uses, rather than the
    #: literal "backend" it used to compare against. The header is no longer such a step: the staff case
    #: that read this field wrote a title of its own, and `header_title_for` takes the posting's own
    #: title or the profile's, so what stays here is what the analysis found.
    default_track: str
    matched_terms: dict[str, list[str]]
    caution_terms: list[str]
    seniority_hints: list[str]
    summary: str


def load_profile() -> dict:
    with PROFILE_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_application_profile() -> dict:
    with APPLICATION_PROFILE_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def project_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def fetch_url(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 job-app-assistant/0.1",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        content_type = response.headers.get("content-type", "")
        charset_match = re.search(r"charset=([^;]+)", content_type, re.I)
        charset = charset_match.group(1) if charset_match else "utf-8"
        raw = response.read()
    return raw.decode(charset, errors="replace")


def html_to_text(raw: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", raw)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</(p|div|li|h[1-6]|tr)>", "\n", text)
    text = re.sub(r"(?is)<.*?>", " ", text)
    return normalize(html.unescape(text))


def extract_html_title(raw: str) -> str:
    match = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
    if not match:
        return ""
    title = normalize(html.unescape(match.group(1)))
    return clean_title(title)


def read_jd(args: argparse.Namespace) -> tuple[str, str]:
    if args.url:
        try:
            raw = fetch_url(args.url)
            title = extract_html_title(raw)
            body = html_to_text(raw)
            if title:
                body = f"Page Title: {title}\n{body}"
            return body, args.url
        except (urllib.error.URLError, TimeoutError) as exc:
            raise SystemExit(f"Could not fetch URL. Paste JD text into a file and use --file. Error: {exc}")
    if args.file:
        path = Path(args.file)
        return path.read_text(encoding="utf-8", errors="replace"), str(path)
    if not sys.stdin.isatty():
        return sys.stdin.read(), "stdin"
    raise SystemExit("Provide --url, --file, or pipe JD text through stdin.")


def find_terms(text_lc: str, terms: Iterable[str]) -> list[str]:
    found = []
    for term in terms:
        pattern = bounded_pattern(term.lower())
        if re.search(pattern, text_lc):
            found.append(term)
    return found


def bounded_pattern(term: str) -> str:
    escaped = re.escape(term).replace(r"\ ", r"\s+")
    prefix = r"(?<![a-z0-9+#])" if re.match(r"[a-z0-9]", term, re.I) else ""
    suffix = r"(?![a-z0-9+#])" if re.search(r"[a-z0-9]$", term, re.I) else ""
    return prefix + escaped + suffix


def infer_title(text: str, field_phrases: Iterable[str] | None = None) -> str:
    """The posting's own job title, from its markup if it has any and from its prose if it does not.

    THE PROSE PATTERNS ARE THE APPLICANT'S FIELD, NOT SOFTWARE'S. The last three were "software engineer",
    "backend engineer" and "full[- ]stack engineer" written into the source, so a nursing or legal JD
    extracted nothing and came back "Unknown role" - which is not a blank: it is the `role` this module
    then hands to the resume generator (it names the output DOCX and the saved role profile) and writes
    into the tracker as the title of the application. The words now come from the same field
    configuration the screening uses (`title_phrases`); a run that names no field keeps the software
    phrases it always had.

    THE MARKUP IS TRIED FIRST, so the field phrases are only what this does when the page carries no
    title of its own - a pasted JD, or a board whose HTML says nothing.
    """
    patterns = [
        r"(?i)\bpage title\s*[:\-]\s*([^\n|]{3,120}(?:\| Microsoft Careers)?)",
        r"(?i)\b([^|\n]{3,100})\s+\|\s+Microsoft\s+Careers\b",
        r"(?i)\bog:title['\"\s:=]+([^|<\n]{3,100})",
        r"(?i)\bjob title\s*[:\-]\s*([^\n|]{3,90})",
        *(DEFAULT_FIELD_PHRASES if field_phrases is None else field_phrases),
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            candidate = clean_title(normalize(match.group(1)))
            if not looks_like_style_fragment(candidate):
                return candidate[:90]
    return UNKNOWN_ROLE


def clean_title(title: str) -> str:
    title = re.sub(r"\s*\|\s*Microsoft\s+Careers\s*$", "", title, flags=re.I)
    title = re.sub(r"^[a-f0-9]{8}-[a-f0-9-]{27,36}-\d+\s+", "", title, flags=re.I)
    return normalize(title)


def looks_like_style_fragment(value: str) -> bool:
    style_markers = ["text-color", "tab-", "#", "{", "}", ":", "px", "font-"]
    return sum(marker in value.lower() for marker in style_markers) >= 2


def infer_company(text: str, source: str) -> str:
    if "microsoft.com" in source.lower() or "microsoft" in text[:1000].lower():
        return "Microsoft"
    patterns = [
        r"(?i)\bcompany\s*[:\-]\s*([^\n|]{2,80})",
        r"(?i)\bat\s+([A-Z][A-Za-z0-9 &.,-]{2,60})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return normalize(match.group(1))[:80]
    return "Unknown company"


def applicant_status(profile: dict) -> str:
    """`candidate.standard_answers.work_authorization`, or "" when the profile does not state one.

    Read defensively, like the screening side reads it: a profile that is missing the key, or that still
    carries the placeholder the example ships with, is "not stated" - which filters nothing and is not an
    error. The two mistakes are not symmetric, because a posting wrongly dropped is invisible.
    """
    answers = (((profile or {}).get("candidate") or {}).get("standard_answers")) or {}
    return str(answers.get("work_authorization") or "").strip()


def screen_eligibility(text_lc: str, applicant: str | None = None) -> tuple[str, list[str]]:
    """Is this posting's work-authorisation wording a bar for THIS applicant?

    A REQUIREMENT IS A FACT ABOUT THE POSTING; WHETHER IT DISQUALIFIES IS A FACT ABOUT THE APPLICANT.
    "Must be a U.S. citizen" is a wall for one applicant and an open door for another, so the patterns
    below only find the requirement and `requirement_applies` - imported, not restated - decides. An
    applicant status that is unstated or unrecognised filters nothing: the requirement is reported and
    the posting is kept, which is the direction whose mistakes are visible.

    The requirement vocabulary comes with the same import, which is also why "Applicants must be US
    citizens." is recognised at all: it has no full stops after the U and the S, and the local pattern
    that used to run here expected them, so the sentence fell through to "no restriction found".
    """
    if applicant is None:
        try:
            applicant = applicant_status(load_profile())
        except (OSError, ValueError):
            applicant = ""
    bars: list[str] = []
    met: list[str] = []
    relevant: list[str] = []
    positive: list[str] = []
    for reason, pattern in NEGATIVE_PATTERNS:
        if not re.search(pattern, text_lc):
            continue
        # THREE OUTCOMES, NOT TWO, and the third is the one that used to be wrong in the other direction.
        # A STATED status either meets the requirement or does not. An UNSTATED one meets nothing and is met
        # by nothing - `requirement_applies` answers "not a bar" for both, which is the right answer for
        # the filter and the wrong one to report as "met": that would be a claim about the applicant no
        # profile makes, which is the shape of mistake every change here is about. So the status is
        # checked for itself rather than inferred from the filter's answer.
        if applicant not in APPLICANT_STATUSES:
            relevant.append(reason)
        elif requirement_applies(reason, applicant):
            bars.append(reason)
        else:
            met.append(reason)
    for pattern, note in POSITIVE_PATTERNS:
        if re.search(pattern, text_lc, re.I):
            positive.append(note)

    if bars:
        return "NOT_ELIGIBLE_OR_HIGH_RISK", sorted(set(bars))
    if met:
        # A requirement this applicant MEETS still earns a read - it is a line in a posting that decides
        # whether the role is open to them, and "you meet this" is a different fact from "nothing here
        # mentions it". Neither of the two lists can be reported as the other.
        return "NEEDS_CONFIRMATION", sorted(
            set(met + ["The posting states this requirement; read the exact wording before applying."])
        )
    if relevant:
        # The reason the posting is kept: nothing here was filtered, not that nothing was found. The note
        # names the requirement so the reader can check the wording themselves.
        return "NO_EXPLICIT_RESTRICTION_FOUND", sorted(set(relevant + [
            "This posting states a work-authorisation requirement, and the profile states no "
            "standard_answers.work_authorization status, so nothing was filtered on it."]))
    if positive:
        return "NEEDS_CONFIRMATION", sorted(set(positive + ["Sponsorship language found; read exact wording before applying."]))
    return "NO_EXPLICIT_RESTRICTION_FOUND", ["No explicit sponsorship/citizenship restriction found in provided text; sponsorship still must be confirmed."]


def score_tracks(profile: dict, text_lc: str) -> tuple[dict[str, int], dict[str, list[str]]]:
    scores = {}
    matched = {}
    for track, config in profile["resume_tracks"].items():
        terms = find_terms(text_lc, config["keywords"])
        matched[track] = terms
        scores[track] = len(terms)
    return scores, matched


def find_cautions(profile: dict, text_lc: str) -> list[str]:
    cautions = []
    for term in profile["do_not_claim"]:
        pattern = bounded_pattern(term.lower())
        if re.search(pattern, text_lc):
            cautions.append(term)
    return cautions


def track_names(profile: dict) -> list[str]:
    """The resume track names this profile defines, in the order it declares them."""
    return list((profile.get("resume_tracks") or {}).keys())


def default_track_for(profile: dict) -> str:
    """This profile's own idea of its ordinary track: `default_track`, else the first one it declares.

    THE TRACKS BELONG TO THE PROFILE, SO THE NAME CANNOT. Code that wants "the usual track" - the staff
    header-title special case did, and the score-nothing fallback did - has to ask the profile for it;
    the literal "backend" is not the name in every profile, and indexing `resume_tracks["backend"]` on
    one that names its tracks otherwise is what raised `KeyError: 'backend'` for every posting whose
    track score was 0. A declared `default_track` wins; otherwise `resume_tracks` is a JSON object, so it
    has an order, and the first track written is the profile's own statement about where to start.

    A profile with no tracks at all is a configuration gap, reported as one rather than as a KeyError.
    """
    names = track_names(profile)
    if not names:
        raise SystemExit(
            f"{PROFILE_PATH} defines no `resume_tracks`, so there is no track to recommend. Add at least "
            "one - see docs/CONFIGURATION.md - or name one with --track."
        )
    declared = str(profile.get("default_track") or "").strip()
    return declared if declared in names else names[0]


def resolve_track(profile: dict, scores: dict[str, int]) -> str:
    """Which track to recommend - the best-scoring one, or the profile's default when none scored.

    `scores` is the keyword match count per track. All-zero is the common case for a posting written
    without the toolkit's own vocabulary, and it is the case that used to take the literal fallback.
    """
    names = track_names(profile)
    default = default_track_for(profile)
    # `max` returns the FIRST maximal element, so tracks that tie at 0 come back in the profile's own
    # declaration order - which is what `default_track_for` also returns, rather than a second rule.
    best = max(names, key=lambda name: scores.get(name, 0))
    return best if scores.get(best, 0) > 0 else default


def build_analysis(text: str, source: str, profile: dict) -> Analysis:
    text_lc = text.lower()
    eligibility, eligibility_notes = screen_eligibility(text_lc, applicant_status(profile))
    scores, matched = score_tracks(profile, text_lc)
    default_track = default_track_for(profile)
    recommended_track = resolve_track(profile, scores)
    # ONE REGISTRY READ FOR THE WHOLE ANALYSIS, so the rung words reported here are the same ones the
    # screening gates read - see `seniority_hints_for`.
    registry = load_sources()
    seniority_hints = find_terms(text_lc, seniority_hints_for(registry))
    caution_terms = find_cautions(profile, text_lc)
    title = infer_title(text, title_phrases(registry, profile))
    company = infer_company(text, source)

    summary = (
        f"{company} - {title}: recommend {profile['resume_tracks'][recommended_track]['label']} track. "
        f"Eligibility: {eligibility}."
    )
    return Analysis(
        title=title,
        company=company,
        source=source,
        eligibility=eligibility,
        eligibility_notes=eligibility_notes,
        track_scores=scores,
        recommended_track=recommended_track,
        default_track=default_track,
        matched_terms=matched,
        caution_terms=caution_terms,
        seniority_hints=seniority_hints,
        summary=summary,
    )


def print_analysis(analysis: Analysis, profile: dict) -> None:
    label = profile["resume_tracks"][analysis.recommended_track]["label"]
    print("\nJob Analysis")
    print("=" * 72)
    print(f"Company: {analysis.company}")
    print(f"Title: {analysis.title}")
    print(f"Source: {analysis.source}")
    print(f"Eligibility: {analysis.eligibility}")
    for note in analysis.eligibility_notes:
        print(f"- {note}")
    print()
    print(f"Recommended resume track: {label}")
    print("Track scores:")
    for track, score in sorted(analysis.track_scores.items(), key=lambda item: item[1], reverse=True):
        terms = ", ".join(analysis.matched_terms[track]) or "no direct keyword match"
        print(f"- {profile['resume_tracks'][track]['label']}: {score} ({terms})")
    if analysis.seniority_hints:
        print()
        print("Seniority hints:")
        print("- " + ", ".join(analysis.seniority_hints))
    if analysis.caution_terms:
        print()
        print("JD mentions terms that should not be added unless actually confirmed:")
        print("- " + ", ".join(analysis.caution_terms))
    print()
    print("Suggested positioning:")
    print(textwrap.fill(positioning_for_track(profile, analysis.recommended_track), width=88))


def positioning_for_track(profile: dict, track: str) -> str:
    """The positioning advice printed for a recommended track: the profile's own words for it.

    THE THREE PARAGRAPHS THAT WERE HERE WERE ONE PERSON'S, chosen by literal track name -
    `if track == "ai_application"`, `if track == "fullstack"`, and a body that was the else-branch. It is
    the same defect as the `"backend"` fallback this file already fixed in `default_track_for`: a track
    named anything else got the else-branch, so a profile whose tracks are "bedside" or "litigation" was
    advised to position itself as an experienced backend engineer with Go, Redis and Kubernetes. This is
    advice read by a person about their own search, so the bar is that it must not mislead them; the words
    belong to the profile, exactly as the label does, and a track that records none says so instead of
    borrowing another person's.
    """
    config = (profile.get("resume_tracks") or {}).get(track) or {}
    text = str(config.get("positioning") or "").strip()
    if text:
        return text
    label = str(config.get("label") or track).strip() or track
    return (f"Position as {label} - this profile records no `positioning` line for the track, so there is "
            f"nothing more specific to print. Add one to `resume_tracks.{track}.positioning` in "
            f"{PROFILE_PATH} and it is printed here.")


# THE LINE UNDER THE CANDIDATE'S NAME IS A CLAIM ABOUT THE CANDIDATE, so it is the profile's words or
# the posting's and never a literal from this file. `tailor_resume` used to resolve it as
# `track_config.get("default_header_title", ...)` with the literal "Software Engineer" as the fallback,
# and then overwrite even a profile's own value with a second literal whenever the role contained
# "staff" and the track was the profile's ordinary one ("Staff Software Engineer | Backend Platform &
# Data Integration"). Both stated titles nobody had recorded: for an applicant whose field is not
# software the default named a job they do not hold, and the staff literal asserted a seniority and a
# specialisation their profile never claimed. This is the same defect - and the same fix - as
# `positioning_for_track` above, one field further out, and the profile field is the one the module
# already read (`resume_tracks.<track>.default_header_title`).
def header_title_for(profile: dict, track: str, role: str, override: str = "") -> str:
    """What goes after `Header title:` for one tailored resume, or a plain statement that there is none.

    IN THIS ORDER, because a header describes the PERSON and a posting describes a JOB. `--header-title`
    wins first: it is the operator's decision about this one document. Then the track's own
    `default_header_title`. Then the posting's own title - what a targeted header is normally taken
    from - which is reachable because the posting named one, and is refused when `infer_title` reported
    `UNKNOWN_ROLE`, since that is a report about the posting rather than a title.

    A RUN THAT SUPPLIES NOTHING IS TOLD SO. It returns a sentence naming the two inputs that were
    missing and the two ways to supply one, rather than a title borrowed from this module's author - and
    it does not stop the run, because the value is printed and written into no document at all (the
    resume's own header is the name and contact lines in `application_profile.json`); refusing to build
    a resume over a line no reader sees would cost a document and fix nothing. Should a later change
    print this line on the resume, the sentence is the marker that says so instead of a title.
    """
    explicit = (override or "").strip()
    if explicit:
        return explicit
    config = (profile.get("resume_tracks") or {}).get(track) or {}
    recorded = str(config.get("default_header_title") or "").strip()
    if recorded:
        return recorded
    posting = (role or "").strip()
    if posting and posting != UNKNOWN_ROLE:
        return posting
    return (f"none recorded - `resume_tracks.{track}` records no `default_header_title` in {PROFILE_PATH} "
            f"and the posting names no title of its own, so there is nothing honest to print here. Record "
            f"one under `resume_tracks.{track}.default_header_title`, or pass --header-title.")


def slugify(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return value or "Tailored"


def summary_for_tailor(analysis: Analysis, track: str, company: str, role: str, text_lc: str) -> str:
    """The summary is the candidate's own prose, read from the profile.

    IT USED TO BE THREE HARDCODED PARAGRAPHS. Each carried one engineer's record in figures - years of
    experience, how many APIs and modules, how many customers - which is a description of a specific
    person rather than a default, and anyone else running this tool would have shipped those numbers as
    their own. A summary is authored content: the tool can choose a layout and reorder sections, but it
    cannot know how many years someone has.

    So it comes from the profile, and when the profile has none the answer is "" - a gap the caller
    reports, not a sentence invented to fill the space.
    """
    try:
        profile = load_application_profile()
    except (OSError, ValueError):
        return ""
    base = str(((profile.get("resume") or {}).get("summary")) or "").strip()
    if not base:
        return ""
    if company and role:
        return f"{base} Strong alignment with {company}'s {role}."
    return base



#: The JD wordings that ask for the SENIOR variant of a track's skill lines. The rule stays here - it is
#: a reading of the posting, like the seniority hints above and like the field phrases `infer_title`
#: falls back to - while the words it chooses between belong to the profile, because they are printed on
#: a resume under the candidate's name.
SENIOR_SKILL_HINTS = ["staff", "lead", "mentor", "architecture", "platform", "workflow", "integration"]


# SIX SKILL LINES OF ONE PERSON'S CAREER WERE WRITTEN INTO THE SOURCE HERE, with `fullstack` and
# `ai_application` branches that swapped three of them, and a third branch that swapped three more
# whenever the posting's wording read senior. They were not advice: `tailor_resume` hands them to the
# generator as the role profile's `skills`, and `apply_overrides` REPLACES the resume's own Core Skills
# section with whatever dict arrives - so a nurse, a lawyer or a teacher who tailored a resume got
# "Go, Python, SQL, TypeScript, JavaScript", "AWS, Docker, Kubernetes" and "Qdrant" printed on it, under
# their own name, because their track was not one of the two names the branches keyed on. The lines now
# come from the profile, exactly as `positioning` and the track `label` do.
def skill_lines_for_tailor(profile: dict, track: str, text_lc: str) -> dict[str, str]:
    """The Core Skills lines for one application: `resume_tracks.<track>.skill_lines`, from the profile.

    `skill_lines` is what the track shows. `skill_lines_senior` is what the same track shows when the
    posting reads senior (`SENIOR_SKILL_HINTS`), and the two are MERGED rather than swapped, so a track
    records only the labels that change - which is how the branch this replaces behaved.

    A TRACK THAT RECORDS NONE RETURNS {}. The caller then writes no `skills` override at all and the
    resume keeps the skills recorded in `application_profile.json`, which are the candidate's own; an
    empty dict would not do that, because `apply_overrides` reads one as "replace the section with
    nothing". What must never happen either way is a skill line somebody else's profile wrote.
    """
    config = (profile.get("resume_tracks") or {}).get(track) or {}
    lines = {str(label): str(value) for label, value in (config.get("skill_lines") or {}).items()}
    if not lines:
        return {}
    senior = config.get("skill_lines_senior") or {}
    if senior and any(hint in text_lc for hint in SENIOR_SKILL_HINTS):
        lines.update({str(label): str(value) for label, value in senior.items()})
    return lines


# FOUR FUNCTIONS THAT USED TO SIT HERE WERE DELETED, AND THIS IS WHERE THEY WERE. `next_nonempty_paragraph`,
# `replace_paragraph_text`, `set_or_insert_header_title` and `update_skill_section` were the paragraph
# patcher this module ran before the single-generator change (user rule, 2026-10-07) replaced it with a
# role profile handed to `generate_tailored_resume`. Nothing has called any of them since - the first was
# never called at all, and the rest were reachable only from each other - and the two job titles
# `set_or_insert_header_title` matched on ("Software Engineer", "Staff Software Engineer") were the same
# literals the header resolver above was fixed to stop stating. The `globals()["WD_ALIGN_PARAGRAPH"]` line
# that stood here existed only so that function could reach an alignment constant it never imported; the
# import itself stays, because it is also the check that reports a missing python-docx before a run writes
# anything.
def tailor_resume(args: argparse.Namespace, profile: dict) -> Path:
    try:
        from docx import Document  # noqa: F401 - imported for the availability check, not for use
    except ImportError as exc:
        raise SystemExit(f"python-docx is required for tailoring: {exc}")

    text, source = read_jd(args)
    analysis = build_analysis(text, source, profile)
    track = args.track or analysis.recommended_track
    track_config = profile["resume_tracks"][track]
    template = project_path(args.template or track_config.get("template_docx") or track_config["resume_files"][0])
    if not template.exists():
        raise SystemExit(f"Template not found: {template}")

    company = args.company or analysis.company
    role = args.role or analysis.title
    analysis.company = company
    analysis.title = role
    analysis.summary = (
        f"{analysis.company} - {analysis.title}: recommend {track_config['label']} track. "
        f"Eligibility: {analysis.eligibility}."
    )
    header_title = header_title_for(profile, track, role, args.header_title or "")

    # parents=True for the same reason as generate_tailored_resume: `output/` is gitignored and absent on a
    # fresh checkout, so creating `output/docx` without its parent raises FileNotFoundError.
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    # ONE GENERATOR (user rule, 2026-10-07). This used to copy a track template and patch its paragraphs, which made
    # it a second resume generator with its own idea of the layout. It now hands a role profile to the single
    # generator, so the analysis still drives the content while the layout comes from one place.
    summary = summary_for_tailor(analysis, track, company, role, text.lower())
    role_profile = {
        "company": company,
        "role": role,
        "summary": summary,
        "jd_text": text,
    }
    # ONLY WHEN THE PROFILE RECORDS THEM (see skill_lines_for_tailor): the key's absence is what leaves
    # the resume's own Core Skills section alone.
    skill_lines = skill_lines_for_tailor(profile, track, text.lower())
    if skill_lines:
        role_profile["skills"] = skill_lines
    profile_path = OUTPUTS_DIR / f"{slugify(company)}_{slugify(role)}_profile.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(json.dumps(role_profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    import generate_tailored_resume as _generator
    # THE NAME COMES FROM THE PROFILE (see load_profile), never from a literal in the filename: this used to be
    # "Example_Candidate_<company>_<role>_Resume.docx" for every applicant the tool was run for.
    candidate_name = (profile.get("candidate") or {}).get("name") or ""
    output_path, _payload = _generator.generate(
        profile_path,
        None,
        OUTPUTS_DIR / (args.output or f"{slugify(candidate_name)}_{slugify(company)}_{slugify(role)}_Resume.docx"),
    )

    print_analysis(analysis, profile)
    print("\nTailored Resume")
    print("=" * 72)
    print(f"Template: {template}")
    print(f"Output DOCX: {output_path}")
    print(f"Track: {track_config['label']}")
    print(f"Header title: {header_title}")
    if analysis.caution_terms:
        print("Caution terms from JD, not added unless confirmed:")
        print("- " + ", ".join(analysis.caution_terms))
    pdf_path = None
    if args.pdf:
        pdf_path = export_docx_to_pdf(output_path, candidate_name)
        print(f"Output PDF: {pdf_path}")
    if args.save:
        append_tailor_tracker(analysis, track, pdf_path or output_path, args.notes)
        print(f"Saved to: {TRACKER_PATH}")
    return output_path


def export_docx_to_pdf(docx_path: Path, candidate_name: str = "") -> Path:
    from resume_artifacts import export_and_validate_pdf

    # The name expectation is the candidate's own name from the profile; a hardcoded one would fail any resume
    # whose header carries a different name.
    pdf_path, _ = export_and_validate_pdf(
        docx_path,
        expected_terms=[candidate_name, "PROFESSIONAL EXPERIENCE", "EDUCATION"],
    )
    return pdf_path


def append_tailor_tracker(analysis: Analysis, track: str, output_path: Path, notes: str = "") -> None:
    ensure_tracker()
    final_notes = notes.strip()
    resume_note = f"tailored_resume={output_path.name}"
    if final_notes:
        final_notes = f"{final_notes}; {resume_note}"
    else:
        final_notes = resume_note
    with TRACKER_PATH.open("a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=tracker_fields())
        writer.writerow(
            {
                "date_added": dt.date.today().isoformat(),
                "company": analysis.company,
                "title": analysis.title,
                "source": analysis.source,
                "eligibility": analysis.eligibility,
                "recommended_track": track,
                "track_scores": json.dumps(analysis.track_scores, ensure_ascii=False),
                "status": "materials_ready",
                "notes": final_notes,
            }
        )


def ensure_tracker() -> None:
    if TRACKER_PATH.exists():
        return
    with TRACKER_PATH.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=tracker_fields())
        writer.writeheader()


def tracker_fields() -> list[str]:
    return [
        "date_added",
        "company",
        "title",
        "source",
        "eligibility",
        "recommended_track",
        "track_scores",
        "status",
        "notes",
    ]


def append_tracker(analysis: Analysis, notes: str = "") -> None:
    ensure_tracker()
    with TRACKER_PATH.open("a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=tracker_fields())
        writer.writerow(
            {
                "date_added": dt.date.today().isoformat(),
                "company": analysis.company,
                "title": analysis.title,
                "source": analysis.source,
                "eligibility": analysis.eligibility,
                "recommended_track": analysis.recommended_track,
                "track_scores": json.dumps(analysis.track_scores, ensure_ascii=False),
                "status": "to_review",
                "notes": notes,
            }
        )


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "tailor":
        parser = argparse.ArgumentParser(description="Tailor a resume by copying a master DOCX template and editing selected sections.")
        parser.add_argument("tailor")
        parser.add_argument("--url", help="Official JD URL to fetch and analyze.")
        parser.add_argument("--file", help="Path to a text/HTML file containing the JD.")
        # THE CHOICES COME FROM THE PROFILE, for the same reason the fallback does: the three names this
        # used to offer were one profile's, so a caller whose tracks are named otherwise had every
        # `--track` it could pass rejected by argparse before the profile was ever opened.
        _tailor_profile = load_profile()
        parser.add_argument("--track", choices=track_names(_tailor_profile),
                            help="Resume track. Defaults to analysis recommendation.")
        parser.add_argument("--company", help="Company name override.")
        parser.add_argument("--role", help="Role title override.")
        parser.add_argument("--template", help="DOCX template path. Defaults to track template.")
        parser.add_argument("--header-title", help="Header title override.")
        parser.add_argument("--output", help="Output DOCX filename under output/docx/.")
        parser.add_argument("--pdf", dest="pdf", action="store_true", default=True, help="Export and validate PDF (default).")
        parser.add_argument("--docx-only", dest="pdf", action="store_false", help="Skip PDF export for template debugging.")
        parser.add_argument("--save", action="store_true", help="Append the tailored target to applications.csv as materials_ready.")
        parser.add_argument("--notes", default="", help="Optional notes to store when using --save.")
        args = parser.parse_args()
        profile = load_profile()
        tailor_resume(args, profile)
        return 0

    parser = argparse.ArgumentParser(description="Analyze a job description and track application targets.")
    parser.add_argument("--url", help="Official JD URL to fetch and analyze.")
    parser.add_argument("--file", help="Path to a text/HTML file containing the JD.")
    parser.add_argument("--save", action="store_true", help="Append this analysis to applications.csv.")
    parser.add_argument("--notes", default="", help="Optional notes to store when using --save.")
    args = parser.parse_args()

    profile = load_profile()
    text, source = read_jd(args)
    analysis = build_analysis(text, source, profile)
    print_analysis(analysis, profile)

    if args.save:
        append_tracker(analysis, args.notes)
        print(f"\nSaved to: {TRACKER_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
