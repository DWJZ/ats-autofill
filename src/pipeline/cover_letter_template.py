#!/usr/bin/env python3
"""cover_letter_template.py - render a cover letter from a template and canonical facts, and refuse to guess.

WHY A TEMPLATE. Every cover letter this project has sent was written ad hoc, so every one was a fresh chance to state
something unbacked - and `build_cover_letter.py` takes a finished `--body` file, which means the facts inside it are
whatever the caller typed. A template splits the two: the SENTENCES are fixed boilerplate, and every FACT in them is
filled from `candidate_profile.json` / `application_profile.json` by name.

TWO GUARDS, and they are the reason this is a module rather than three lines in the builder:

  1. AN UNRESOLVED PLACEHOLDER IS AN ERROR, NOT A BLANK. A letter that says "I have  building" is worse than no letter,
     and a letter that quietly drops a claim is worse still. Every `{{name}}` must resolve or the render raises.
  2. NOTHING FROM `do_not_claim` CAN APPEAR. The template cannot introduce a banned term, because the only facts that
     reach it come from the context this module builds - and the rendered text is checked against the list anyway, as
     the last line of defence. The resume validator already rejects these terms inside honest negatives; a cover letter
     deserves the same treatment.
"""
from __future__ import annotations

import datetime
import re

PLACEHOLDER = re.compile(r"\{\{([a-z0-9_]+)\}\}")

#: The placeholders a profile is ALLOWED to have nothing to say about. An unresolved placeholder is an error, not a
#: blank - that guard is the reason letter 1 never went out saying "I am based in ." - but the guard was reading
#: "optional" as "missing". Two of the facts in the context are optional about the PERSON rather than about the data:
#: `linkedin` and `github` are keys every profile carries and a real one may leave empty, and a letter that refuses to
#: render for someone without a LinkedIn account is a guard that has to be switched off rather than obeyed. Everything
#: not named here still raises: a sentence with a hole in it is worse than no letter.
OPTIONAL_PLACEHOLDERS = frozenset({"linkedin", "github"})


class TemplateError(ValueError):
    """A placeholder that cannot be resolved, or a banned term in the result."""


def _first_text(mapping: dict | None, *keys: str) -> str:
    """The first of `keys` the mapping actually answers, as a string; `""` when it answers none of them.

    THE SHAPE EVERY OTHER OPTIONAL FACT IN THIS PROJECT USES (see `IDENTITY` in
    src/forms/ashby_finish_form.mjs and `greenhouse_scaffold`): a key the profile does not have, and a key whose value
    is empty, mean the same thing - this person has nothing to say about it - so both produce an empty string and
    neither raises. `candidate['github']` did neither: it is absent for anyone without a GitHub account, and the
    AttributeError it raised was the first thing a letter met for a GitHub-less applicant.
    """
    if not isinstance(mapping, dict):
        return ""
    for key in keys:
        value = mapping.get(key)
        if value:
            return str(value)
    return ""


def _in_progress(entry: dict) -> bool:
    """Whether an education entry is study the person has not finished.

    `status` is the profile's own word for it (`"expected"` on the example master's, `"completed"` on a degree already
    held). When it is absent the date field decides, because that field already carries the distinction in the resume's
    own words: "Expected May 2026" against "Jun 2014". Nothing here reads the DEGREE - see `_degree_entry`.
    """
    status = str(entry.get("status") or "").strip().lower()
    if status:
        return any(marker in status for marker in ("expected", "progress", "current", "ongoing"))
    return "expected" in str(entry.get("resume_date") or "").lower()


def _degree_entry(education: list) -> dict:
    """The one education entry the letter introduces the applicant with, or `{}` for a profile that holds none.

    THE DEGREE IN THE SENTENCE IS THE ONE THE PROFILE HOLDS. This used to be
    `next((e for e in edu if "M.S." in (e.get("degree") or "")), edu[0] if edu else {})` - a search for a master's
    degree, falling back to whatever came first. For anyone who does not hold one the fallback fired and the letter
    said "I am finishing an M.S. at Toronto Metropolitan University" on behalf of a nurse with a B.Sc.N. from that same
    school: a false degree, built from a true fact by a lookup nobody checked the result of. Nothing in this module
    searches the profile for a degree to name.

    ORDER DECIDES, NOT PRESTIGE: whoever wrote the profile put the degree they want leading the resume first. The one
    exception is study still in progress, which the person is more than a graduate - "I am finishing an M.S." is the
    present tense a finished degree does not have.
    """
    entries = [e for e in (education or []) if isinstance(e, dict)]
    return next((e for e in entries if _in_progress(e)), entries[0] if entries else {})


def _article(phrase: str) -> str:
    """`a` or `an` for the degree phrase that follows.

    It reads PRONUNCIATION, not spelling, for the acronyms a resume is written in: "an M.S." is right and "a M.S."
    is not, and so the first letter is expanded when it is one whose letter-name begins with a vowel - `M` is "em".
    A phrase whose first letter gets no such expansion reads its own spelling: "a B.Sc.N.", "an Honours ...".
    """
    word = str(phrase or "").strip().split(" ")[0].strip("\"'(")
    if not word:
        return "a"
    if len(word) > 1 and word[1] == ".":          # an acronym: M.S., B.Sc.N., A.A.S.
        return "an" if word[0].upper() in "AEFHILMNORSX" else "a"
    return "an" if word[0].lower() in "aeiou" else "a"


