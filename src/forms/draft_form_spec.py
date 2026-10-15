#!/usr/bin/env python3
"""draft_form_spec.py — turn a form-field inventory into a fill spec automatically.

Usage:
  python3 src/forms/draft_form_spec.py tmp/apply/<slug>_fields.json [--out FILE]
                                    [--url URL] [--resume PDF] [--cover-letter PDF]
                                    [--job "Company — Role"]

Input is the JSON written by `node src/forms/inspect_ats_form.mjs ... --options --out ...`.
Output is a draft spec for `src/forms/apply_form_spec.mjs` plus a review list:

  { spec: {target, texts, textareas, selects, checks, files}, needs_review: [...] }

The point is token economy: identity, contact, education, eligibility, sponsorship,
consents, office locations and the standard EEO questions are answered from
candidate_profile.json / application_profile.json by this script, so the model only has
to look at the fields this script reports as `needs_review` (tenant-specific questions,
compensation bands, unusual wording).

Rules: never invents an answer. Anything without a confident profile-grounded mapping is
left out of the spec and listed in needs_review. The compensation answer uses the
user-confirmed rule (highest published band) only when a range is visible in the field's
own help text; otherwise it is left for the user.

AN OPTION LABEL IS NOT A QUESTION. On Ashby every option of a checkbox or radio group is its own `input`, and
the reader reports each one separately with the OPTION LABEL as its "question" - so a rule for "linkedin"
matches the checkbox labelled `LinkedIn`, and a rule for "gender identity" matches the option `Male`. This
script put the candidate's LinkedIn URL into the "How did you hear about us?" group twice and filled a gender
radio group with `No`, and the guard below is what stops it.

That failure is worse than a blank control. A blank one is visible: the audit lists it and the gate names it.
An answer written into a control that never asked the question looks COMPLETE - the audit reads clean, the gate
passes, and the employer receives a false statement about the candidate.
"""
from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)


def _linkedin(app: dict) -> str:
    """Canonical LinkedIn URL (mirrors application_pipeline._linkedin without importing
    the DOCX stack, so this script runs under a plain stdlib python3)."""
    value = ((app.get("candidate") or {}).get("linkedin") or "")
    if value and not value.startswith("http"):
        return f"https://www.{value}" if value.startswith("linkedin.com") else f"https://{value}"
    return value


def race_answer(std: dict) -> str:
    """The profile's race/ethnicity answer as the ONE option text a control can hold.

    `standard_answers.race_ethnicity` is a list - the example profile documents it as "the option text your form
    offers" plus "a second one, only if the form allows more than one" - because a form may ask a race question and an
    ethnicity question separately. This drafter answers one control at a time, so it takes the first recorded value,
    and `OPTION_SYNONYMS` is what bridges the tenant's own wording ("Asian" and "East Asian" select each other). A
    missing key, an empty list or a non-string value yields "" - never a category this file chose for the candidate.
    """
    value = std.get("race_ethnicity")
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        for item in value:
            if str(item).strip():
                return str(item).strip()
    return ""


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip().lower()


# --------------------------------------------------------------------------- answers
MONTHS = {
    "01": "January", "02": "February", "03": "March", "04": "April", "05": "May", "06": "June",
    "07": "July", "08": "August", "09": "September", "10": "October", "11": "November", "12": "December",
}


def yes_no(value) -> str:
    """The profile's own Yes or No, or "" when it does not state one.

    ONLY AN EXPLICIT "Yes"/"No" SURVIVES. A blank, an absent key, a placeholder or any other spelling
    returns "" so the question is reported as unanswered. The alternative - defaulting to "No" - is an
    invented answer, and on work authorisation and sponsorship it is the one place where an invented
    answer is a false statement to an employer rather than a missing one.
    """
    text = str(value or "").strip().lower()
    return "Yes" if text == "yes" else ("No" if text == "no" else "")


def degree_option(value) -> str:
    """The option text an ATS degree list uses, for a degree the profile names its own way.

    The profile records `M.S.` / `B.S.` because that is what a resume says; a degree SELECT offers
    "Master's Degree" / "Bachelor's Degree". Resolving one onto the other is option-text mapping,
    like every other OPTION_SYNONYMS entry - but the SOURCE is still the profile's own degree, and a
    spelling this does not recognise returns "" so the control is reported rather than guessed at.
    """
    text = str(value or "").strip().lower()
    if not text:
        return ""
    if text.startswith(("m.s", "ms.", "ms ", "master")):
        return "Master's Degree"
    if text.startswith(("b.s", "bs.", "bs ", "bachelor")):
        return "Bachelor's Degree"
    if text.startswith(("ph.d", "phd", "doctor", "d.sc", "edd", "ed.d")):
        return "Doctorate"
    if text.startswith(("a.a", "a.s", "associate")):
        return "Associate's Degree"
    return ""


