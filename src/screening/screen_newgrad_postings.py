#!/usr/bin/env python3
"""Screen recent new-grad software postings from public ATS job-board APIs.

Deterministic, stdlib-only. Sources:
  - Greenhouse: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
  - Lever:      https://api.lever.co/v0/postings/{slug}?mode=json
  - Ashby:      https://api.ashbyhq.com/posting-api/job-board/{slug}
  - Workday:    POST https://{host}/wday/cxs/{tenant}/{site}/jobs

Filters: the applicant's own field, new-grad signal (new grad / 2026 / 2027 /
early career / campus ...), their region (location field or title hint such as
"- US"), posted within --days (default 30; unknown dates are kept and marked).
Already-tracked postings (applications.csv) and intern postings are listed in
separate sections. Output: tables on stdout + JSON/CSV under output/.

THE FIELD AND REGION GATES ARE CONFIGURATION, read from the same registry
`daily_screen.py` fetches from (`<data>/screening/sources.json -> filters`) and,
for the field, from the applicant's own `resume_tracks` keywords. The `_DEFAULT_*`
patterns below are only what a registry that configures nothing falls back to.
See `field_patterns`.

THE LEVEL VOCABULARY IS A SECOND QUESTION AND HAS A SECOND BLOCK (`levels`), because
"Senior" and "Staff" are not field words: which words a field writes its levels with is
a fact about the field, and the shipped ones spell software's. See `level_patterns`.

Usage:
  python3 src/screening/screen_newgrad_postings.py [--days 30]
"""
import argparse
import pathlib
import sys
# tracker_index lives beside this file; make it importable without depending on the working directory.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# The tracker read is shared with the other screeners; this file carried its own copy until 2026-10-07.
from tracker_index import load_rows  # noqa: E402
import concurrent.futures
import csv
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

OUT_DIR = ROOT / "output" / "screen"
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}

# company slug -> display name (verified slugs first; the rest are guesses and
# 404 quietly when wrong)
GREENHOUSE = {
    "scaleai": "Scale AI",
    "twitch": "Twitch",
    "cssmerge": "Atoms (CSS Merge)",
    "airbnb": "Airbnb",
    "cloudflare": "Cloudflare",
    "datadog": "Datadog",
    "databricks": "Databricks",
    "elastic": "Elastic",
    "mongodb": "MongoDB",
    "roblox": "Roblox",
    "discord": "Discord",
    "epicgames": "Epic Games",
    "stripe": "Stripe",
    "canva": "Canva",
    "robinhood": "Robinhood",
    "fastly": "Fastly",
    "dropbox": "Dropbox",
    "pinterest": "Pinterest",
    "asana": "Asana",
    "togetherai": "Together AI",
    "workato": "Workato",
    "figma": "Figma",
    "duolingo": "Duolingo",
    "coinbase": "Coinbase",
    "snowflake": "Snowflake",
    "confluent": "Confluent",
    "hashicorp": "HashiCorp",
    "twilio": "Twilio",
    "plaid": "Plaid",
    "docusign": "DocuSign",
    "box": "Box",
    "zoom": "Zoom",
}
LEVER = {
    "palantir": "Palantir",
}
ASHBY = {
    "zip": "Zip",
    "sierra": "Sierra",
    "whatnot": "Whatnot",
    "applied": "Applied Intuition",
    "notion": "Notion",
    "cursor": "Cursor (Anysphere)",
    "perplexity-ai": "Perplexity AI",
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "ramp": "Ramp",
    "warp": "Warp",
    "mercury": "Mercury",
    "linear": "Linear",
    "vercel": "Vercel",
    "zapier": "Zapier",
    "groq": "Groq",
    "baseten": "Baseten",
    "fireworks-ai": "Fireworks AI",
    "cohere": "Cohere",
    "anthropic-ai": "Anthropic AI",
    "perplexity": "Perplexity",
}
# (host, tenant, site, display name)
WORKDAY = [
    ("nvidia.wd5.myworkdayjobs.com", "nvidia", "NVIDIAExternalCareerSite", "NVIDIA"),
    ("snapchat.wd1.myworkdayjobs.com", "snapchat", "snap", "Snap"),
    ("blackline.wd108.myworkdayjobs.com", "blackline", "BlackLineCareers", "BlackLine"),
    ("cadence.wd1.myworkdayjobs.com", "cadence", "univ_careers", "Cadence"),
    ("intel.wd1.myworkdayjobs.com", "intel", "Intel_External", "Intel"),
    ("ibm.wd1.myworkdayjobs.com", "ibm", "IBM_Careers", "IBM"),
    ("sap.wd1.myworkdayjobs.com", "sap", "SAP_Careers", "SAP"),
    ("oracle.wd1.myworkdayjobs.com", "oracle", "Oracle_Careers", "Oracle"),
    ("adobe.wd3.myworkdayjobs.com", "adobe", "AdobeCareers", "Adobe"),
    ("qualcomm.wd1.myworkdayjobs.com", "qualcomm", "QualcommCareers", "Qualcomm"),
    ("broadcom.wd1.myworkdayjobs.com", "broadcom", "BroadcomCareers", "Broadcom"),
    ("cisco.wd1.myworkdayjobs.com", "cisco", "CISCO_Careers", "Cisco"),
    ("honeywell.wd1.myworkdayjobs.com", "honeywell", "HoneywellCareers", "Honeywell"),
    ("siemens.wd1.myworkdayjobs.com", "siemens", "SiemensCareers", "Siemens"),
    ("service-now.wd1.myworkdayjobs.com", "service-now", "ServiceNowCareers", "ServiceNow"),
]
WORKDAY_QUERIES = ["new grad", "new college grad", "early career", "new hire", "2026", "2027"]
WORKDAY_PAGE = 20  # API rejects limit > 20
WORKDAY_QUERY_CAP = 120  # max postings fetched per query per board