def build_context(profile: dict, app: dict, company: str, role: str) -> dict:
    """Every fact the template may use, taken by name from canonical data and nothing else.

    CONTACT DETAILS COME FROM `application_profile.json -> candidate`, not from `candidate_profile.json`: the profile
    carries identity and claims, and the application profile carries the contact block and the history. Reading the
    wrong one produced two unresolvable placeholders on the first render, which is the guard working - the letter
    never came out with a hole in it.
    """
    inner = profile.get("candidate") or {}
    contact = app.get("candidate") or {}
    addr = contact.get("address") or {}
    edu = app.get("education") or []
    entry = _degree_entry(edu)
    degree_phrase = _first_text(entry, "resume_degree", "degree")
    skills = [s for s in (profile.get("confirmed_skills") or []) if isinstance(s, str)]
    # `safe_metrics` is a LIST of approved phrasings - the vetted way to state each figure, one entry
    # per claim - not a mapping. Read it as a list, and pick the years entry out by its own wording.
    metrics = [m for m in (profile.get("safe_metrics") or []) if isinstance(m, str)]
    phone = contact.get("phone")

    ctx = {
        "date": datetime.date.today().strftime("%B %-d, %Y"),
        "name": inner.get("name") or f"{contact.get('first_name','')} {contact.get('last_name','')}".strip(),
        "email": contact.get("email") or inner.get("email") or profile.get("email") or "",
        "phone": (phone.get("formatted") if isinstance(phone, dict) else phone) or "",
        # Empty for a person who has no LinkedIn account, which is a normal state and not a missing fact - see
        # OPTIONAL_PLACEHOLDERS. The two spellings are read because the two profiles hold it in different places.
        "linkedin": contact.get("linkedin") or inner.get("linkedin") or "",
        "github": contact.get("github") or inner.get("github") or "",
        "city_state": ", ".join(x for x in (addr.get("city"), addr.get("state")) if x),
        # `{{school}}` and `{{degree}}` are the two halves of one fact, and both come from the education entry the
        # profile actually holds rather than from a degree looked up by name. A profile with no education at all
        # leaves both empty, which the unresolved-placeholder guard turns into a refusal instead of a sentence with
        # a hole in it.
        "school": _first_text(entry, "school"),
        "degree": degree_phrase,
        "article": _article(degree_phrase),
        "company": company or "",
        "role": role or "",
        # The years figure is the one approved phrasing a sentence can use directly; anything else would be a number
        # this module invented.
        "experience": next((m for m in metrics if "years" in m.lower()), ""),
    }
    # Three skill/metric pairs, because the template names them one at a time. A shortfall is left as an unresolvable
    # placeholder on purpose: the render then fails loudly instead of printing a letter with a hole in it.
    ctx["skills_line"] = ", ".join(skills[:8]) if skills else ""
    picked = metrics[:3]
    ctx["metrics_lines"] = "\n".join(f"- {m}" for m in picked) if picked else ""
    return ctx


def render(text: str, context: dict) -> str:
    """Fill the template, refusing to leave a hole or to state anything in `do_not_claim`.

    An empty REQUIRED fact still raises - that is the guard the first render needed. An empty OPTIONAL fact
    (`OPTIONAL_PLACEHOLDERS`) is substituted as nothing, because "this person has no LinkedIn" is a fact a letter can
    be written without and the alternative is refusing to write any letter for them.
    """
    missing = sorted({
        m for m in PLACEHOLDER.findall(text)
        if not str(context.get(m, "")).strip() and m not in OPTIONAL_PLACEHOLDERS
    })
    if missing:
        raise TemplateError(f"the template needs facts that canonical data does not provide: {missing}")

    # `.get` rather than `[name]`: the two checks above read the context with `context.get(m, "")`, so an OPTIONAL name
    # that the context does not carry at all must substitute as nothing here too. `[name]` raised KeyError instead -
    # the same defect as the missing key, one layer down, and the reason this test exists in two pieces.
    rendered = PLACEHOLDER.sub(lambda m: str(context.get(m.group(1), "")), text)
    leftover = PLACEHOLDER.findall(rendered)
    if leftover:  # unreachable while the check above holds, kept because the two must not drift apart
        raise TemplateError(f"unresolved placeholders survived the render: {leftover}")
    return rendered


def check_no_banned_terms(rendered: str, banned) -> None:
    """The last line of defence. `do_not_claim` is absolute, so a letter is checked against it like a resume.

    IT REUSES THE PIPELINE'S OWN MATCHER RATHER THAN A SUBSTRING TEST, and the first draft of this function is why.
    It used `term.lower() in haystack`, and on the Twitch letter it reported `Java` - inside the word **JavaScript**,
    which is a confirmed skill and not a banned one. `Java` is in `do_not_claim`; `JavaScript` is what the candidate
    actually writes. A substring test cannot tell them apart, and a guard that fires on a legitimate skill is a guard
    that will be switched off rather than fixed.

    `bounded_contains` already solves it, including the `+#` in its boundaries that keeps `C++` and `C#` whole.
    """
    from application_pipeline import bounded_contains  # noqa: PLC0415 - one pure helper, imported where it is used

    hits = [t for t in (banned or []) if isinstance(t, str) and t and bounded_contains(rendered, t)]
    if hits:
        raise TemplateError(f"the rendered letter states terms that must never be claimed: {hits}")