def build_answer_table(candidate: dict, app: dict) -> dict:
    """Canonical answers keyed by the label questions we know how to recognise."""
    std = candidate.get("standard_answers") or {}
    stand = candidate.get("standing_answers") or {}
    c = app.get("candidate") or {}
    addr = c.get("address") or {}
    edu = {e["school"]: e for e in app.get("education", [])}
    # A PREFERENCE, NOT A FILTER. These two were selected by looking for "M.S." and "B.S." in the degree
    # text, and every education key below reads one of them - so an applicant whose education is
    # "B.Sc.N." and a diploma had school, degree, field and the degree dates all EMPTY, while a required
    # School/Degree select sat on the form unable to be filled. The M.S. entry is still preferred when it
    # exists, because a profile may list the bachelor first and the higher degree is what those controls
    # are asking for; the fallback is the profile's own first entry, which is the applicant's own statement
    # of which degree leads.
    education = app.get("education") or []
    master = next((e for e in education if "M.S." in (e.get("degree") or "")),
                  education[0] if education else {})
    bachelor = next((e for e in education if "B.S." in (e.get("degree") or "")),
                    next((e for e in education if e is not master), {}))
    # One recorded value, two matcher keys: `race` and `race_east_asian` are separate because the tenants word this
    # question two ways ("Race", "Ethnicity"), not because the candidate has two answers.
    race_value = race_answer(std)
    return {
        # IDENTITY IS READ FROM THE PROFILE OR IT IS EMPTY. There are no hardcoded identity fallbacks here: a
        # default name, school or city would be written into a real form as if the profile had supplied it, and
        # the profile could be corrected while this file kept drafting the placeholder.
        "first_name": (candidate.get("name") or "").split()[0] if candidate.get("name") else "",
        "last_name": (candidate.get("name") or "").split()[-1] if candidate.get("name") else "",
        "full_name": candidate.get("name", ""),
        "preferred_name": c.get("first_name", ""),
        "name_pronunciation": c.get("name_pronunciation", ""),
        "email": candidate.get("email", ""),
        "phone": ((c.get("phone") or {}).get("formatted") or ""),
        "city": addr.get("city", ""),
        # The country comes from the ADDRESS, not from a literal in the join: an empty address used to
        # answer "United States" on its own, and the literal disagreed with `address.country` anyway.
        "city_full": ", ".join(
            x for x in (addr.get("city"), addr.get("state"), addr.get("country")) if x
        ),
        "state": addr.get("state", ""),
        "country": addr.get("country", ""),
        # CITIZENSHIP IS ITS OWN ANSWER AND ITS OWN FIELD. The profile has always carried it; the table
        # simply never read it, so the residence matcher answered citizenship questions with the address
        # country. Empty when the profile does not state one, like every other identity value here.
        "citizenship": candidate.get("citizenship", ""),
        # The preference order is a fact about a PERSON, so it lives in the profile and is never written
        # here: `job_search_preferences.priority_locations` encodes it, highest-ranked first. 23 saved
        # fields asked for a preferred or desired work location and had no key to answer from.
        "desired_location": ((app.get("job_search_preferences") or {}).get("priority_locations") or [""])[0],
        "postal_code": addr.get("postal_code", ""),
        "linkedin": _linkedin(app),
        "github": c.get("github", ""),
        # THE PROFILE'S ANSWER, OR NOTHING. These read as `... else "No"` until they were measured: a profile
        # that omitted the key was answered No, silently, because the field had a value and never reached
        # `needs_review`. Work authorisation and sponsorship are the two questions where an invented answer is
        # a false statement to an employer rather than a gap, so an unstated answer stays empty here.
        "authorized": yes_no(std.get("us_work_authorized")),
        "sponsor_now": yes_no(std.get("sponsorship_required")),
        "sponsor_future": yes_no(std.get("sponsorship_required")),
        "consent": yes_no(stand.get("required_consent_and_agreement")),
        # No fallback: "how did you hear about us" is a question about the person's own behaviour, so an
        # answer the profile does not contain is a blank to report, not the most plausible option.
        "how_heard": ((stand.get("how_did_you_hear") or {}).get("first_choice") or ""),
        # A DEMOGRAPHIC ANSWER IS A STATEMENT ABOUT A PERSON, so every one of these reads the profile and falls back to
        # nothing. They were written in as literals - "Male", "Straight / Heterosexual", "Asian", "East Asian",
        # "Cisgender", "No", "No military service", "I am not a protected veteran", "No, I do not have a disability and
        # have not had one in the past" - which is a claim about the candidate the profile never made, in a control that
        # then looks ANSWERED, so no review ever sees it. `standard_answers` is where the profile records each one,
        # spelled as the form's own option text. Three of these keys - `transgender`, `cisgender`, `hispanic_ethnicity` -
        # are not in the documented profile at all: with no key to read, the answer is empty and the control is listed in
        # `needs_review`, which is the honest outcome. An unanswered demographic question costs one review line; a
        # guessed one costs a false statement on a real application.
        "gender": std.get("gender_identity", ""),
        "transgender": std.get("transgender", ""),
        "cis_trans": std.get("cisgender", ""),
        "sexual_orientation": std.get("sexual_orientation", ""),
        "hispanic": std.get("hispanic_ethnicity", ""),
        "race": race_value,
        "race_east_asian": race_value,
        # ONE FACT, TWO WORDINGS. `veteran` / `veteran_protected` and `disability` / `disability_long` exist because two
        # tenants ask the same question with different option texts ("No" against "I am not a protected veteran"), so
        # both read the one recorded value and `OPTION_SYNONYMS_BY_KEY` carries the profile's short answer onto the
        # tenant's long option. A profile with no such answer leaves the control blank and reported, never assumed.
        "veteran": std.get("veteran", ""),
        "veteran_protected": std.get("veteran", ""),
        "disability": std.get("disability", ""),
        "disability_long": std.get("disability", ""),
        # EVERY ANSWER ABOVE THIS LINE COME FROM THE PROFILE, and so do these. They were literals
        # until an audit found four of the six contradicting a value the profile already held -
        # `will_relocate` most dangerously, because it is the fallback for every relocation question
        # and a profile answering No was answered Yes. The table key still reads `not_worked_here`
        # and its value can now be `Yes`: the names encode the answer this file used to assume, and
        # the values are configuration.
        "no_current_agreement": yes_no(std.get("restrictive_agreement")),
        "not_worked_here": yes_no(std.get("previously_worked_here")),
        "not_referred": yes_no(std.get("referred_by_employee")),
        "will_relocate": yes_no(stand.get("relocation")),
        "onsite_ok": yes_no(stand.get("office_commuting")),
        # `level_mid_senior` is gone: no MATCHERS entry ever produced it, so nothing could ask the
        # question it answered. A level question belongs in the profile like any other preference.
        # THE ATS SPELLING IS DERIVED, NOT A SECOND LITERAL. The profile keeps the school under its own
        # separator ("..., Fairview") while an ATS list tends to render it with a dash, and a hardcoded
        # second spelling here is what lets the two drift apart.
        "school": master.get("school", ""),
        "school_ats": (master.get("school") or "").replace(", ", " - "),
        "degree": degree_option(master.get("degree")),
        "field": master.get("resume_field_of_study", ""),
        "degree_start_year": master.get("start_year", ""),
        # The month halves. `application_profile.education[0].start` is "09/2024" - the month is the part
        # before the slash, and spelling it is what a month select needs; the YEAR is derived the same way.
        "degree_start_month": MONTHS.get(str(master.get("start", ""))[:2], ""),
        "degree_end_month": MONTHS.get(str(master.get("end", ""))[:2], ""),
        "degree_end_year": master.get("end_year", ""),
        "bachelor_school": bachelor.get("school", ""),
        "bachelor_degree": degree_option(bachelor.get("degree")),
        "bachelor_end_year": bachelor.get("end_year", ""),
        # A DATE THE PROFILE DOES NOT CARRY IS NOT A DATE. This used to be a literal, and a literal here is a
        # statement about a person: it would be typed into a required "Ideal Start Date" control for anyone who
        # ran the tool, whether or not it was ever true of them. The profile's `workday_defaults` holds the value
        # for the person the profile actually describes; absent means the control stays blank and is listed.
        "start_date": (app.get("workday_defaults") or {}).get("earliest_full_time_start_date", ""),
        # THE EMPLOYER IS THE PROFILE'S OR IT IS EMPTY, for the reason given at the top of this table. These two
        # carried the employer and title of whoever wrote this file, so a profile with no work history - or a
        # different one - was still drafted with that employer, and the value read as if the profile had supplied it.
        "current_company": (app.get("work_experience") or [{}])[0].get("company", ""),
        "current_title": (app.get("work_experience") or [{}])[0].get("job_title", ""),
        # THE WORK-AUTHORISATION FREE TEXT IS THE PROFILE'S OR IT IS EMPTY. This key held a paragraph describing one
        # person's visa situation and their month-by-month eligibility - a legal statement about a real candidate,
        # written automatically into whatever field asked how many months of work authorisation remain. The profile's
        # own answer to that question is `workday_defaults.opt_cpt_months_remaining_answer`, documented there as "a
        # sentence describing how much work authorisation you currently hold, and what you expect to be eligible for
        # next" - and its owner may delete the key. A missing answer leaves the field EMPTY and lists it for review: a
        # generic replacement paragraph, or a status this file picked, would be the tool making that legal statement on
        # the candidate's behalf, which is the one thing this table must never do.
        "expectations_gap": (app.get("workday_defaults") or {}).get("opt_cpt_months_remaining_answer") or "",
    }