NEW_GRAD_RE = re.compile(
    r"new[\s\-_]*grad|new[\s\-_]*college|new[\s\-_]*hire|recent[\s\-_]*grad"
    r"|early[\s\-_]*career|campus|graduating|class of 20|2026|2027",
    re.I,
)
INTERN_RE = re.compile(r"intern", re.I)
SEA_RE = re.compile(r"seattle|bellevue|redmond|washington,?\s*wa\b|\bwa\b", re.I)

# THE REGISTRY IS CONFIGURATION AND THIS FILE NEEDS ITS PATH TOO. `daily_screen.py` owns the reasoning
# (see `SOURCES_PATH` there); the path is defined here because this is the module that holds the
# screening patterns, and both screeners read the same file. It is still the DATA directory and not
# the source tree: the boards you watch, the words your field is spelled with and the region you can
# work in are yours.
SOURCES_PATH = DATA_DIR / "screening" / "sources.json"
CANDIDATE_PATH = DATA_DIR / "candidate_profile.json"


class FieldPatterns(NamedTuple):
    """The compiled gates, as one answer rather than six module constants read in eight places.

    Each field says what it is for and which text it is tested against:

      field_include          the applicant's FIELD. A title must match it to be screened at all.
      field_exclude          the parts of their field's industry they do not want to be routed to.
      title_topics_exclude   title topics that are noise FOR THEM, whether or not they are their field.
      region_include         what counts as the region they can work in, read from the location field.
      region_exclude         what rules that region out, from the same field.
      title_region_include   the region spelled out in a TITLE, for postings whose location is empty.
      title_region_exclude   a region in a TITLE that rules the posting out.
      skip_title             the title wordings that are worth screening OUT rather than in - a role
                             family the applicant has already decided not to read, which is a third
                             question from "is this my field" and "which rung is this". THE FIELD'S HALF
                             ONLY: the words no field translates are `GENERAL_SKIP_TITLE`, which a scanner
                             applies beside this one, and the two together are what the single regexes
                             `scan_registry_fresh.BADLVL` and `scan_tracker_tenants.SKIP_TITLE` used to be.

    ONLY `field_include` IS NEVER None. It is the gate a screening cannot be run without, so a registry
    that names no field falls back to the shipped words; "every title is in my field" and "no title is
    in my field" are both useless answers. The other seven ARE None when nothing asked for them, and every
    caller tests for that rather than compiling an empty pattern that reads as a gate.
    """

    field_include: re.Pattern
    field_exclude: re.Pattern | None
    title_topics_exclude: re.Pattern | None
    region_include: re.Pattern | None
    region_exclude: re.Pattern | None
    title_region_include: re.Pattern | None
    title_region_exclude: re.Pattern | None
    #: A DEFAULT, unlike the seven above, and for one reason: this arrived last, and a caller that builds a
    #: `FieldPatterns` by hand - `test_screen_patterns.py` writes the six shipped patterns out as the module
    #: constants they replaced - says nothing about it. None there is the absence of a gate, not an
    #: invisible one.
    skip_title: re.Pattern | None = None


