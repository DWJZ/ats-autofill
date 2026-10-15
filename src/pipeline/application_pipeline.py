#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
if str(ROOT / "src" / "metrics") not in sys.path:
    sys.path.insert(0, str(ROOT / "src" / "metrics"))

# The one definition of where this checkout's configuration lives (`ATS_DATA_DIR`). The path is not built
# here any more: every subcommand reads the data directory as it stands, and that directory is a setting
# rather than a name. (`preflight` used to be one of them; it was removed on 2026-10-06 - see ledger.py
# for why its event name survives.)
from src.paths import DATA_DIR

# ONE DEFINITION OF THE DEGREE MAPPING. `draft_form_spec.py` resolves the profile's own "M.S." onto
# the option text a degree SELECT offers; this module types the same value into a Greenhouse education
# block, so it imports that resolver rather than keeping a second copy to drift apart. The dependency
# runs pipeline -> forms and never the reverse: the drafter is deliberately stdlib-only so it runs
# under a plain `python3`, which is why it mirrors this module's `_linkedin` instead of importing it.
from src.forms.draft_form_spec import degree_option  # noqa: E402

# THE GENERATED ATS CONFIGS ARE PER-PERSON STATE, SO THEY LIVE WITH THE OTHER PER-PERSON STATE.
# They were written to `src/autofill/<platform>/<slug>.json` - which is the directory that also holds
# real source (the Workday helpers) and the README calls "per-platform helpers and notes". Nothing in
# .gitignore covers it, so `git add -A` in a configured checkout committed the applicant's name,
# email, phone, city and standard answers. That is the one thing rule 3 of this repository forbids
# outright.
# They are derived per job from the profile and can be regenerated, so they belong under the data
# directory, which is where ATS_DATA_DIR exists to move them out of the checkout entirely.
AUTOFILL_DIR = DATA_DIR / "autofill"

#: The platforms that get a generated config, and therefore a directory under AUTOFILL_DIR.
PLATFORM_CONFIG_DIRS = ("greenhouse", "ashby", "workday", "phenom", "smartrecruiters", "lever")

import job_app_assistant
from generate_tailored_resume import generate, load_json, slugify
from resume_artifacts import export_and_validate_pdf
# The cover-letter builder owns the letter's wording and naming; `prepare --cover-letter` asks it for the PDF
# the README's drafter step attaches (output/pdf/<...>_Cover_Letter.pdf) rather than building a second letter.
from build_cover_letter import build_letter_pdf

# ONE list, used by every subcommand. It was written out three times, and the copies drifted: the
# `preflight` subcommand (removed 2026-10-06) learned `workable` while `prepare` and `handover` did not, so
# `prepare --platform workable` was rejected for a Workable application (ECP, 2026-10-04) even though the
# preflight had already identified the platform correctly. A platform the pipeline can detect is a platform
# the pipeline must accept.
PLATFORM_CHOICES = ["auto", "greenhouse", "ashby", "workday", "phenom", "smartrecruiters", "lever", "workable", "eightfold"]

# Not a choice: it is what `detect_platform` returns for a host it does not know, and `prepare` refuses it
# rather than guessing a helper. Named here because `PLATFORM_CHOICES` deliberately does not hold it, so every
# list of "the platforms this pipeline knows" needs it spelled out rather than accidentally omitted.
UNSUPPORTED_PLATFORM = "unsupported"

# The ledger is telemetry. `record()` already swallows its own failures, but a missing or broken
# ledger module would fail this IMPORT and take prepare / record-status / handover down with it —
# telemetry must never be able to break an application, so the fallback is a silent no-op.
try:
    import ledger
except Exception:  # noqa: BLE001 -- a broken ledger must not stop an application
    class _NullLedger:
        PREFLIGHT = "preflight"
        PREPARE = "prepare"
        CLOSED = "closed"

        @staticmethod
        def record(*_args, **_kwargs):
            return None

    ledger = _NullLedger()


APP_PROFILE_PATH = DATA_DIR / "application_profile.json"
CANDIDATE_PROFILE_PATH = DATA_DIR / "candidate_profile.json"
TRACKER_PATH = DATA_DIR / "applications.csv"
BUNDLES_DIR = DATA_DIR / "application_bundles"
# `submitted_by_agent` = the tool clicked Submit under the user's standing authorization;
# `submitted_by_user` = the user submitted it themselves.
SUBMITTED_STATUSES = {"submitted_by_user", "submitted_by_agent"}
TERMINAL_STATUSES = SUBMITTED_STATUSES | {"not_applied"}