# Question → answer-key matchers, most specific first.
MATCHERS: list[tuple[str, str, str]] = [
    # (answer key, regex, kind)  kind: text | select | check
    ("first_name", r"first name", "text"),
    ("last_name", r"last name", "text"),
    ("preferred_name", r"preferred (first )?name|name you'?d prefer|preferred name", "text"),
    # A BARE "Name" IS THE MOST COMMON UNANSWERED FIELD IN THE WHOLE CORPUS: 406 of 8,785 saved
    # fields, plus another 61 spelled "Full Name". Ashby's system field is `id:_systemfield_name`,
    # labelled exactly "Name", and it is REQUIRED - so every Ashby application opened with one
    # required field handed to a human for no reason. Anchored at both ends so `Company Name` and
    # `Name of School` cannot match; `First Name` and `Last Name` are taken above.
    ("full_name", r"^(full |legal |your )?name\s*\*?$", "text"),
    # The education block asks for its dates as FOUR controls on some tenants - month AND year, each its own
    # field - and the year ones arrived as `type: number` plain inputs that the filler can drive, listed as
    # "optional, no profile mapping" because nothing here matched them (Twitch, 2026-10-10). The answers were
    # already in the table as degree_start_year / degree_end_year. Kept narrow on purpose: an education year is a
    # fact-bearing field, so this must not also catch a posting's "years of experience" question.
    ("degree_start_year", r"start date year|start year|from year|year (you )?(started|began)", "text"),
    # The MONTH halves of the same four-control education block, added with the year ones after a refill showed
    # "Start date month" going to needs_review as "optional, no profile mapping" (Twitch, 2026-10-10).
    ("degree_start_month", r"start date month|start month|month (you )?(started|began)", "select"),
    ("degree_end_month", r"end date month|end month|month (you )?(graduated|finished)", "select"),
    ("degree_start_month", r"start date month|start month|month (you )?(started|began)", "text"),
    ("degree_end_month", r"end date month|end month|month (you )?(graduated|finished)", "text"),
    # `website` on a form is the personal site, and the canonical contact block carries the GitHub URL for it.
    ("github", r"^website\b|personal (web ?site|site)|portfolio", "text"),
    ("degree_end_year", r"end date year|end year|to year|graduation year|year (you )?(graduated|finished)", "text"),
    ("degree_start_year", r"start date year|start year|from year|year (you )?(started|began)", "number"),
    ("degree_end_year", r"end date year|end year|to year|graduation year|year (you )?(graduated|finished)", "number"),
    ("email", r"\bemail\b", "text"),
    ("phone", r"\bphone\b|mobile number|telephone", "text"),
    ("city_full", r"location \(city\)|city of residence|current city|current location", "select"),
    ("postal_code", r"postal|zip", "text"),
    ("__experience__", r"years of .*(software|engineering|industry|professional)|how many years", "select"),
    # CITIZENSHIP IS TRIED FIRST, AND `country` NO LONGER MATCHES IT. `MATCHERS` is first-match-wins and
    # `^country` is anchored to the start of the label, so "Country of citizenship" matched the residence
    # key and a US citizen living in Toronto was drafted "Canada" on a legal-eligibility control. The
    # negative lookahead keeps any label that mentions citizenship - in any of its wordings - away from the
    # residence answer, so a question the patterns above miss is left for a person rather than answered
    # with the wrong fact.
    ("citizenship", r"country of citizenship|citizenship (status|country)|which country.*citizen|"
                    r"what country.*(a |are you a )?citizen|are you a (u\.?s\.? |canadian |uk )?citizen",
     "select"),
    ("country", r"country(?!.*citizen)(?!.*citizenship)|country of residence|"
                r"country where you are located|country/region", "select"),
    ("state", r"^state\b|state or (canadian )?province|state of residence|state/province|"
              r"which .*\bstate\b|\bstate\b.*reside", "text"),
    ("state", r"^state\b|state or (canadian )?province|state of residence|state/province|"
              r"which .*\bstate\b|\bstate\b.*reside", "select"),
    ("desired_location", r"desired (work |job )?location|preferred (office|work|job) location|"
                         r"which (office|location) would you|(office|work) location preference", "text"),
    ("desired_location", r"desired (work |job )?location|preferred (office|work|job) location|"
                         r"which (office|location) would you|(office|work) location preference", "select"),
    ("linkedin", r"linkedin", "text"),
    ("github", r"github", "text"),
    ("how_heard", r"how did you hear|how you heard|hear about (this|the) (job|role|position)", "text"),
    # The same question is a react-select on many tenants ("How did you hear about us?*") and the
    # matcher above only covered kind=text - so the one question this project has a standing answer
    # for fell through on 23 saved inventories. Third alternative added for the "us" wording.
    ("how_heard", r"how did you hear|how you heard|hear (about|of) (this|the|us)", "select"),
    ("sponsor_now", r"will you (now )?(require|need)|(require|need) (immigration|visa )?sponsorship (by|to attain).*(now|current)|now require immigration", "select"),
    # WORD BOUNDARIES ARE LOAD-BEARING HERE (fixed 2026-10-08). This pattern used to be `opt|cpt|...`, and unanchored
    # `opt` matched inside the word "Optional" - so on Asana's form the long OPT/work-authorization answer was written
    # into "[Optional] Preferred Full Name" and "[Optional, if \"other\" is selected above] My pronouns are". Both are
    # OPTIONAL fields, which is exactly why a review that swept only the required ones did not catch it. `\bopt\b`
    # cannot match "optional", because the next character is a word character.
    ("expectations_gap", r"\bopt\b|\bcpt\b|months (of|remaining)|work authorization.*months", "text"),
    ("sponsor_future", r"future (require|need)|(require|need).*sponsorship.*(future|in the future)|immigration related support", "select"),
    ("authorized", r"legally authorized|authoriz\w* to work|eligible to work legally|work authorization", "select"),
    ("not_worked_here", r"have you (previously )?worked (at|for)|previously worked at|consulted for", "select"),
    ("no_current_agreement", r"subject to any (employment )?agreement|non-?compete|post-employment restriction|restrictive covenant", "select"),
    ("will_relocate", r"relocat", "select"),
    ("onsite_ok", r"hybrid|in[- ]office|onsite|on-site|commut|days per week|work from the office", "select"),
    ("not_referred", r"were you referred|referral", "select"),
    ("current_company", r"current \(or most recent\) company|current company|current employer|most recent employer", "text"),
    ("consent", r"privacy (notice|acknowledg)|i agree|consent to .*(collect|process)|acknowledg", "select"),
    ("consent", r"sms|whatsapp|contact you via", "select"),
    ("gender", r"gender", "select"),
    ("transgender", r"transgender|identify as\b(?!.*(gender|race|ethnic))", "select"),
    ("cis_trans", r"i identify as\b", "select"),
    ("sexual_orientation", r"sexual orientation", "select"),
    ("hispanic", r"hispanic|latino|latina|latinx", "select"),
    ("race", r"please identify (your )?race|identify my race|race and ethnicity", "select"),
    ("race_east_asian", r"ethnicit|race/ethnic", "select"),
    ("race", r"\brace\b", "select"),
    ("veteran_protected", r"protected veteran|veteran status|served in the military|military service", "select"),
    ("disability", r"disability|chronic condition", "select"),
    ("school_ats", r"^school|university|college", "select"),
    # Some tenants draw the same question as a plain text input instead of a react-select, and the
    # answer is the same string either way. 49 saved inventories had "School"/"School*" on kind=text.
    # Anchored, because a text field is typed into verbatim and a loose pattern would fill it with the
    # wrong string rather than failing visibly.
    ("school_ats", r"^school\s*\*?$|^university\s*\*?$|^college\s*\*?$", "text"),
    ("degree", r"^degree", "select"),
    ("degree", r"^degree\s*\*?$|^degree (type|level)\s*\*?$", "text"),
    ("field", r"field of study|major|discipline", "select"),
    ("field", r"^(discipline|field of study|major|concentration)\s*\*?$", "text"),
]