# THE DEFAULTS ARE ONE PERSON'S SEARCH, CARRIED AS THE DEFAULTS AND NOT AS THE ONLY POSSIBILITY.
# They are what a registry that configures nothing gets, so that a run with no configuration screens
# for what it always screened for - but read the heading as "the example values", not as "what the
# tool assumes you are": these describe a backend software engineer looking at US postings, and they
# are wrong for anyone else. `filters` in <data>/screening/sources.json replaces them; `field_include`
# is also taken from the profile's own `resume_tracks` keywords when the registry names none, because
# "what field are you in" is already recorded there.
#
# Field words are a LIST, not a regex: this is the one default a person is most likely to edit, and a
# list of the words their field is spelled with is what they can actually check against a posting.
# The six words below are the six the code shipped with; each now matches a whole word, which is why
# `_LEGACY_FIELD_INCLUDE` is kept as the text it used to be. The two differ on titles that read as
# another field's work - "Solution Engineering Enablement" was an engineering posting to the old one.
_DEFAULT_FIELD_INCLUDE = ["engineer", "software", "developer", "programmer", "swe", "sde"]
#: The field as the module constant this replaced, written out so the change is compared with the
#: pattern that shipped rather than described as having preserved it (`test_screen_patterns.py`).
_LEGACY_FIELD_INCLUDE = r"engineer|software|developer|programmer|\bswe\b|\bsde\b"
_DEFAULT_FIELD_EXCLUDE = (
    r"recruiter|recruiting|sales|marketing|finance|accounting|design|analyst"
    r"|\bsupport\b|product|people|operations|legal|privacy|civil liberties"
    r"|data science|data scientist|machine learning|research"
)
# What this does: drops postings whose TITLE names one of these topics. It is not a statement that
# these roles are unskilled or uninteresting - it is this applicant's own answer to "which postings
# are noise for me", and the topics it names are the ones adjacent to a software search that they do
# not want to read.
_DEFAULT_TITLE_TOPICS_EXCLUDE = (
    r"\b(ASIC|RTL|DFT|FPGA|analog|digital design|firmware|hardware|low power"
    r"|cell modeling|energy modeling|power methodology|verification|silicon|PCB)\b"
)
_DEFAULT_REGION_INCLUDE = (
    r"united states|\busa?\b|\bus\b|remote|seattle|bellevue|redmond|washington,?\s*wa"
    r"|\bwa\b|austin|texas|california|\bca\b|new york|\bny\b|chicago|illinois"
    r"|\bil\b|florida|\bfl\b|massachusetts|boston|oregon|portland|dallas|houston"
    r"|san francisco|san diego|san jose|silicon valley|miami|tampa|orlando"
    r"|denver|colorado|pittsburgh|philadelphia|atlanta|georgia|columbus,?\s*oh"
    r"|ohio|indiana|kentucky|louisville|arizona|\baz\b|utah|sacramento"
    r"|nashville|tennessee|virginia|carolina|maryland|baltimore|district of columbia"
    r"|new jersey|jersey|connecticut|vermont|maine|new hampshire|hawaii|nevada"
    r"|las vegas|kansas|missouri|st\.?\s?louis|minnesota|wisconsin|nebraska"
    r"|oklahoma|mississippi|alabama|arkansas|montana|wyoming|idaho|new mexico"
)
_DEFAULT_REGION_EXCLUDE = (
    r"canada|toronto|vancouver|montreal|london|united kingdom|\buk\b|england|europe"
    r"|germany|france|ireland|india|\bin\b|singapore|sydney|melbourne|australia"
    r"|new zealand|japan|korea|seoul|shanghai|beijing|chengdu|dublin|amsterdam"
    r"|berlin|paris|lisbon|portugal|spain|madrid|sweden|stockholm|netherlands"
    r"|brazil|israel|tel aviv|austria|switzerland|zurich|z\u00fcrich|malaysia"
    r"|philippines|warsaw|poland|prague|czech|budapest|romania|cluj|kyiv|ukraine"
    r"|istanbul|turkey|auckland|wellington|manila|kuala lumpur|bangalore|mumbai"
    r"|pune|hyderabad|chennai|delhi|\bcn\b|south africa|duba\u0131|dubai|qatar"
    r"|kuwait|bahrain|oman|jordan|lebanon|saudi"
)
# Region hints embedded in titles, for postings whose location field is empty or uninformative.
_DEFAULT_TITLE_REGION_INCLUDE = r"\bus\b|\busa\b|united states"
_DEFAULT_TITLE_REGION_EXCLUDE = (
    r"\buk\b|united kingdom|europe|\beu\b|india|china|canada|singapore|london"
    r"|germany|france|ireland|japan|korea|australia|brazil|israel|switzerland"
    r"|netherlands|spain|portugal|poland|sweden|new zealand|malaysia|philippines"
    r"|middle east|turkey"
)
# THE TITLES THAT ARE NOT WORTH READING, WHICH IS A THIRD QUESTION FROM BOTH THE FIELD AND THE RUNG.
# `field_include` asks "is this posting my field" and `levels` asks "which rung is it"; this asks "is this a
# role family worth looking at" - and the two screeners that carried such a list mixed two kinds of word in
# one regex (`scan_registry_fresh.BADLVL`, `scan_tracker_tenants.SKIP_TITLE`). They are separated here, by
# the one test that decides a configuration key: does a fact about a FIELD change the answer?
#
# THE GENERAL WORDS DO NOT, so they are not configuration. There is no field in which "Manager" is worth
# reading and none in which "Director" means something else; the manager/lead track, the rungs above the
# ones this search keeps (`staff`, `principal`) and the non-target families beside it (`intern`,
# `recruiter`, `account`, `support`) are written the same way everywhere - the same reasoning the sibling
# change used when it left `manager`/`director`/`intern` in code, and `levels.management` names the same
# judgement for a field that spells a management title with its own word ("Director of Nursing").
#
# THE FIELD WORDS DO. A `qa`, `ios`, `android`, `devops` or "data engineer" title is software's own noise:
# it says nothing about whether a hospital's board holds a role worth reading, and carrying the list onto
# one would drop clinical informatics roles nobody asked the tool to judge. That half is
# `filters.skip_title`, and a registration that names a field and no skip words gets NO field gate rather
# than software's - the rule `field_exclude` and `title_topics_exclude` already follow.
#
# THE GENERAL ALTERNATIVES ARE VERBATIM, in the order the two scanners carried them, because an
# unconfigured run has to drop exactly the titles it dropped before - including the ones a bare
# alternative over-matches ("Leadership Development" carries `lead`, "Headquarters" carries `head`).
# Tightening that changes what the screen KEEPS, which is what the applicant never sees; it deserves its
# own case rather than a ride along with a refactor.
_GENERAL_SKIP_TITLE = (
    r"staff|principal|manager|lead|director|head|architect|intern|analyst|sales|support|solutions"
    r"|recruiter|account"
)
#: Compiled beside its own words: the pattern is what the two scanners apply, and the words are the one
#: spelling of them. Defined here rather than next to `_pattern` below because a module-level compile wants
#: its text above it - and the words are what a person edits.
GENERAL_SKIP_TITLE = re.compile(_GENERAL_SKIP_TITLE, re.I)
#: The FIELD half - software's own titles - which `filters.skip_title` replaces.
_DEFAULT_SKIP_TITLE = (
    r"qa|test|ios|android|mobile|data engineer|machine learning|devops|sre"
)


#: The braces `_alternation` wraps a keyword in, as one pattern: a spelling is read back out of a
#: compiled gate by taking these off, and doing it here keeps that reading in one place.
BRACE = re.compile(r"\(\?<!\[A-Za-z0-9\]\)|\(\?!\[A-Za-z0-9\]\)")


def _alternation(keywords) -> str | None:
    """One regex alternative per keyword, each braced so it matches a WORD and not a substring.

    A word, not a substring: `nurse` must not screen in "Nursery School Teacher". The brace is
    `(?<![A-Za-z0-9]) ... (?![A-Za-z0-9])` rather than `\\b`, because `\\b` already treats a hyphen as a
    word boundary - so `\\b` before the main word and after it would refuse "Nurse-Practitioner", which
    is the spelling boards actually use, while still refusing "nurse" inside "nurses" on the trailing
    side. Alphanumerics only, so a keyword is never screenable through punctuation it does not contain.
    """
    parts = []
    for raw in keywords if isinstance(keywords, (list, tuple)) else [keywords]:
        word = str(raw).strip()
        if word:
            escaped = re.escape(word)
            parts.append(f"(?<![A-Za-z0-9]){escaped}(?![A-Za-z0-9])")
    return "|".join(parts) if parts else None


def _track_keywords(profile: dict | None) -> list[str]:
    """Every `resume_tracks[*].keywords` entry, in file order, deduplicated case-insensitively.

    Deduplicated because this is a dict of tracks and two of them may describe one word - the profile
    on this checkout has "ui" in one track and could gain it in another - and a duplicate alternative
    changes nothing except the length of the pattern a person has to read in a report.
    """
    words = [str(k).strip() for track in (profile or {}).get("resume_tracks", {}).values()
             if isinstance(track, dict) for k in (track.get("keywords") or [])]
    return list(dict.fromkeys(word.lower() for word in words if word))