def resolve(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def detect_platform(url: str, explicit: str = "auto") -> str:
    if explicit != "auto":
        return explicit
    host = urlparse(url).netloc.lower()
    if "greenhouse.io" in host or "greenhouse.com" in host:
        return "greenhouse"
    if "ashbyhq.com" in host:
        return "ashby"
    if "myworkdayjobs.com" in host or "myworkdaysite.com" in host:
        return "workday"
    if "phenompeople.com" in host or host.startswith("careers.chewy.com"):
        return "phenom"
    if "smartrecruiters.com" in host:
        return "smartrecruiters"
    if "lever.co" in host:
        return "lever"
    if "workable.com" in host:
        return "workable"
    # Microsoft's careers site runs on Eightfold. curl cannot read its search API from this machine at all
    # (http=000) and its posting pages carry no form controls, so the board is read from the RENDERED page with
    # `cdp_tabs.mjs text`, and the application REQUIRES an account sign-in - which makes it a handover by design.
    if "careers.microsoft.com" in host or "eightfold.ai" in host:
        return "eightfold"
    return UNSUPPORTED_PLATFORM


def read_tracker(path: Path = TRACKER_PATH) -> tuple[list[str], list[dict]]:
    if not path.exists():
        return [
            "date_added", "company", "title", "source", "eligibility",
            "recommended_track", "track_scores", "status", "notes",
        ], []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        return list(reader.fieldnames or []), list(reader)


def tracker_match(url: str, path: Path = TRACKER_PATH) -> dict | None:
    _, rows = read_tracker(path)
    normalized = url.rstrip("/")
    return next((row for row in rows if row.get("source", "").rstrip("/") == normalized), None)


def normalize_text(value: str) -> str:
    """Loose key for company/role comparison: case, punctuation and spacing are ignored, so
    'Staff+ Software Engineer, Distributed Systems' and 'Staff+ Software Engineer - Distributed
    Systems' collapse to the same key."""
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def role_matches(company: str, title: str, path: Path = TRACKER_PATH) -> list[dict]:
    """Rows for the same company + role under any URL. A role can be re-posted with a new ATS id,
    so URL equality alone is not a duplicate check."""
    _, rows = read_tracker(path)
    key = (normalize_text(company), normalize_text(title))
    return [row for row in rows if (normalize_text(row.get("company", "")), normalize_text(row.get("title", ""))) == key]


def duplicate_groups(path: Path = TRACKER_PATH) -> dict[tuple[str, str], list[dict]]:
    """Every (company, role) key that appears more than once in the tracker."""
    _, rows = read_tracker(path)
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        key = (normalize_text(row.get("company", "")), normalize_text(row.get("title", "")))
        if not key[0] or not key[1]:
            continue
        groups.setdefault(key, []).append(row)
    return {key: value for key, value in groups.items() if len(value) > 1}


def upsert_tracker(row: dict, path: Path = TRACKER_PATH, allow_status_change: bool = False) -> dict:
    fieldnames, rows = read_tracker(path)
    existing = next((item for item in rows if item.get("source") == row["source"]), None)
    if existing:
        preserved_status = existing.get("status", "")
        existing.update({key: value for key, value in row.items() if value not in (None, "")})
        # PROTECT A SUBMISSION, NOT MERELY A TERMINAL STATUS. This used to restore any status in
        # TERMINAL_STATUSES, which includes "not_applied" - so a row recorded but never sent could NEVER be
        # promoted to submitted_by_agent: record-status printed the new status while the file silently kept the old
        # one, twice in a row on 2026-10-06 (Raydar and Brex), and each time the row had to be repaired by hand.
        # Downgrading a real submission is already refused by record_status itself, which exits unless --force is
        # passed, so preserving submissions here is enough and preserving "not_applied" only lost information.
        #
        # allow_status_change exists because this preservation DEFEATED --force (found 2026-10-07): record_status
        # accepted the correction, printed the new status, called here - and the old submission was put straight
        # back, so three Palantir rows stayed marked submitted after they were found never to have been sent. The
        # only visible symptom was that the tool's own stdout disagreed with the file. A deliberate correction now
        # reaches the file; every other caller keeps the protection.
        if preserved_status in SUBMITTED_STATUSES and not allow_status_change:
            existing["status"] = preserved_status
        result = existing
    else:
        result = {name: row.get(name, "") for name in fieldnames}
        rows.append(result)

    # Validate before touching the file: a row whose notes field was split by
    # an unquoted comma carries a None key, which would make DictWriter crash
    # mid-write and truncate the live tracker.
    for index, item in enumerate(rows):
        unknown = [key for key in item if key is None or key not in fieldnames]
        if unknown:
            raise SystemExit(
                f"Refusing to write tracker: row {index + 2} ({item.get('company', '?')}) "
                f"has fields outside the header {unknown}; fix the malformed CSV row first."
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: build the full file in a temp file, then rename it over
    # the original, so a failure can never leave the tracker truncated.
    tmp_path = path.with_name(path.name + ".tmp")
    with tmp_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp_path, path)
    return result


def resume_content(profile: dict) -> str:
    parts = [profile.get("header_title", ""), profile.get("summary", "")]
    parts.extend((profile.get("skills") or {}).values())
    for experience in profile.get("work_experience", []):
        parts.extend(experience.get("resume_bullets") or [])
    return "\n".join(parts)


def bounded_contains(text: str, term: str) -> bool:
    escaped = re.escape(term).replace(r"\ ", r"\s+")
    prefix = r"(?<![a-z0-9+#])" if re.match(r"[a-z0-9]", term, re.I) else ""
    suffix = r"(?![a-z0-9+#])" if re.search(r"[a-z0-9]$", term, re.I) else ""
    return bool(re.search(prefix + escaped + suffix, text, re.I))


def validate_profile(role_profile: dict, app_profile: dict, candidate_profile: dict) -> dict:
    # A ROLE PROFILE DECLARES THE JOB, NOT THE CANDIDATE (2026-10-07). skills, work_experience and jd_text used to be
    # required because the profile WAS the resume. Content now comes from application_profile.json, and a profile may
    # override only the summary, so demanding the old shape rejects exactly the profiles the new design wants - the
    # first real one failed here with "missing required fields: skills, work_experience, jd_text".
    required = ["company", "role", "source", "summary"]
    missing = [field for field in required if not role_profile.get(field)]
    if missing:
        raise ValueError(f"Role profile is missing required fields: {', '.join(missing)}")

    content = resume_content(role_profile)
    forbidden_claims = [
        term for term in candidate_profile.get("do_not_claim", []) if bounded_contains(content, term)
    ]
    excluded_urls = [
        item["url"] if isinstance(item, dict) else item
        for item in app_profile.get("candidate", {}).get("excluded_websites", [])
    ]
    excluded_found = [url for url in excluded_urls if url and url.lower() in content.lower()]
    if forbidden_claims or excluded_found:
        problems = []
        if forbidden_claims:
            problems.append(f"unconfirmed claims: {', '.join(forbidden_claims)}")
        if excluded_found:
            problems.append(f"excluded websites: {', '.join(excluded_found)}")
        raise ValueError("Resume safety validation failed: " + "; ".join(problems))

    return {
        "ok": True,
        "checked_resume_characters": len(content),
        "forbidden_claims": [],
        "excluded_websites": [],
    }


def _linkedin(app_profile: dict) -> str:
    value = app_profile["candidate"].get("linkedin", "")
    if value and not value.startswith("http"):
        return f"https://www.{value}" if value.startswith("linkedin.com") else f"https://{value}"
    return value


#: The month names an ATS date SELECT offers, in the order its options are written.
MONTH_NAMES = ("January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December")


def month_name(value) -> str:
    """The month an ATS date select says, for a profile that records it as `09` or inside `05/2026`.

    The profile stores education dates the way a resume writes them - `start_month: "09"`, `end:
    "05/2026"` - while the select offers "September" and "May". Anything unrecognised returns "" so
    the control is left for a person rather than filled with the nearest month.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    for number in re.findall(r"(?<![\d.])(\d{1,2})(?!\d)", text):
        if 1 <= int(number) <= 12:
            return MONTH_NAMES[int(number) - 1]
    lowered = text.lower()
    for name in MONTH_NAMES:
        if name.lower() in lowered:
            return name
    return ""


def ats_place(candidate: dict) -> str:
    """The location option an ATS select offers, from the profile's own address.

    THIS USED TO HARDCODE THE STATE. `f"{city}, CA, United States"` put every candidate in California
    regardless of what their profile said - on forms where the location field decides the pay band,
    which is the cost rule 5 already paid for once on Oneleet.
    """
    address = candidate.get("address") or {}
    return ", ".join(
        str(part) for part in (address.get("city"), address.get("state"), address.get("country")) if part
    )


def phone_country_option(candidate: dict) -> str:
    """The option text a phone country selector offers, from the profile's own phone block."""
    phone = candidate.get("phone") or {}
    return " ".join(str(part) for part in (phone.get("country"), phone.get("country_code")) if part)


def greenhouse_scaffold(role_profile: dict, app_profile: dict, resume_path: Path) -> dict:
    candidate = app_profile["candidate"]
    education = app_profile.get("education", [])
    standard = candidate.get("standard_answers") or {}
    questions = []

    def add_question(match: str, value) -> None:
        if value in (None, "", []):
            return
        if isinstance(value, list):
            value = ", ".join(value)
        questions.append({"match": match, "answer": str(value)})

    # Standard Greenhouse-style application questions, user-confirmed in
    # candidate_profile.json (candidate.standard_answers). Matched by question
    # text on the form; absent questions are skipped, not invented.
    add_question("18+ years of age", standard.get("age_18_plus"))
    add_question("legally authorized to work", standard.get("us_work_authorized"))
    add_question("require sponsorship for work authorization", standard.get("sponsorship_required"))
    add_question("acknowledge", standard.get("privacy_notice_ack"))
    add_question("gender identity", standard.get("gender_identity"))
    add_question("racial/ethnic background", standard.get("race_ethnicity"))
    add_question("disability or chronic condition", standard.get("disability"))
    add_question("veteran, active member or reservist", standard.get("veteran"))

    result = {
        "job_url": role_profile["source"],
        "resume_path": str(resume_path),
        "text_fields": [
            {"name": "First Name", "value": candidate["first_name"]},
            {"name": "Last Name", "value": candidate["last_name"]},
            {
                "name": "Legal Name",
                "value": candidate.get("name") or f"{candidate['first_name']} {candidate['last_name']}",
            },
            {"name": "LinkedIn Profile", "value": _linkedin(app_profile)},
            {"name": "LinkedIn URL", "value": _linkedin(app_profile)},
        ],
        "sensitive_text_fields": [
            {"name": "Email", "value": candidate["email"]},
            {"name": "Phone", "value": candidate["phone"]["formatted"]},
        ],
        "comboboxes_before_education": [
            # The phone country selector's own option text, from the profile's phone block. A tenant
            # whose list spells the country differently is a tenant fact, so it belongs in
            # `data/tenant_policies.json` - not in a literal here that is wrong for everyone else.
            {"name": "Country", "option": phone_country_option(candidate)},
            {
                "name": "Location (City)",
                "option": ats_place(candidate),
                "search_text": candidate["address"]["city"],
                "wait_ms": 900,
            },
        ],
        "education": [],
        "comboboxes": [],
        "checkboxes": [],
        "questions": questions,
        "submit": False,
    }
    if education:
        # THE SCHOOL COMES FROM THE PROFILE, INCLUDING THE SEARCH TOKEN. These two used to be literals naming the
        # author's own university, which would have been typed into any other candidate's form. The search token is
        # derived the way `answer_school.mjs` derives it: the part after the last comma is the campus word a remote
        # search list filters on. Nothing else in this block changed.
        school0 = (education[0].get("school") or "").strip()
        comma = school0.rfind(",")
        result["education"].append({
            "school": school0,
            "school_search": school0[comma + 1:].strip() if comma >= 0 else school0,
            # THE REST OF THE BLOCK COMES FROM THE PROFILE TOO. degree, discipline and both month
            # names were literals - "Master's Degree", "Computer Science", "September", "December",
            # and "Bachelor's Degree" / "Engineering" / "June" for the second entry. Each is in the
            # profile: the degree as "M.S.", the discipline as `field_of_study_workday`, the months
            # inside `start_month` and `end`. A value the profile does not carry now stays empty and
            # is reported, rather than being filled with the author's own education.
            "degree": degree_option(education[0].get("degree")),
            "discipline": education[0].get("field_of_study_workday", ""),
            "discipline_search": "",
            "start_month": month_name(education[0].get("start_month") or education[0].get("start")),
            "start_year": education[0].get("start_year", ""),
            "end_month": month_name(education[0].get("end_month") or education[0].get("end")),
            "end_year": education[0].get("end_year", ""),
        })
    if len(education) > 1:
        # "Other" IS deliberate: a second school is often absent from a tenant's list, and the toolkit has
        # answered an unlisted school as Other since the school-lookup work. That is a SCHOOL answer, and
        # it needs a degree to go with it.
        #
        # AN ENTRY WITH NO DEGREE IS NOT WRITTEN AT ALL. The profile states a degree per school, and for the
        # second school it may state one this mapping does not know - `degree_option` returns "" for that,
        # which used to be written out as `{school: "Other", degree: ""}`. A filler types that: a form is left
        # saying the applicant attended "Other" and holds nothing, with real start and end years beside it.
        # That is a row that states something untrue rather than leaving a gap, so the whole entry is dropped
        # and the missing degree is the same kind of gap as any other value the profile does not carry - the
        # first entry, which the form requires, is untouched either way.
        second_degree = degree_option(education[1].get("degree"))
        if second_degree:
            result["education"].append({
                "school": "Other",
                "school_search": "Other",
                "degree": second_degree,
                "discipline": education[1].get("field_of_study_workday", ""),
                "discipline_search": "",
                "start_month": month_name(education[1].get("start_month") or education[1].get("start")),
                "start_year": education[1].get("start_year", ""),
                "end_month": month_name(education[1].get("end_month") or education[1].get("end")),
                "end_year": education[1].get("end_year", ""),
            })
    return result


def ashby_scaffold(role_profile: dict, app_profile: dict, resume_path: Path) -> dict:
    candidate = app_profile["candidate"]
    return {
        "job_url": role_profile["source"],
        "resume_path": str(resume_path),
        "text_fields": {
            "First Name": candidate["first_name"],
            "Last Name": candidate["last_name"],
            "LinkedIn Profile": _linkedin(app_profile),
        },
        "sensitive_text_fields": {
            "Email": candidate["email"],
            "Phone": candidate["phone"]["formatted"],
        },
        "radios": [],
        "choice_buttons": [],
        "checkboxes": [],
        "comboboxes": [],
        "select_options": [],
        "late_text_fields": {},
        "spin_fields": {},
        "submit": False,
    }


def smartrecruiters_scaffold(role_profile: dict, app_profile: dict, resume_path: Path) -> dict:
    candidate = app_profile["candidate"]
    return {
        "job_url": role_profile["source"],
        "resume_path": str(resume_path),
        "autofill_with_resume": True,
        "text_fields": [
            {"name": "First name", "value": candidate["first_name"]},
            {"name": "Last name", "value": candidate["last_name"]},
            {"name": "LinkedIn", "value": _linkedin(app_profile)},
            {"name": "Website", "value": candidate.get("github", "")},
        ],
        "sensitive_text_fields": [
            {"name": "Email", "value": candidate["email"]},
            {"name": "Confirm your email", "value": candidate["email"]},
            {"name": "Phone number", "value": candidate["phone"]["number"]},
        ],
        "comboboxes": [
            {
                "name": "City",
                "search_text": candidate["address"]["city"],
                "option": ats_place(candidate),
            }
        ],
        # A MESSAGE TO THE HIRING TEAM IS NOT A SCAFFOLD VALUE. This held a paragraph of the author's
        # own prose addressed to ServiceNow by name, which any other applicant would have had sent to
        # a different employer under their own name. The tailored cover letter is where that content
        # belongs; a scaffold leaves it empty and the field is reported rather than invented.
        "message": "",
        "click_next": True,
        "submit": False,
    }


def recursively_replace_resume_paths(value, resume_path: Path):
    if isinstance(value, dict):
        for key, child in list(value.items()):
            if key in {"resume_path"}:
                value[key] = str(resume_path)
            elif key == "path" and isinstance(child, str) and child.lower().endswith((".doc", ".docx", ".pdf")):
                value[key] = str(resume_path)
            else:
                recursively_replace_resume_paths(child, resume_path)
    elif isinstance(value, list):
        for child in value:
            recursively_replace_resume_paths(child, resume_path)


def lever_scaffold(role_profile: dict, app_profile: dict, resume_path: Path) -> dict:
    """Lever (jobs.lever.co) posts a single application page with the resume first.

    The generic spec driver fills Lever forms (src/forms/inspect_ats_form.mjs -> draft_form_spec.py ->
    apply_form_spec.mjs); this scaffold keeps the same bundle shape as the other tenants so the
    tracker row, resume paths and manifest stay consistent.
    """
    candidate = app_profile["candidate"]
    return {
        "job_url": role_profile["source"],
        "resume_path": str(resume_path),
        "autofill_with_resume": True,
        "text_fields": [
            {"name": "Full name", "value": f"{candidate['first_name']} {candidate['last_name']}"},
            {"name": "Email", "value": candidate["email"]},
            {"name": "Phone", "value": candidate["phone"]["number"]},
            {"name": "Current company", "value": app_profile["work_experience"][0].get("company", "")},
            {"name": "LinkedIn", "value": _linkedin(app_profile)},
            {"name": "GitHub", "value": candidate.get("github", "")},
        ],
        "sensitive_text_fields": [],
        "comboboxes": [
            {
                "name": "Current location",
                "search_text": candidate["address"]["city"],
                "option": ats_place(candidate),
            }
        ],
    }


def existing_platform_config(platform: str, stem: str) -> Path | None:
    directories = {name: AUTOFILL_DIR / name for name in PLATFORM_CONFIG_DIRS}
    directory = directories.get(platform)
    if not directory:
        return None
    candidates = [directory / f"{stem}.json"]
    if platform == "workday":
        candidates.insert(0, directory / f"{stem}_payload.json")
    return next((path for path in candidates if path.exists()), None)


def build_or_update_platform_config(
    platform: str,
    stem: str,
    role_profile: dict,
    app_profile: dict,
    workday_payload: dict,
    resume_path: Path,
    override: Path | None = None,
) -> tuple[Path | None, bool]:
    config_path = override or existing_platform_config(platform, stem)
    mapped = config_path is not None and config_path.exists()
    if mapped:
        config = load_json(config_path)
    elif platform == "greenhouse":
        config_path = AUTOFILL_DIR / "greenhouse" / f"{stem}.json"
        config = greenhouse_scaffold(role_profile, app_profile, resume_path)
    elif platform == "ashby":
        config_path = AUTOFILL_DIR / "ashby" / f"{stem}.json"
        config = ashby_scaffold(role_profile, app_profile, resume_path)
    elif platform == "workday":
        config_path = AUTOFILL_DIR / "workday" / f"{stem}_payload.json"
        config = workday_payload
    elif platform == "phenom":
        config_path = AUTOFILL_DIR / "phenom" / f"{stem}.json"
        config = {
            "company": role_profile["company"],
            "role": role_profile["role"],
            "url": role_profile["source"],
            "resume_path": str(resume_path),
            "steps": {},
        }
    elif platform == "smartrecruiters":
        config_path = AUTOFILL_DIR / "smartrecruiters" / f"{stem}.json"
        config = smartrecruiters_scaffold(role_profile, app_profile, resume_path)
    elif platform == "lever":
        config_path = AUTOFILL_DIR / "lever" / f"{stem}.json"
        config = lever_scaffold(role_profile, app_profile, resume_path)
    else:
        return None, False

    recursively_replace_resume_paths(config, resume_path)
    if platform == "workday":
        config["resume_path"] = str(resume_path)
    write_json(config_path, config)
    return config_path, mapped


def analysis_for_profile(role_profile: dict) -> job_app_assistant.Analysis:
    candidate_profile = job_app_assistant.load_profile()
    analysis = job_app_assistant.build_analysis(
        role_profile.get("jd_text", ""), role_profile["source"], candidate_profile
    )
    analysis.company = role_profile["company"]
    analysis.title = role_profile["role"]
    if role_profile.get("track") in analysis.track_scores:
        analysis.recommended_track = role_profile["track"]
    return analysis


def manifest_note_path(manifest_path: Path) -> str:
    """The manifest as the tracker's note should spell it.

    THE NOTE IS READ LATER, BY A PERSON, IN A SPREADSHEET. So the path has to be one that still finds the
    file from wherever that person is looking, and that is why this is not simply `relative_to(ROOT)`:
    `ATS_DATA_DIR` exists so a second person's configuration can live outside the checkout - both
    README.md and docs/CONFIGURATION.md say so - and then the manifest is not under ROOT at all and
    `relative_to` raised ValueError. That exception was raised WHILE the `tracker_row` literal was being
    built, so `upsert_tracker()` never ran: the DOCX, PDF, manifest and autofill config were all written
    and then the process died with no tracker row, leaving materials a later `duplicates` or
    `check_daily` could not see had ever been produced.

    Inside the checkout the short repository-relative path stays, because that is the form every other
    note and manifest field already uses. Outside it, the absolute path is the only spelling that still
    resolves to the file.
    """
    try:
        return str(manifest_path.relative_to(ROOT))
    except ValueError:
        return str(manifest_path)


def prepare(args: argparse.Namespace) -> int:
    role_profile_path = resolve(args.profile)
    role_profile = load_json(role_profile_path)
    app_profile = load_json(APP_PROFILE_PATH)
    candidate_profile = load_json(CANDIDATE_PROFILE_PATH)
    validation = validate_profile(role_profile, app_profile, candidate_profile)
    platform = detect_platform(role_profile["source"], args.platform)
    if platform == UNSUPPORTED_PLATFORM:
        raise SystemExit("Unsupported ATS platform. Pass --platform explicitly after adding a helper.")

    duplicate = tracker_match(role_profile["source"])
    if duplicate and duplicate.get("status") in SUBMITTED_STATUSES and not args.force:
        print(json.dumps({"status": "already_submitted", "tracker": duplicate}, indent=2))
        return 3
    # DEDUPE IDENTITY IS THE REQUISITION ID, NOT THE TITLE (aligned 2026-10-03 with
    # check_duplicate.py and data/tenant_policies.json, and with docs/RULES.md rule 3: a different
    # URL on the same board is a different requisition and may be applied to). The guard still
    # refuses a re-application to the SAME requisition; it no longer refuses a same-titled opening
    # that carries a different requisition id. That stricter reading blocked GigaML SWE I/II,
    # Sprinter Health and Astronomer.
    def _requisition_id(url: str) -> str:
        m = re.search(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", url or "")
        if m:
            return m.group(1).lower()
        return (url or "").rstrip("/").rsplit("/", 1)[-1].lower()

    _new_req = _requisition_id(role_profile["source"])
    same_role = [
        row for row in role_matches(role_profile["company"], role_profile["role"])
        if row.get("status") in SUBMITTED_STATUSES
        and _requisition_id(row.get("source", "")) == _new_req
        and row.get("source", "").rstrip("/") != role_profile["source"].rstrip("/")
    ]
    if same_role and not args.force:
        print(json.dumps({"status": "already_submitted_for_role", "company": role_profile["company"],
                          "role": role_profile["role"], "tracker_rows": same_role}, indent=2, ensure_ascii=False))
        return 3

    stem = role_profile_path.stem
    # THE NAME COMES FROM THE PROFILE. This used to be the literal "Example_Candidate", which named the resume file
    # "Example_Candidate_<company>_<role>_Resume.docx" for every applicant the tool was ever run for.
    candidate_name = (app_profile.get("candidate") or {}).get("name") or ""
    output_docx = ROOT / "output" / "docx" / f"{slugify(candidate_name)}_{slugify(role_profile['company'])}_{slugify(role_profile['role'])}_Resume.docx"
    output_docx, workday_payload = generate(role_profile_path, output_docx=output_docx)

    excluded_urls = [
        item["url"] if isinstance(item, dict) else item
        for item in app_profile.get("candidate", {}).get("excluded_websites", [])
    ]
    final_pdf = ROOT / "output" / "pdf" / f"{output_docx.stem}.pdf"
    render_dir = ROOT / "tmp" / "render" / f"{stem}"
    final_pdf, qa = export_and_validate_pdf(
        output_docx,
        pdf_path=final_pdf,
        render_dir=render_dir,
        expected_terms=[candidate_name, "EXPERIENCE", "EDUCATION"],
        forbidden_terms=excluded_urls,
    )

    # THE COVER LETTER IS OPTIONAL AND EXPLICIT. `--cover-letter` is the flag the README's drafter step
    # expects a PDF for (output/pdf/<...>_Cover_Letter.pdf); the smoke walk omitted it and the drafter
    # accepted the absence, so it stays off unless asked. Built BEFORE the tracker write: a letter the
    # template refuses (an unresolved placeholder, a do_not_claim term) must fail the run before a row
    # claims the materials are ready.
    cover_pdf = None
    if args.cover_letter:
        cover_pdf = build_letter_pdf(role_profile["company"], role_profile["role"])

    config_override = resolve(args.config) if args.config else None
    config_path, mapped = build_or_update_platform_config(
        platform,
        stem,
        role_profile,
        app_profile,
        workday_payload,
        final_pdf,
        config_override,
    )

    manifest = {
        "schema_version": 1,
        "company": role_profile["company"],
        "role": role_profile["role"],
        "job_url": role_profile["source"],
        "platform": platform,
        "role_profile_path": str(role_profile_path),
        "resume_docx_path": str(output_docx),
        "resume_pdf_path": str(final_pdf),
        "cover_letter_pdf_path": str(cover_pdf) if cover_pdf else None,
        "qa_report_path": str(render_dir / "qa-report.json"),
        "autofill": {
            "config_path": str(config_path) if config_path else None,
            "mapped": mapped,
            "requires_form_mapping": not mapped,
        },
        "safety": {
            "submit_allowed": False,
            "stop_on_login": True,
            "stop_on_captcha": True,
            "stop_on_unknown_legal_question": True,
        },
        "profile_validation": validation,
        "pdf_validation": qa,
        "prepared_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    manifest_path = BUNDLES_DIR / f"{stem}.json"
    write_json(manifest_path, manifest)

    if not args.no_tracker:
        analysis = analysis_for_profile(role_profile)
        # THE ROW IS FULLY BUILT BEFORE ANYTHING IS WRITTEN, and every value in it is now a plain string.
        # The `relative_to(ROOT)` that used to sit in this literal is what made that worth stating: it
        # raised for a data directory outside the checkout, the dict literal was abandoned with it, and
        # the write above was all that survived - the production run's own notes field was the one field
        # that could fail, and it failed while the row was being assembled rather than while it was being
        # written. Building the row first means the only thing that can fail before the tracker write is
        # a fact read straight out of the profile, and nothing in this block may be moved back inside the
        # tracker_row expression.
        manifest_note = manifest_note_path(manifest_path)
        tracker_row = {
            "date_added": dt.date.today().isoformat(),
            "company": role_profile["company"],
            "title": role_profile["role"],
            "source": role_profile["source"],
            "eligibility": analysis.eligibility,
            "recommended_track": analysis.recommended_track,
            "track_scores": json.dumps(analysis.track_scores),
            "status": "materials_ready" if mapped else "needs_form_mapping",
            "notes": f"Prepared by application_pipeline.py; PDF QA passed; platform={platform}; manifest={manifest_note}",
        }
        manifest["tracker"] = upsert_tracker(tracker_row)
        write_json(manifest_path, manifest)

    ledger.record(
        ledger.PREPARE,
        slug=stem, url=role_profile.get("source"), company=role_profile.get("company"),
        platform=platform,
        outcome="ready" if mapped else "needs_form_mapping",
        detail={"pdf_pages": qa["page_count"], "mapped": bool(mapped),
                "manifest": manifest_path.name},
    )
    print(json.dumps({
        "status": "ready" if mapped else "needs_form_mapping",
        "platform": platform,
        "manifest": str(manifest_path),
        "resume_pdf": str(final_pdf),
        "cover_letter_pdf": str(cover_pdf) if cover_pdf else None,
        "autofill_config": str(config_path) if config_path else None,
        "pdf_pages": qa["page_count"],
    }, indent=2))
    return 0


def company_rows(company: str, path: Path = TRACKER_PATH) -> list[dict]:
    """Tracker rows for one company, whatever the role. A second role at a company is what makes
    that tenant's caps and do-not-retry list relevant."""
    wanted = normalize_text(company)
    if not wanted:
        return []
    _, rows = read_tracker(path)
    return [row for row in rows if normalize_text(row.get("company", "")) == wanted]


def duplicates(args: argparse.Namespace) -> int:
    """Audit: list every company+role that appears more than once in the tracker."""
    groups = duplicate_groups()
    report = []
    for (company, role), rows in sorted(groups.items()):
        report.append({
            "company": rows[0].get("company"),
            "title": rows[0].get("title"),
            "count": len(rows),
            "submitted": sum(1 for row in rows if row.get("status") in SUBMITTED_STATUSES),
            "rows": [{"source": row.get("source"), "status": row.get("status")} for row in rows],
        })
    print(json.dumps({"duplicate_role_groups": report, "count": len(report)}, indent=2, ensure_ascii=False))
    return 0


def record_status(args: argparse.Namespace) -> int:
    existing = tracker_match(args.url)
    if not existing:
        raise SystemExit(f"Tracker entry not found: {args.url}")
    # Guard: never overwrite a submission record. This is how a user-submitted Anthropic
    # application got relabelled as agent-submitted and the duplicate was missed (2026-09-23).
    previous = (existing.get("status") or "").strip()
    submitted = {"submitted_by_user", "submitted_by_agent"}
    if previous in submitted and previous != args.status and not getattr(args, "force", False):
        raise SystemExit(
            f"Refusing to change status {previous!r} -> {args.status!r} for {args.url}. "
            f"{previous!r} means this role was already applied to; do NOT re-apply. "
            "Pass --force only to correct a genuinely wrong record."
        )
    existing["status"] = args.status
    if args.note:
        old = existing.get("notes", "")
        existing["notes"] = f"{old}; {args.note}" if old else args.note
    if args.status == "submitted_by_user" and "user submitted on" not in existing.get("notes", ""):
        existing["notes"] = f"{existing.get('notes', '')}; user submitted on {dt.date.today().isoformat()}".strip("; ")
    if args.status == "submitted_by_agent" and "submitted by the agent" not in existing.get("notes", ""):
        existing["notes"] = f"{existing.get('notes', '')}; submitted by the agent on {dt.date.today().isoformat()}".strip("; ")
    upsert_tracker(existing, allow_status_change=bool(getattr(args, "force", False)))
    ledger.record(
        ledger.CLOSED,
        url=args.url, company=existing.get("company"), title=existing.get("title"),
        outcome=args.status,
        detail={"previous_status": previous, "note_chars": len(args.note or "")},
    )
    print(json.dumps({"source": args.url, "status": args.status, "previous_status": previous}, indent=2))
    return 0


def handover(args: argparse.Namespace) -> int:
    """Record that an application was stopped and left for the user.

    This is the only way a handover is recorded. Three classes (captcha, login wall, duplicate) were meant
    to be raised automatically by `src/autofill/unified_runner.mjs`, but nothing ever called that module,
    so across the whole ledger not one handover carries its provenance — every one was declared here or
    by the submit gate. The rest — content only the user can author, a form that will not accept an honest
    answer, a control the tools cannot drive — are judgements only the agent makes. This deliberately does
    **not** touch the tracker: whether the row becomes `not_applied`
    or stays open is a separate decision.

    Telemetry, like every other ledger write: it must never fail the caller."""
    platform = detect_platform(args.url, args.platform)
    ledger.record(
        ledger.HANDOVER,
        slug=getattr(args, "slug", None), url=args.url, company=getattr(args, "company", None),
        platform=platform, outcome=args.klass,
        detail={"reason": args.reason, "detected_by": "agent"},
    )
    print(json.dumps({
        "recorded": "handover",
        "url": args.url,
        "class": args.klass,
        "tracker": "unchanged - record the status separately if the application is over",
    }, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare and track a safe, PDF-first job application bundle.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # `preflight` was removed on 2026-10-06. It had three jobs and lost all three. Platform detection is
    # `detect_platform()`, called directly. Duplicate detection moved to `src/screening/check_duplicate.py`, whose
    # test is far stronger (requisition id, plus a live-board comparison that catches an employer re-posting the
    # same role under a new id). Its third job, printing a per-ATS instruction file at the moment a form is
    # opened, is gone with the files themselves rather than with the subcommand: a lesson that can be written
    # down is a lesson a test should be holding instead. Keeping the subcommand would also have collided by name
    # with `data/scratch/preflight_role.py`, the user's own tool that checks tenant caps and re-records — which
    # is why the dead one looked busy.
    # The ledger's `preflight` event was dropped with it: 7 events in total, none since 2026-10-04.

    prepare_parser = subparsers.add_parser("prepare", help="Generate DOCX, PDF, QA report, ATS config, and manifest.")
    prepare_parser.add_argument("--profile", required=True)
    prepare_parser.add_argument("--platform", default="auto", choices=PLATFORM_CHOICES)
    prepare_parser.add_argument("--config", help="Existing ATS config to update and reference.")
    prepare_parser.add_argument("--cover-letter", action="store_true",
                                help="Also build the cover-letter DOCX and PDF (output/pdf/<...>_Cover_Letter.pdf) "
                                     "from data/cover_letter/template.txt, for the README's drafter step.")
    prepare_parser.add_argument("--force", action="store_true", help="Prepare even when tracker says already submitted.")
    prepare_parser.add_argument("--no-tracker", action="store_true")
    prepare_parser.set_defaults(handler=prepare)

    status_parser = subparsers.add_parser("record-status", help="Update an existing tracker entry.")
    status_parser.add_argument("--url", required=True)
    status_parser.add_argument("--status", required=True)
    status_parser.add_argument("--note")
    status_parser.add_argument("--force", action="store_true", help="Allow changing a status that is already a submission (dangerous; a submission is evidence of a prior application).")
    status_parser.set_defaults(handler=record_status)

    duplicates_parser = subparsers.add_parser("duplicates", help="Audit the tracker for company+role pairs recorded more than once.")
    duplicates_parser.set_defaults(handler=duplicates)

    handover_parser = subparsers.add_parser(
        "handover",
        help="Record that an application was stopped and left for the user, and why. Does not touch the tracker.")
    handover_parser.add_argument("--url", required=True, help="The job URL the tab is open on")
    handover_parser.add_argument("--class", dest="klass", required=True, choices=list(ledger.HANDOVER_CLASSES),
                                 help="Why it stopped; one of the classes ledger.HANDOVER_CLASSES declares")
    handover_parser.add_argument("--reason", required=True, help="What the user has to do, in one sentence")
    handover_parser.add_argument("--slug")
    handover_parser.add_argument("--company")
    handover_parser.add_argument("--platform", default="auto", choices=PLATFORM_CHOICES)
    handover_parser.set_defaults(handler=handover)

    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