# A FIELD WHOSE QUESTION COULD NOT BE READ IS NOT AN UNKNOWN FIELD.
#
# The label matchers above need a human-readable question, and some tenants render inputs with no
# label in the DOM at all - SmartRecruiters and Workable do this for whole blocks. The saved corpus
# has 362 such controls, and they are not exotic: "name:email", "name:urls[LinkedIn]",
# "name:eeo[veteran]", "id:postcode", "id:location-input". The `name` attribute still says exactly
# what each one is, and that is what this table reads.
#
# It runs ONLY when no label matcher answered, so it cannot override a question that was read. That
# is also what makes it safe for the entries that overlap the table above: the risk of the ref form
# is a false positive, and a false positive is only reachable on a field that had no question anyway.
REF_MATCHERS: list[tuple[str, str]] = [
    ("email", r"e-?mail"),
    ("first_name", r"^first_?name\b|^fname$|^given_?name"),
    ("last_name", r"^last_?name\b|^lname$|^surname$|^family_?name"),
    ("full_name", r"^(full_?)?name$|^your_?name$|^name_?full$"),
    ("phone", r"phone|^tel$|^telephone|mobile"),
    ("city_full", r"location-?input|^city$|^location$|^current_?location"),
    ("postal_code", r"post(?:al)?_?code|^zip"),
    ("country", r"^country|country_?code"),
    ("linkedin", r"linkedin"),
    ("github", r"github"),
    ("twitter", r"twitter|^x$"),
    ("current_company", r"^org$|^company$|^employer$|current_?company"),
    # Two tenants spell the same standard fields differently: Workable uses `eeo[veteran]`, Ashby uses
    # `<uuid>__systemfield_eeoc_veteran_status`. Both still identify the question when neither the
    # label nor the group heading could be read.
    ("gender", r"eeo\[gender\]|__eeoc_gender|^gender$"),
    ("race_east_asian", r"eeo\[race\]|__eeoc_race|^race$|ethnic"),
    ("veteran_protected", r"eeo\[veteran\]|__eeoc_veteran|veteran"),
    ("disability", r"eeo\[disability\]|__eeoc_disability|disability"),
    ("sexual_orientation", r"eeo\[orientation\]|__eeoc_orientation|orientation"),
    ("hispanic", r"eeo\[hispanic\]|__eeoc_hispanic|hispanic|latino"),
    ("name_pronunciation", r"pronunciation"),
]


# Canonical answer -> tenant option text. Tenants word the same choice differently
# ("Male" vs "Man", "No" vs "No, I do not have a disability and have not had one in the past").
OPTION_SYNONYMS: dict[str, list[str]] = {
    # Order matters: exact-ish phrasings first. "male" must never fall through to a substring
    # match on "woman" (see the word-boundary rule in resolve_option).
    "male": ["cisgender man", "man", "male", "he / him", "he/him/his", "cisgender male"],
    "female": ["cisgender woman", "woman", "female", "she / her", "she/her/hers", "cisgender female"],
    "man": ["cisgender man", "man", "male"],
    "gender identity": ["cisgender man", "man", "male"],
    "no": ["no", "no, i do not have a disability", "no, i am not a veteran", "no, i don’t have a disability",
           "i have not worked at doordash", "no military service"],
    "yes": ["yes"],
    "asian": ["asian", "east asian"],
    "east asian": ["east asian", "asian"],
    "straight / heterosexual": ["straight/heterosexual", "heterosexual", "straight"],
    "i am not a protected veteran": ["i am not a protected veteran", "no, i am not a veteran", "no military service"],
    "company official website / careers page": ["company careers page", "career page", "company website", "careers website"],
    "cisgender": ["cisgender", "no"],
    "no": ["no", "cisgender", "no, i do not have a disability", "no, i am not a veteran", "no, i don’t have a disability",
           "i have not worked at doordash", "no military service"],
    "no, i do not have a disability and have not had one in the past": [
        "no, i do not have a disability and have not had one in the past", "no"],
    "united states": ["united states", "united states of america"],
}