def _pattern(spec, default=None) -> re.Pattern | None:
    """One compiled pattern from a registry value, or None when there is nothing to match.

    A LIST is joined into one braced alternation, so a registry can spell a field as the words it is
    described by ("registered nurse", "RN", "nurse practitioner") instead of as a regex nobody can
    maintain. A STRING is taken as the regex it is: someone who writes `\\bRN\\b` means it, and a
    regex is the escape hatch for the field that a word list cannot describe. An empty list is not a
    pattern that matches nothing; it is the absence of a gate, which is why it returns None.
    """
    if spec is None:
        spec = default
    if isinstance(spec, (list, tuple)):
        spec = _alternation(spec)
    if not isinstance(spec, str) or not spec.strip():
        return None
    return re.compile(spec, re.I)


def field_patterns(registry: dict | None = None, profile: dict | None = None):
    """Compile the field and region gates. Returns `(FieldPatterns, note)`.

    ONE CALL, ONE ANSWER. These were six module constants, five of them regexes that had to be edited
    in the source to search for anything but software engineering; a nurse or a designer running this
    screen got `not_engineering` on every posting and a report that said it had found nothing. The
    registry (`filters`) and the applicant's own profile are now the two places a search is
    described, and this function is the only thing that reads them.

    PRECEDENCE, and why it is this order:

      * `filters.field_include` when the registry states it - an explicit answer beats a derived one.
      * otherwise the profile's `resume_tracks[*].keywords`, because "what field are you in" is
        already recorded there and this screen was ignoring it. The tracks are a dict, so the
        keywords are concatenated in file order; deduplicated case-insensitively, in case two tracks
        spell the same word.
      * otherwise the software default, WITH A NOTE. Dropping everything is the one outcome that
        cannot be recovered from - the run looks like a quiet market rather than a misconfiguration -
        so the default is kept and the note names both places to set the field. The note is returned
        rather than printed, because this screen also runs unattended (`daily_screen.py`), where the
        report is the only place a person can read it.

    REGION IS ALL-OR-NOTHING WITH THE FIELD IT WAS CONFIGURED FOR - see the comment below the
    precedence list: naming a field and no region means NO region gate, not someone else's.
    """
    registry = registry or {}
    filters = registry.get("filters")
    if not isinstance(filters, dict):
        filters = {}

    default_field = _DEFAULT_FIELD_INCLUDE
    note = ""
    if not filters.get("field_include"):
        keywords = [str(k).strip() for track in (profile or {}).get("resume_tracks", {}).values()
                    if isinstance(track, dict) for k in (track.get("keywords") or [])]
        keywords = [k for k in keywords if k]
        deduped = list(dict.fromkeys(k.lower() for k in keywords))
        if deduped:
            default_field = "|".join(re.escape(k) for k in deduped)
            # SAY WHICH WORDS GATED THE RUN, EVERY TIME THEY COME FROM SOMEWHERE BUT THE REGISTRY. The
            # keywords were used silently at first, and a profile whose tracks describe a SPECIALISM
            # rather than a field - "backend", "api", "rest", "distributed" - screens out every posting
            # titled with the field's own name. Measured on one real profile: 217 "Software Engineer"
            # postings counted `not_engineering` with nothing saying why. A gate decides what the
            # applicant never sees, so which words are behind it is not a detail to infer from a count.
            note = (f"field gate taken from {CANDIDATE_PATH} -> resume_tracks[*].keywords: "
                    f"{', '.join(deduped)}. If that is narrower than your field - if a posting titled "
                    f"with the field's own name would be screened out - put the full list in "
                    f"`filters.field_include` in {SOURCES_PATH}, which takes precedence.")
        else:
            note = (f"no field configured: `filters.field_include` in {SOURCES_PATH} is absent "
                    f"and {CANDIDATE_PATH} -> resume_tracks has no keywords, so the "
                    f"software-engineering default is screening this run. Put the words your field "
                    f"is described by in either place - nothing else in the tool knows what you do.")

    # REGION IS ALL-OR-NOTHING WITH THE FIELD IT WAS CONFIGURED FOR. A registry that names a field but
    # no region gets NO region gate, not the US patterns: "which region can I work in" is as much a
    # fact about the applicant as the field is, and answering it on their behalf is how a Sydney
    # posting ends up unreported. Configuring a field is a deliberate act, so it is the point at which
    # the silently-inherited region stop; a registry that configures neither still behaves as it did.
    # The region gates have a second spelling - a title sometimes carries the region when the location
    # field does not - so naming either spelling counts as naming the region.
    named_region = any(filters.get(k) for k in ("region_include", "region_exclude",
                                                "title_region_include", "title_region_exclude"))
    defaults = dict(field_include=default_field,
                    field_exclude=_DEFAULT_FIELD_EXCLUDE,
                    title_topics_exclude=_DEFAULT_TITLE_TOPICS_EXCLUDE,
                    skip_title=_DEFAULT_SKIP_TITLE,
                    region_include=None if (filters.get("field_include") or named_region) else _DEFAULT_REGION_INCLUDE,
                    region_exclude=None if (filters.get("field_include") or named_region) else _DEFAULT_REGION_EXCLUDE,
                    title_region_include=None if (filters.get("field_include") or named_region) else _DEFAULT_TITLE_REGION_INCLUDE,
                    title_region_exclude=None if (filters.get("field_include") or named_region) else _DEFAULT_TITLE_REGION_EXCLUDE)
    if filters:
        # A NEGATIVE PREFERENCE IS A PERSONAL ANSWER, and nothing else can supply it. Once a `filters`
        # block exists at all it is that person's own statement of what they are looking for, so the
        # shipped negatives are dropped unless they are named back - a blocked title is a posting
        # nobody ever sees, and the safe direction is to show one that could have been hidden rather
        # than to hide one that could have been shown. With no `filters` block there is nothing to be
        # preserved and the defaults stand, which is why an unconfigured run is unchanged.
        for key in ("field_exclude", "title_topics_exclude", "skip_title"):
            if not filters.get(key):
                defaults[key] = None

    patterns = FieldPatterns(
        field_include=_pattern(filters.get("field_include"), defaults["field_include"]),
        field_exclude=_pattern(filters.get("field_exclude"), defaults["field_exclude"]),
        title_topics_exclude=_pattern(filters.get("title_topics_exclude"),
                                      defaults["title_topics_exclude"]),
        region_include=_pattern(filters.get("region_include"), defaults["region_include"]),
        region_exclude=_pattern(filters.get("region_exclude"), defaults["region_exclude"]),
        title_region_include=_pattern(filters.get("title_region_include"),
                                      defaults["title_region_include"]),
        title_region_exclude=_pattern(filters.get("title_region_exclude"),
                                      defaults["title_region_exclude"]),
        skip_title=_pattern(filters.get("skip_title"), defaults["skip_title"]),
    )
    return patterns, note


class LevelPatterns(NamedTuple):
    """The words a posting's LEVEL is read from, as one answer rather than four module constants.

    THE LEVEL AND THE FIELD ARE TWO QUESTIONS, which is why this is a second block and not four more
    keys in `filters`. `field_include` answers "is this posting my field" and every word in it is a
    word for the work; "senior", "staff", "principal" and "lead" are words for how much of it someone
    has done, they are spelled the same in every field, and a nurse's posting saying "Senior" was
    always read correctly. What is NOT the same in every field is the spelling a field gives its own
    rungs - software writes "Software Engineer II", "SWE II", "IC2", nursing writes "RN II" and law
    writes "Associate" - and the four patterns below were software's, written into the source.

    Each pattern says what it decides, and they are read in this order (`daily_screen.level_of`):

      junior      the first rung, and what the ranking weights above everything else it is asked about
      mid         the second rung
      senior      senior/staff/principal/lead, and `daily_screen` keeps these in scope
      management  TITLES THAT ARE OUT OF SCOPE RATHER THAN A LEVEL. This is the one pattern here whose
                  match REMOVES a posting from the run, and it is the reason the levels block has to
                  be configuration: a nurse's "Director of Nursing" and a lawyer's "Managing Partner"
                  were not management to a list of software words, so they were kept and ranked as if
                  they were the roles the applicant had asked for.

    None of the four is ever None. A level is a slot in a fixed order rather than a gate, so a registry
    that names no words still gets the shipped ones - which is what an unconfigured run has always
    used, character for character (`test_screen_patterns.py`).
    """

    junior: re.Pattern
    mid: re.Pattern
    senior: re.Pattern
    management: re.Pattern


# THE SHIPPED LEVELS ARE ONE PERSON'S FIELD SPELLED OUT, and they are the text the four module
# constants in `daily_screen.py` carried before this block existed - unchanged, character for
# character, because an unconfigured run must screen exactly as it did. `levels` in
# <data>/screening/sources.json replaces any of the four; a LIST is the words themselves (joined as
# whole words, the same spelling `filters` uses) and a STRING is a regex.
#
# THE WORDS THE LEVELS ARE WRITTEN WITH COME FROM THE FIELD, so a registry that states its field and
# not its levels is read with software's rungs. Both mistakes that causes are in the direction that
# loses nothing and both are visible in the run itself: a posting titled "RN II" comes back
# `level: unknown` and loses the ranking weight its rung has earned, and a management title in that
# field - "Director of Nursing" - is not recognised as one, so it is KEPT and ranked, which is one
# posting read too many rather than one nobody ever sees. That is why there is no note of its own here:
# `field_patterns` has one because its gate DELETES postings from the report, and this one does not.
_DEFAULT_LEVEL_JUNIOR = (
    r"\bjunior\b|software engineer i\b|\bswe i\b|\bic1\b|level 1\b|associate software engineer"
)
_DEFAULT_LEVEL_MID = (
    r"mid-?level|software engineer ii\b|\bswe ii\b|\bic2\b|level 2\b|software engineer 2\b"
)
_DEFAULT_LEVEL_SENIOR = r"\bsenior\b|staff|principal|\blead\b"
# "PRINCIPAL ENGINEER" STAYS IN SCOPE, because it is an individual-contributor title and the contract
# keeps strong senior roles - so the management vocabulary must never pair a bare "engineer" with
# "principal". What is out is the manager/lead TRACK, which is what the two orderings below spell out:
# a field word followed by a management word, or a management word followed by a field word.
_DEFAULT_LEVEL_MANAGEMENT = (
    r"\b(?:engineering|software|technical|technology|sre|infrastructure|platform|data|devops|ml|ai"
    r"|web|frontend|backend|full[- ]?stack)\s+"
    r"(?:vice president|vp|director|manager|lead|head|chief)\b"
    r"|\b(?:vice president|vp|director|manager|head|chief)\s*,?\s*(?:of\s+)?"
    r"(?:engineering|software|technical|technology|sre|infrastructure|platform|data|devops|ml|ai"
    r"|web|frontend|backend|full[- ]?stack)\b"
)


def level_patterns(registry: dict | None = None) -> LevelPatterns:
    """Compile the four level patterns from the registry's `levels` block, or from the shipped words.

    ONE CALL PER RUN, like `field_patterns`: the patterns are an argument to `level_of` rather than
    module state, so a run cannot read a vocabulary it did not pass in and a caller can ask what a
    nursing registry's levels are without changing what the software one screens.

    THE REGISTRY IS THE ONLY SOURCE. `field_include` has a second home - the applicant's own
    `resume_tracks[*].keywords`, where "what field are you in" is already written - and levels have
    none, because a track's keywords describe the WORK (backend, api, distributed) and not the rung
    ("Nurse II" is a level word, and a track that listed it would be listing a level as a keyword).
    A registry that names no levels gets the shipped ones, which is what it has always screened with.
    """
    registry = registry or {}
    levels = registry.get("levels")
    if not isinstance(levels, dict):
        levels = {}
    return LevelPatterns(
        junior=_pattern(levels.get("junior"), _DEFAULT_LEVEL_JUNIOR),
        mid=_pattern(levels.get("mid"), _DEFAULT_LEVEL_MID),
        senior=_pattern(levels.get("senior"), _DEFAULT_LEVEL_SENIOR),
        management=_pattern(levels.get("management"), _DEFAULT_LEVEL_MANAGEMENT),
    )