def synonyms_for(answer: str, key: str | None = None) -> list[str]:
    """Tenant wordings to try for one answer, most specific first.

    `OPTION_SYNONYMS` is keyed by the ANSWER VALUE, which cannot separate two questions that share
    one. On 57 saved fields the answer was the bare string "Yes" while the tenant's options read
    "Acknowledge/Confirm", "I am authorized to work for any employer in the country in which this
    position is based.", "I require/will require <tenant>'s sponsorship to obtain work
    authorization ..." and "I am willing to relocate before starting employment." - four different
    questions, one answer value, four option lists. Keying by the question is what tells them apart;
    the value table stays the fallback for everything a key-specific entry does not cover.
    """
    specific = OPTION_SYNONYMS_BY_KEY.get(key or "", [])
    generic = OPTION_SYNONYMS.get(norm(answer), [norm(answer)])
    return specific + [s for s in generic if s not in specific]


# Option wordings that only make sense for ONE question. Read off the saved corpus, where the same
# "Yes" served consent, authorization, sponsorship and relocation questions on a single form.
OPTION_SYNONYMS_BY_KEY: dict[str, list[str]] = {
    "consent": ["acknowledge/confirm", "i agree", "consent", "i acknowledge", "i consent",
                "acknowledge", "i accept", "yes, i agree"],
    "authorized": ["i am authorized to work for any employer in the country in which this position is based",
                   "i am legally authorized to work", "i am authorized to work for any employer",
                   "authorized to work for any employer"],
    "sponsor_now": ["i require/will require", "i require sponsorship", "i will require sponsorship",
                    "i need/will need sponsorship", "requires sponsorship"],
    "sponsor_future": ["i will require sponsorship in the future", "i require future sponsorship"],
    "will_relocate": ["i am willing to relocate before starting employment",
                      "i am willing to relocate", "yes, i am willing to relocate"],
    "onsite_ok": ["i am able to meet this requirement", "yes, i can meet this requirement"],
    "how_heard": ["company careers page", "careers website", "company website", "career page",
                  "the company's careers page", "company career site"],
    # THE QUESTION DECIDES THE WORDING, NOT THE CANDIDATE'S SHORTHAND. The profile records the veteran answer in short
    # form ("No") while a tenant's veteran question offers long disclosures, and no amount of substring matching turns
    # "No" into "I am not a protected veteran" without saying so. This entry was invisible while the table carried the
    # long option text as its own literal; removing that literal is what made a REQUIRED veteran group fall back to
    # needs_review with the answer plainly on file. The usual ATS wording comes first, as above.
    "veteran_protected": ["i am not a protected veteran", "no, i am not a veteran or active member",
                          "no, i am not a veteran", "i am not a veteran", "no military service",
                          "i have never served in the military"],
}


def resolve_option(answer: str, options: list[str], key: str | None = None) -> tuple[str | None, bool]:
    """Map a canonical answer onto the tenant's actual option text.
    Returns (option_text, is_exact)."""
    if not options:
        return answer, True          # no option list recorded (free text or unopened dropdown)
    a = norm(answer)
    normed = {norm(o): o for o in options}
    if a in normed:
        return normed[a], True
    synonyms = synonyms_for(answer, key)
    for syn in synonyms:
        if syn in normed:
            return normed[syn], False
    # prefix / substring in either direction, longest option first so the most
    # specific match wins ("No, I do not have a disability..." over "No")
    for o in sorted(options, key=len, reverse=True):
        n = norm(o)
        if n.startswith(a) or a.startswith(n):
            return o, False
        for syn in synonyms:
            if n.startswith(syn):
                return o, False
    # Last resort: the synonym must appear as a whole word, never inside a longer word
    # ("man" inside "woman" used to select "Transgender woman" for a male candidate).
    for o in sorted(options, key=len, reverse=True):
        words = set(re.findall(r"[a-z0-9]+", norm(o)))
        for syn in synonyms:
            syn_words = set(re.findall(r"[a-z0-9]+", syn))
            if syn_words and syn_words <= words:
                return o, False
    return None, False


def years_of_experience(app: dict) -> int:
    """Industry years from the earliest work-history start.

    Grounded in `application_profile.json` so the figure comes from the history itself rather than from a
    number someone typed: the years metric in `candidate_profile.json` is the approved way to SAY it, and
    this is where the value it describes is computed.
    """
    starts = []
    for job in app.get("work_experience", []):
        m = re.match(r"(\d{2})/(\d{4})", job.get("from", ""))
        if m:
            starts.append(int(m.group(2)))
    if not starts:
        return 0
    return max(0, datetime.date.today().year - min(starts))


def experience_option(app: dict, options: list[str]) -> str | None:
    """Pick the bracket that contains the computed years of experience."""
    years = years_of_experience(app)
    if not years or not options:
        return None
    for option in options:
        nums = [int(n) for n in re.findall(r"\d+", option)]
        if not nums:
            continue
        low = nums[0]
        high = nums[1] if len(nums) > 1 else None
        plus = "+" in option and high is None
        less = re.search(r"less than|under", option, re.I) is not None
        if less and years < low:
            return option
        if high is not None and low <= years <= high:
            return option
        if plus and years >= low:
            return option
    return None


SHORT_FIELD_RE = re.compile(
    r"first name|last name|preferred (full )?name|pronoun|full name|your name|company|job title|"
    r"current title|linkedin|github|website|url|postal|zip|city\b|school")


ANSWER_RULES_PATH = DATA_DIR / "form_specs" / "answer_rules.json"


def load_answer_rules(path: pathlib.Path | None = None) -> list[dict]:
    """The answers an agent has already worked out, so they are answered once and not once per application.

    Shape: [{"questionRe": <regex>, "answer": <str>, "kind": "text"|"select"|"check" (optional), "note": <why>}].
    A missing file is not an error - the drafter works exactly as before, and the rules are an addition.

    `note` is required in spirit rather than by validation: an entry that cites nothing cannot be told apart from a
    guess, and because it now MATCHES it will never appear in `needs_review` again. The rule is the same one the
    contract states for a test's comment - the specifics belong with the rule, not in a log somewhere else.
    """
    p = path or ANSWER_RULES_PATH
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    out: list[dict] = []
    for r in data.get("rules") or []:
        if not isinstance(r, dict):
            continue
        pat, ans = r.get("questionRe"), r.get("answer")
        if not pat or ans in (None, ""):
            continue
        try:
            re.compile(pat)
        except re.error:
            continue  # a broken pattern must not take every other rule down with it
        out.append({"questionRe": pat, "answer": ans, "kind": r.get("kind"), "note": r.get("note") or ""})
    return out


ANSWER_RULES: list[dict] = load_answer_rules()