# A POSTING'S OWN TITLE IS SOMETIMES ONLY IN ITS PROSE, and the words that find it there are the
# applicant's field, for the same reason the gate is: the three phrases this replaced were
# "software engineer", "backend engineer" and "full[- ]stack engineer", so a nursing or legal JD
# extracted nothing and `job_app_assistant` reported and FILED the posting as "Unknown role" - the
# value reaches the resume's filename and the tracker row, not just a printout.
#
#: The phrases as `job_app_assistant` carried them, written out so the fallback is compared with the
#: text that shipped rather than described as having preserved it (`test_screen_patterns.py`). They are
#: whole patterns rather than words: each one CARRIES ITS CAPTURE GROUP, because what the caller wants
#: is the substring of prose that reads like a title, and `(?i)` is at the front for the same reason it
#: always was.
_LEGACY_TITLE_PHRASES = (
    r"(?i)\b(software engineer[^\n|]{0,80})",
    r"(?i)\b(backend engineer[^\n|]{0,80})",
    r"(?i)\b(full[- ]stack engineer[^\n|]{0,80})",
)


def title_phrases(registry: dict | None = None, profile: dict | None = None) -> list[str]:
    """Regexes that find a posting's own job title in its description, from the applicant's field.

    Each returned pattern carries ONE capture group, which is the title; the caller reads `group(1)`.

    THE FIELD IS THE SOURCE, in `field_patterns`' precedence and for its reason: `filters.field_include`
    is the explicit answer, `resume_tracks[*].keywords` is where "what field are you in" is already
    recorded, and the three software phrases are what a run that names no field falls back to. A
    phrase starts at a word of the field and carries the rest of the line, which is what a title looks
    like in prose ("Registered Nurse - Medical Surgical" is one line of a JD body).

    IT IS A FALLBACK AND IT READS LIKE ONE. The caller tries the page's own title markup first and
    only then these, so a coarser phrase costs nothing where the markup exists - and what the captured
    text is taken from is prose, where "Engineer" is a word the sentence may carry two more of. The
    operator still has `--role`, which is the tool's own answer for a title this cannot do justice to.
    """
    registry = registry or {}
    filters = registry.get("filters")
    if not isinstance(filters, dict):
        filters = {}
    spec = filters.get("field_include") or _track_keywords(profile)
    if isinstance(spec, (list, tuple)):
        inner = _alternation(spec)
    else:
        inner = str(spec).strip()
        # A leading flag group is this pattern's own business, not the field's: `(?i)` compiles at the
        # start of a field regex but not inside the group it is placed in here, and the case-sensitivity
        # it asks for is the one the pattern below is written with anyway.
        inner = re.sub(r"^\(\?[aiLmsux]+\)", "", inner)
    if not inner:
        return list(_LEGACY_TITLE_PHRASES)
    return [rf"(?i)\b((?:{inner})[^\n|]{{0,80}})"]


def level_vocabulary(registry: dict | None = None) -> list[str]:
    """The words the registry's `levels` block spells its own rungs with, as words.

    `level_patterns` answers "which rung is this title"; this answers "which words name a rung at all",
    which is what a REPORT needs. `job_app_assistant` is the caller: its "Seniority hints" line names
    the spellings of the junior and mid rungs the posting used, and the three software ones it carried
    ("software engineer i", "software engineer ii", "ic2") were a second copy of what `levels.junior`
    and `levels.mid` already say. A registry that numbers its rungs "Nurse I" and "RN II" must not be
    reported in software's words.

    READ FROM THE SAME BLOCK `level_patterns` READS, resolved the same way, so the two cannot disagree
    about what the vocabulary is. A LIST is the words themselves - already whole words by
    `_alternation`'s braces, which are stripped here because the caller matches them against text - and
    a STRING is a regex, whose literal alternatives are reported as words. The braces, and the anchors a
    regex carries, are the pattern's business and not part of the spelling.

    EACH CANDIDATE IS CHECKED AGAINST THE PATTERN IT CAME FROM, which is what keeps the answer a
    vocabulary: `mid-?level` yields the word "mid" as a substring, and a substring that matches is not an
    alternative on its own, so it is dropped rather than reported as a rung. `senior` and `management`
    are deliberately absent: they decide the ranking and the removal, and this is the list of the rungs
    the applicant is looking for.
    """
    registry = registry or {}
    levels = registry.get("levels")
    resolved = level_patterns(registry if isinstance(levels, dict) else {})
    words: list[str] = []
    for rung in ("junior", "mid"):
        pattern = getattr(resolved, rung)
        for raw in re.split(r"\|", pattern.pattern):
            # The braces and anchors are how the gate matches; the spelling is what is left.
            spelling = BRACE.sub("", raw)
            spelling = re.sub(r"^\(\?<![^)]*\)|\(\?![^)]*\)$|\\b|\^|\$", "", spelling).strip()
            spelling = re.sub(r"^\(\?[aiLmsux]+\)", "", spelling)
            spelling = re.sub(r"\\(.)", r"\1", spelling)
            if not spelling or "?" in spelling:
                continue
            # A substring is not an alternative: "mid" is inside `mid-?level` and names no rung by itself.
            if not pattern.fullmatch(spelling):
                continue
            if spelling.lower() not in words:
                words.append(spelling.lower())
    return words