def pick_answer(label: str, table: dict, kind: str, rules: list[dict] | None = None):
    text = norm(label)
    if not text:
        return None, None
    # THE PERSISTED RULES FIRST. Each one exists because a real question needed it and an agent worked the answer out;
    # they are more specific than a heuristic over general English, so they get the first look.
    for i, rule in enumerate(ANSWER_RULES if rules is None else rules):
        if rule.get("kind") and rule["kind"] != kind:
            continue
        if re.search(rule["questionRe"], text, re.I):
            answer = rule["answer"]
            # The Asana guard is NOT bypassable by data: a sentence cannot go into a short field, whoever wrote the
            # rule. A rule that trips this is a rule to fix, not a guard to move.
            if isinstance(answer, str) and len(answer) > 100 and SHORT_FIELD_RE.search(text):
                continue
            return f"@rule:{i}", answer
    for key, pattern, matcher_kind in MATCHERS:
        if matcher_kind != kind:
            continue
        if re.search(pattern, text):
            answer = table.get(key)
            # A LONG ANSWER MUST NEVER LAND IN A SHORT FIELD. The word-boundary fix above removes the specific bug
            # that put the OPT paragraph into "Preferred Full Name" and "My pronouns are" on Asana, but a matcher
            # table is a heuristic and the next pattern will be written by someone else. A name, pronoun, company,
            # title or URL field cannot hold a sentence, so refuse the pairing instead of writing it and hoping a
            # review notices. (2026-10-08)
            if isinstance(answer, str) and len(answer) > 100 and SHORT_FIELD_RE.search(text):
                return None, None
            return key, answer
    return None, None


def ref_hint(ref: str) -> str:
    """The ref as a lowercase handle with the tenant's id/name prefix removed.

    `name:urls[LinkedIn]` -> `urls[linkedin]`; `id:location-input` -> `location-input`. A generated
    ordinal key (`input:7`) carries nothing and matches nothing, which is the honest outcome.
    """
    text = (ref or "").strip().lower()
    for prefix in ("id:", "name:", "group:"):
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def pick_answer_from_ref(ref: str, table: dict):
    """Answer from the control's `name`/`id`, for a field whose question could not be read.

    Returns (key, answer) or (None, None). A key whose canonical answer is empty returns nothing
    rather than a blank: the ref says which field this is, never what to write in it.
    """
    hint = ref_hint(ref)
    if not hint:
        return None, None
    for key, pattern in REF_MATCHERS:
        if not re.search(pattern, hint):
            continue
        answer = table.get(key)
        if answer not in (None, ""):
            return key, answer
    return None, None


COMP_RE = re.compile(r"\$\s?([\d,]{4,})")
COMP_LABEL_RE = re.compile(r"compensation|salary|pay expectation|expected pay|total (annual )?(compensation|pay)")


def preferred_locations(candidate: dict | None = None) -> list:
    """The standing order, read from canonical data. [] when it is absent - and then nothing is chosen for a place."""
    if candidate is None:
        candidate = (load(DATA_DIR / "candidate_profile.json") or {}).get("candidate") or {}
    entry = ((candidate or {}).get("standing_answers") or {}).get("preferred_locations") or {}
    order = entry.get("order") if isinstance(entry, dict) else None
    return [str(x) for x in order if str(x).strip()] if isinstance(order, list) else []


def relocate_answer(field: dict, candidate: dict | None = None):
    """The highest-ranked preferred place the field OFFERS, else None.

    Returns None rather than `Yes` when no option names a place, because the caller still has the standing `Yes` rule
    for the ordinary yes/no version of this question - and choosing a city there would be answering a different
    question. The rule (docs/RULES.md) puts the field's own list last in the order for exactly this reason.
    """
    options = [str(o) for o in (field.get("options") or [])]
    if not options:
        return None
    for place in preferred_locations(candidate):
        for option in options:
            if place.lower() in option.lower():
                return option
    return None