def load_sources() -> dict:
    """The screening registry, or {} when the file is absent or malformed.

    Absent, not fatal: every gate has a defined fallback and `field_patterns` says what it chose, so
    an unconfigured checkout screens conservatively instead of failing to start.
    """
    try:
        return json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def load_candidate_profile() -> dict:
    """`data/candidate_profile.json`, or {} when it is absent or malformed - see `load_sources`."""
    try:
        return json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}




def fetch(url, payload=None, timeout=30):
    headers = dict(UA)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def as_loc(x):
    if isinstance(x, dict):
        return x.get("name") or x.get("locationName") or ""
    return x if isinstance(x, str) else ""


def board_greenhouse(slug, name):
    data = fetch(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    out = []
    for j in data.get("jobs", []):
        out.append({
            "company": name,
            "title": j.get("title", ""),
            "location": as_loc(j.get("location")),
            "url": j.get("absolute_url", ""),
            "platform": "greenhouse",
            "posted": parse_dt(j.get("first_published") or j.get("updated_at")),
            "extra": j.get("department") or "",
        })
    return out


def board_lever(slug, name):
    data = fetch(f"https://api.lever.co/v0/postings/{slug}?mode=json")
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


def board_ashby(slug, name):
    data = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false")
    out = []
    for j in data.get("jobs", []):
        locs = [as_loc(j.get("location"))]
        for s in j.get("secondaryLocations") or []:
            if isinstance(s, dict):
                locs.append(as_loc(s.get("location")))
        jid = j.get("id") or ""
        out.append({
            "company": name,
            "title": j.get("title", ""),
            "location": "; ".join(x for x in locs if x),
            "url": j.get("url") or (f"https://jobs.ashbyhq.com/{slug}/{jid}" if jid else ""),
            "platform": "ashby",
            "posted": parse_dt(j.get("firstPublishedAt") or j.get("createdAt")),
            "extra": j.get("department") or "",
        })
    return out


def parse_posted_on(s):
    """'Posted Today' / 'Posted 3 Days Ago' / 'Posted 30+ Days Ago' -> datetime."""
    if not s:
        return None
    m = re.match(r"Posted (Today|(\d+)\+?\s*(Day|Week|Month|Year)s? Ago)", s or "", re.I)
    if not m:
        return None
    now = datetime.now(timezone.utc)
    if m.group(1) == "Today":
        return now
    days = {"day": 1, "week": 7, "month": 30, "year": 365}[m.group(3).lower()] * int(m.group(2))
    return now - timedelta(days=days)


def board_workday(entry):
    host, tenant, site, name = entry
    base = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    seen = {}
    out = []
    failed = 0
    for q in WORKDAY_QUERIES:
        offset = 0
        total = None
        while True:
            try:
                data = fetch(base, payload={
                    "appliedFacets": {}, "limit": WORKDAY_PAGE, "offset": offset, "searchText": q,
                })
            except urllib.error.HTTPError as e:
                if e.code in (400, 404):
                    break
                raise
            except Exception:
                failed += 1
                break
            postings = data.get("jobPostings") or []
            if total is None:
                total = data.get("total") or 0
            for j in postings:
                path = j.get("externalPath") or ""
                key = path or f"{j.get('title','')}{j.get('locationsText','')}"
                if not key or key in seen:
                    continue
                seen[key] = True
                out.append({
                    "company": name,
                    "title": j.get("title", ""),
                    "location": j.get("locationsText") or "",
                    "url": f"https://{host}/{site}{path}" if path else "",
                    "platform": "workday",
                    "posted": parse_posted_on(j.get("postedOn")),
                    "extra": " / ".join(j.get("bulletFields") or [])[:80],
                })
            offset += WORKDAY_PAGE
            if not postings or offset >= total or offset >= WORKDAY_QUERY_CAP:
                break
    if failed == len(WORKDAY_QUERIES):
        raise RuntimeError("all workday queries failed (network/tenant/site mismatch)")
    return out


def is_us(loc, patterns: FieldPatterns):
    """Whether a location field means the configured region. None means "this does not decide".

    None is returned both for an empty location field and for a registry that configures no region at
    all - an absent gate is not a gate. The caller then falls back to the region a TITLE names, if it
    configured one of those, rather than treating "unconfigured" as "not in my region".

    The patterns are an argument, not module state: the same helper answers for an Australian registry,
    and no caller can read a stale pattern it did not pass in.
    """
    if not loc or patterns.region_include is None:
        return None  # unknown
    return bool(patterns.region_include.search(loc)) and not (
        patterns.region_exclude and patterns.region_exclude.search(loc))


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", t.lower())


def load_tracker():
    """Rows that name a company. Delegates the read to the shared module.

    This used to open the tracker with plain `utf-8` while every other screen used `utf-8-sig`. It
    survived only because the BOM lands on the FIRST column key and this function reads `company`; any
    future use of `date_added` here would have raised KeyError on row one. The shared reader fixes that
    by construction. The company filter is behaviour, so it stays."""
    if not (DATA_DIR / "applications.csv").exists():
        return []
    return [r for r in load_rows() if r.get("company")]


def tracker_status(job, tracker_rows):
    jc = job["company"].lower()
    jt = norm_title(job["title"])
    for t in tracker_rows:
        tc = re.sub(r"\s*(inc\.|corp\.|llc)\s*", "", t["company"].lower())
        if tc not in jc and jc not in tc:
            continue
        tt = norm_title(t.get("title", ""))
        if tt and (tt in jt or jt in tt):
            return t.get("status", "tracked")
    return None


def sort_jobs(js):
    js.sort(key=lambda j: j.get("posted_iso") or "", reverse=True)
    js.sort(key=lambda j: (0 if j["seattle_wa"] else 1, 0 if j.get("posted_iso") else 1))


def print_table(rows, extra_cols=()):
    print(f"{'SEATTLE':<8}{'COMPANY':<20}{'TITLE':<56}{'LOC':<28}{'POSTED':<12}{'PLATFORM':<11}{'' if not extra_cols else ' | '.join(extra_cols)}")
    print("-" * (135 + 20 * len(extra_cols)))
    # collapse identical (company,title) display rows; all postings stay in the files
    shown = {}
    for j in rows:
        k = (j["company"], j["title"])
        if k in shown:
            shown[k]["_n"] += 1
            continue
        shown[k] = dict(j, _n=1)
    for j in shown.values():
        flag = "SEA/WA" if j["seattle_wa"] else ("?" if j["us_confirmed"] is None else "")
        n = f" x{j['_n']}" if j["_n"] > 1 else ""
        print(f"{flag:<8}{j['company']:<20}{(j['title'] + n)[:55]:<56}{j['location'][:27]:<28}{j['posted_iso'] or 'n/d':<12}{j['platform']:<11}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="recency window in days")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)
    tracker_rows = load_tracker()
    # One call, and the field/region gates are decided for the whole run before a single board is
    # fetched. The note is printed here as well as carried into the JSON: this is the only screen that
    # a person still runs by hand, so it is the one place a missing `filters` block can be noticed.
    patterns, field_note = field_patterns(load_sources(), load_candidate_profile())
    if field_note:
        print(f"# {field_note}\n")

    tasks = (
        [("greenhouse", s, n) for s, n in GREENHOUSE.items()]
        + [("lever", s, n) for s, n in LEVER.items()]
        + [("ashby", s, n) for s, n in ASHBY.items()]
        + [("workday", e, e[3]) for e in WORKDAY]
    )
    board_fn = {
        "greenhouse": board_greenhouse,
        "lever": board_lever,
        "ashby": board_ashby,
        "workday": board_workday,
    }

    results = {}
    board_report = {}

    def run(task):
        platform, key, name = task
        try:
            jobs = board_fn[platform](key, name) if platform != "workday" else board_fn[platform](key)
            board_report[task] = f"ok ({len(jobs)} jobs)"
            return jobs
        except urllib.error.HTTPError as e:
            board_report[task] = f"HTTP {e.code}"
            return []
        except Exception as e:  # noqa: BLE001
            board_report[task] = f"error: {type(e).__name__}: {e}"
            return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for task, jobs in zip(tasks, pool.map(run, tasks)):
            results[task] = jobs

    new_jobs, tracker_jobs, intern_jobs = [], [], []
    dropped = {"stale": 0, "not_us": 0, "not_newgrad": 0, "not_eng": 0}
    seen_urls = set()
    for jobs in results.values():
        for j in jobs:
            if not j.get("url") or j["url"] in seen_urls:
                continue
            title = j.get("title", "")
            if not NEW_GRAD_RE.search(title):
                dropped["not_newgrad"] += 1
                continue
            if (not patterns.field_include.search(title)
                    or (patterns.field_exclude and patterns.field_exclude.search(title))
                    or (patterns.title_topics_exclude and patterns.title_topics_exclude.search(title))):
                dropped["not_eng"] += 1
                continue
            if patterns.title_region_exclude and patterns.title_region_exclude.search(title):
                dropped["not_us"] += 1
                continue
            us = is_us(j.get("location", ""), patterns)
            if us is False:
                dropped["not_us"] += 1
                continue
            if us is None and patterns.title_region_include \
                    and patterns.title_region_include.search(title):
                us = True
            posted = j.get("posted")
            if posted is not None and posted < cutoff:
                dropped["stale"] += 1
                continue
            j["us_confirmed"] = us
            j["seattle_wa"] = bool(SEA_RE.search(j.get("location", "")))
            j["posted_iso"] = posted.date().isoformat() if posted else ""
            j["tracker_status"] = tracker_status(j, tracker_rows)
            seen_urls.add(j["url"])
            if j["tracker_status"]:
                tracker_jobs.append(j)
            elif INTERN_RE.search(title):
                intern_jobs.append(j)
            else:
                new_jobs.append(j)

    sort_jobs(new_jobs)
    sort_jobs(tracker_jobs)
    sort_jobs(intern_jobs)

    stamp = now.date().isoformat()
    out_json = OUT_DIR / f"newgrad_screen_{stamp}.json"
    out_csv = OUT_DIR / f"newgrad_screen_{stamp}.csv"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(
        {"new": new_jobs, "already_tracked": tracker_jobs, "interns": intern_jobs,
         "dropped": dropped, "field_note": field_note}, indent=2, default=str))
    fields = ["section", "company", "title", "location", "platform", "posted_iso",
              "seattle_wa", "us_confirmed", "tracker_status", "url", "extra"]
    with out_csv.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for section, rows in (("new", new_jobs), ("already_tracked", tracker_jobs),
                              ("interns", intern_jobs)):
            for j in rows:
                w.writerow({**{k: j.get(k, "") for k in fields[:-1]}, "section": section})

    print(f"# New-grad screening — {stamp} (recency window: {args.days} days)\n")
    print(f"new: {len(new_jobs)}  already in tracker: {len(tracker_jobs)}  "
          f"interns: {len(intern_jobs)}  dropped: {dropped}\n")
    print("## NEW — not yet in applications.csv (SEATTLE/WA first, then US, newest first)")
    print_table(new_jobs)
    if tracker_jobs:
        print("\n## ALREADY IN applications.csv (dedupe — skip these)")
        print_table(tracker_jobs)
    if intern_jobs:
        print("\n## INTERNSHIPS (2027 cycle, optional — not new-grad FT)")
        print_table(intern_jobs)
    print(f"\nSaved: {out_json}\nSaved: {out_csv}\n")

    print("## Board report (failures are unverified slugs or platforms without public APIs)")
    for (platform, key, name), status in sorted(board_report.items()):
        if not status.startswith("ok"):
            label = key[2] if platform == "workday" and isinstance(key, tuple) else key
            print(f"  {platform:<10} {name:<20} {str(label):<28} {status}")
    ok_count = sum(1 for s in board_report.values() if s.startswith("ok"))
    print(f"  resolved {ok_count}/{len(board_report)} boards")


if __name__ == "__main__":
    main()