def compensation_rule(candidate: dict | None = None) -> dict:
    """The standing compensation rule, read from canonical data rather than hardcoded.

    `candidate_profile.json -> standing_answers.compensation`. Returns {} when it is absent or malformed, and the caller
    then reports "ask the user" - an explicit miss rather than a silent default, because a number nobody recorded is a
    claim about the candidate.
    """
    if candidate is None:
        candidate = (load(DATA_DIR / "candidate_profile.json") or {}).get("candidate") or {}
    entry = ((candidate or {}).get("standing_answers") or {}).get("compensation") or {}
    if not isinstance(entry, dict):
        return {}
    raw = entry.get("fallback")
    try:
        fallback = int(str(raw).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return {}
    if fallback <= 0:
        return {}
    return {"rule": entry.get("rule") or "top_of_published_band", "fallback": fallback,
            "currency": entry.get("currency") or "USD", "note": entry.get("note") or ""}


def compensation_answer(field: dict):
    """Highest published band from the field's own help text, else the user's fallback (user rules 2026-09-17, 2026-10-10).

    Returns `(value, published)`: `published` is True only when the number came from the posting or the field's own
    help text. The caller carries that through, because "the employer published $200,000" and "we put $200,000 there
    because nothing was published" are different facts about an application - and a fallback that reads like a band is
    exactly the kind of claim this project refuses to make silently.
    """
    haystack = " ".join(str(field.get(k, "")) for k in ("label", "help", "description", "options"))
    amounts = [int(m.replace(",", "")) for m in COMP_RE.findall(haystack)]
    if amounts:
        return f"${max(amounts):,}", True
    rule = compensation_rule()
    if not rule:
        return None, False
    return f"${rule['fallback']:,}", False


def main() -> int:
    parser = argparse.ArgumentParser(description="Draft an ATS fill spec from a form inventory.")
    parser.add_argument("fields", help="JSON written by inspect_ats_form.mjs")
    parser.add_argument("--out", help="Output path. Default: tmp/apply/<stem>.spec.draft.json")
    parser.add_argument("--url", help="Override the form URL (otherwise taken from the inventory)")
    parser.add_argument("--resume", help="Resume PDF path to attach")
    parser.add_argument("--cover-letter", help="Cover-letter PDF path to attach")
    parser.add_argument("--job", default="", help="Human label, e.g. 'Chime — Senior Software Engineer'")
    args = parser.parse_args()

    inventory = load(pathlib.Path(args.fields))
    candidate = load(DATA_DIR / "candidate_profile.json")["candidate"]
    app = load(DATA_DIR / "application_profile.json")
    table = build_answer_table(candidate, app)

    fields = inventory.get("fields") or []
    spec: dict = {"job": args.job, "url": args.url or inventory.get("url", ""), "texts": [], "textareas": [],
                  "selects": [], "checks": [], "radios": []}
    target = ""
    if spec["url"]:
        m = re.search(r"token=([^&]+)", spec["url"]) or re.search(r"/jobs/(\d+)", spec["url"]) or re.search(r"/job_application_requests/([^/?#]+)", spec["url"])
        if m:
            target = m.group(0)
    spec["target"] = target

    needs_review: list[dict] = []
    used_files: dict[str, str] = {}
    seen_checks: set[str] = set()
    seen_groups: set[str] = set()

    # A radio/checkbox group arrives as ONE FIELD PER OPTION, all sharing `option_group`, and the
    # option's own text is all that used to be visible on each row. Rebuild the groups so a question
    # can be answered with the option that selects it.
    groups: dict[str, list[dict]] = {}
    for candidate in fields:
        if (candidate.get("type") or "").lower() not in ("radio", "checkbox"):
            continue
        group_key = candidate.get("option_group")
        if group_key:
            groups.setdefault(group_key, []).append(candidate)

    for field in fields:
        ref = field.get("ref") or ""
        label = field.get("label") or ""
        ftype = (field.get("type") or "").lower()
        value = field.get("value") or ""
        react = bool(field.get("react_select"))
        if not ref:
            continue
        # already answered on the page? keep it, nothing to do
        if value and value not in ("[unchecked]", "[checked]"):
            continue
        if ftype == "file":
            group = ref[6:] if ref.startswith("group:") else label or ref
            if re.search(r"resume|cv", norm(group)) and args.resume:
                used_files["resume"] = args.resume
            elif re.search(r"cover", norm(group)) and args.cover_letter:
                used_files["cover"] = args.cover_letter
            continue
        if ftype in ("checkbox", "radio"):
            # The group's QUESTION, not the option's own text: on a radio row `label` reads "Male",
            # which says nothing about what is being asked. `group_label` is what the scanner now
            # reports from the field entry; it falls back to `label` for tenants that put the
            # question on the input itself.
            question = norm(field.get("group_label") or label)
            # A CHECKBOX IS CHECKED. A RADIO GROUP IS DECIDED - and the difference is where a whole class of
            # wrong answer hid. `seen_checks` is keyed by REF, and every option of a radio group carries its
            # own ref, so this guard never deduped a radio group: one `checked: true` was emitted per option,
            # `apply_form_spec.mjs` applies them in order, and on a radio group the LAST one wins. A required
            # acknowledgement group reading ["I acknowledge", "I do not acknowledge"] therefore committed
            # "I do not acknowledge", and nothing downstream caught it - the gate counts groups holding *a*
            # selection and the group is not empty. A radio group whose question mentions consent now goes
            # through the answer path below like any other question, where `OPTION_SYNONYMS["consent"]`
            # resolves "Yes" onto the option that actually says it.
            if ftype == "checkbox" and re.search(r"consent|privacy|acknowledg|agree|demographic", question):
                if ref not in seen_checks:
                    seen_checks.add(ref)
                    spec["checks"].append({"ref": ref, "checked": True})
                continue

            group_key = field.get("option_group") or ref
            if group_key in seen_groups:
                continue                      # the group is decided on its first row, not on each one
            seen_groups.add(group_key)

            key, answer = pick_answer(question, table, "select")
            if answer in (None, ""):
                # Ashby's EEO refs carry the question too: `...__systemfield_eeoc_veteran_status`.
                key, answer = pick_answer_from_ref(ref, table)
            if answer not in (None, ""):
                members = groups.get(group_key, []) or [field]
                texts = [str(m.get("label") or "") for m in members]
                option, _ = resolve_option(answer, texts, key)
                chosen = next((m for m in members if str(m.get("label") or "") == option), None)
                if chosen:
                    # `radios` entries carry the option text because the ref resolves to the group;
                    # `checks` entries name the single box. Both are what apply_form_spec.mjs reads.
                    spec["radios" if ftype == "radio" else "checks"].append(
                        {"ref": chosen.get("ref"), "option": option} if ftype == "radio"
                        else {"ref": chosen.get("ref"), "checked": True})
                    continue

            if field.get("required"):
                # A required group that could not be answered honestly. It used to be dropped
                # silently, which only showed up as a rejected submit; surface every option instead.
                needs_review.append({
                    "ref": ref, "label": question or label, "type": ftype, "required": True,
                    "options": field.get("options") or [],
                    "note": "required group - pick the option(s) that apply; the ref is one option of the group",
                })
            continue

        kind = "select" if react else ("textarea" if ftype == "textarea" or field.get("tag") == "textarea" else "text")
        key, answer = pick_answer(label, table, kind if kind != "textarea" else "text")
        if answer in (None, ""):
            # The question could not be read, or no matcher knows it. The control's own name/id
            # often still says what it is - 362 such fields in the saved corpus. This cannot
            # override a label that DID answer, because it only runs when that produced nothing.
            ref_key, ref_answer = pick_answer_from_ref(ref, table)
            if ref_answer not in (None, ""):
                key, answer = ref_key, ref_answer
        if key == "__experience__":
            # computed from work history, then resolved against the field's own brackets
            answer = experience_option(app, field.get("options") or [])
            if answer is None:
                needs_review.append({
                    "ref": ref, "label": label,
                    "reason": f"years-of-experience brackets do not cover the computed {years_of_experience(app)} years",
                    "required": bool(field.get("required")), "options": (field.get("options") or [])[:12],
                })
                continue

        # compensation needs the posting's own range
        if answer is None and COMP_LABEL_RE.search(norm(label)):
            # THE POSTING FIRST. `payRange` is what `inspect_ats_form.mjs` read off the employer's own description;
            # the field's help text is a tenant's afterthought and is checked second. Without this the only band the
            # rule could ever see was the empty help text of this field, so the fallback fired on a posting that
            # publishes $127,100 - $185,000 and $200,000 went into the spec.
            if isinstance(inventory.get("payRange"), dict) and inventory["payRange"].get("high"):
                published = f"${int(inventory['payRange']['high']):,}"
                entry = {"ref": ref, "value": published,
                         "note": (f"The TOP of the range this posting publishes: "
                                  f"${int(inventory['payRange']['low']):,} - {published}, read from the posting's own "
                                  f"text by inspect_ats_form.mjs.")}
                spec["textareas" if kind == "textarea" else "texts"].append(entry)
                continue
            # `compensation_answer` returns (value, published). Unpacking is not cosmetic: the value goes into the
            # form, and the flag decides whether the spec entry carries a note saying the number is OUR fallback
            # rather than the employer's published band. Writing the tuple itself is the bug this replaces.
            comp_value, comp_published = compensation_answer(field)
            if comp_value is None:
                needs_review.append({"ref": ref, "label": label,
                                     "reason": "compensation: no published band AND no rule in "
                                               "candidate_profile.json -> standing_answers.compensation"})
                continue
            if comp_value:
                entry = {"ref": ref, "value": comp_value}
                if not comp_published:
                    entry["note"] = (
                        f"FALLBACK, not published: no band was found on the posting or in this field's own help "
                        f"text, so the user's standing fallback ({comp_value}) was used (user rule 2026-10-10)."
                    )
                spec["textareas" if kind == "textarea" else "texts"].append(entry)
                continue
            needs_review.append({"ref": ref, "label": label, "reason": "compensation: no published range found on the field — ask the user"})
            continue

        if answer in (None, ""):
            needs_review.append({
                "ref": ref, "label": label,
                "reason": "no profile mapping" if field.get("required") else "optional, no profile mapping",
                "required": bool(field.get("required")),
                "options": field.get("options", [])[:12],
            })
            continue

        if kind == "select":
            options = field.get("options") or []
            option, exact = resolve_option(answer, options, key)
            if option is None and key == "will_relocate":
                # A RELOCATION FIELD WHOSE OPTIONS ARE PLACES IS ANSWERED WITH A PLACE. Which place is not decided
                # here: `relocate_answer` reads the profile's `priority_locations` and takes the highest-ranked
                # one this field actually offers. Tried only after the ordinary match, so a
                # form that does offer "Yes" - or "I am willing to relocate" - keeps using it. On the Twitch form this
                # is the difference between the field being filled and it being listed as an unmatched answer.
                # NO `candidate` ARGUMENT. `main()` binds that name to the profile, then its own
                # `for candidate in fields:` loop - the one that rebuilds the radio/checkbox groups from one
                # field per option - rebinds it to a FIELD, so passing it here handed `relocate_answer` a
                # field dict - `preferred_locations` found no standing answers in it, the order came back empty and
                # this returned None while the same call from outside the loop returned "Seattle, WA". The function
                # loads the profile itself when the argument is absent, which is what makes it testable standalone.
                option = relocate_answer(field)
                exact = True
            if option is None:
                needs_review.append({
                    "ref": ref, "label": label,
                    "reason": f"profile answer '{answer}' has no matching option",
                    "required": bool(field.get("required")), "options": options[:12],
                })
                continue
            item = {"ref": ref, "option": option}
            if not exact and norm(option) != norm(answer):
                item["note"] = f"mapped from profile answer '{answer}'"
            spec["selects"].append(item)
        elif kind == "textarea":
            spec["textareas"].append({"ref": ref, "value": answer})
        else:
            spec["texts"].append({"ref": ref, "value": answer})

    # CONTROLS THE SPEC FORMAT CANNOT HOLD ARE NOT SILENTLY DROPPABLE. `extra_widgets` carries Ashby's
    # Yes/No button pairs and bare div dropdowns. The drafter read only `fields`, so Alchemy's three
    # REQUIRED button-pair questions - work authorization, visa sponsorship and in-person attendance -
    # were neither answered nor reported: the inventory said 26 fields, all of them blank, and the
    # three questions that decide eligibility were invisible to every review. They are driven by
    # `answer_by_question_text.mjs` rather than by a fill spec, so they go to review carrying the
    # answer their own question implies.
    for extra in inventory.get("extra_widgets") or []:
        question = extra.get("label") or ""
        widget = extra.get("widget") or {}
        entry = {
            "ref": extra.get("ref") or extra.get("key") or "",
            "label": question,
            "type": widget.get("kind") or "extra_widget",
            "options": extra.get("options") or [],
            "note": "not expressible in a fill spec - drive it with "
                    + str((widget.get("recipe") or {}).get("tool") or "the recipe's tool"),
        }
        key, answer = pick_answer(norm(question), table, "select")
        if answer in (None, ""):
            key, answer = pick_answer_from_ref(entry["ref"], table)
        if answer not in (None, ""):
            entry["suggested_answer"] = answer
        needs_review.append(entry)

    # A FILE FIELD WITH NO QUESTION TEXT WAS INVISIBLE TO THIS (fixed 2026-10-08). The resume was only recorded when a
    # GROUP's name matched resume|cv, so Chime's form - whose resume input carries an empty label - produced
    # files: null, and the submit came back refused with "Resume/CV is required." twice, once for xAI and once here.
    # Fall back to the field's OWN ref, which is what apply_form_spec actually resolves.
    # WHICH REF is a separate question from WHETHER TO EMIT. The old shape could not emit at all unless the scan
    # happened to find a blank file input, so a second pass over an already-filled form silently dropped the
    # attachment - which is how a scripted refill ended with no cover letter and no `files` key.
    bare_resume_ref = "group:Resume/CV"
    for field in fields:
        ref = str(field.get("ref") or "")
        if field.get("type") == "file" and re.search(r"resume|cv", ref, re.I):
            bare_resume_ref = ref
            break
    bare_cover_ref = "group:Cover Letter"
    for field in fields:
        ref = str(field.get("ref") or "")
        if field.get("type") == "file" and re.search(r"cover", ref, re.I):
            bare_cover_ref = ref
            break

    # Given as flags means asked for. An already-attached file makes the filler report `group not found` and carry on,
    # which is benign and true; silently dropping the file makes the form arrive without it and says nothing.
    if args.resume or args.cover_letter:
        spec["files"] = []
        if args.resume:
            spec["files"].append({"ref": bare_resume_ref, "path": args.resume})
        if args.cover_letter:
            spec["files"].append({"ref": bare_cover_ref, "path": args.cover_letter})

    out_path = pathlib.Path(args.out) if args.out else pathlib.Path("tmp/apply") / (pathlib.Path(args.fields).stem.replace("_fields", "") + ".spec.draft.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # The spec file is written in exactly the shape src/forms/apply_form_spec.mjs consumes
    # (top-level target/texts/...). Fields needing judgement go to a sidecar review file.
    out_path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    review_path = out_path.with_name(out_path.stem + ".needs_review.json")
    review_path.write_text(
        json.dumps({"job": args.job, "url": spec["url"], "needs_review": needs_review}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    filled = len(spec["texts"]) + len(spec["textareas"]) + len(spec["selects"]) + len(spec["checks"]) + len(spec.get("files", []))
    print(json.dumps({
        "spec": str(out_path),
        "needs_review_file": str(review_path),
        "auto_answered": filled,
        "needs_review": len(needs_review),
        "required_unknown": [n["label"][:70] for n in needs_review if n.get("required")],
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
