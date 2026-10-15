#!/usr/bin/env python3
"""tenant_caps.py — may this board take one more application, and which stated limit says no?

WHY THIS EXISTS. `data/form_specs/tenant_caps.json` is the operative record of every tenant application limit,
and the only thing that ever read it was `data/scratch/preflight_role.py`, with the counting inlined in its
`main()`. A limit that nothing tests is a limit that quietly stops applying — Mercor's two-per-60-days rule was
in prose for two days and then refused a complete, gate-passing application at Submit — so the counting lives
here, where rows, caps and a date are all arguments and no filesystem, clock or argparse is involved.

THE TWO FACTS THIS FILE EXISTS TO HOLD, both learned the hard way:

  * **A tenant can state more than one limit, and the binding one is not always the one in the posting.**
    Coinbase's job description ends with "a maximum of 3 applications within a 6-month period" (recorded
    2026-10-06, from the tail of a posting, after the pay range). On 2026-10-09 its mailbox held five
    "Application Limit Reached" notices stating a DIFFERENT rule — "the maximum number of four applications
    allowed within a 30-day timeframe" — three of them for requisitions the tracker had recorded as submitted
    AND confirmed four days earlier. One number per tenant cannot express that, and keeping only the posting's
    figure would have hidden the rule the tenant actually enforces.
  * **A slug is a PATH SEGMENT, not a substring.** `ro` matched Anthropic, Robinhood and Roblox rows; the same
    containment test inside the cap counter would have counted another employer's applications against Ro's
    limit.

PURE FUNCTIONS. Every function takes what it needs: `today` is a parameter, so a window can be tested at all.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Union

from tracker_index import SUBMITTED_STATUSES

#: What `tenant_skip_names` accepts: a Path or the string form `src/paths.py` prints.
PathLike = Union[str, Path]

#: Kinds the caps file may declare. `count` and `same_role_cooldown` are counts inside a window; `active` and
#: `one_at_a_time` are states — the tenant may hold one application open at a time — so every prior submission
#: counts however old it is. The same is true of a counting kind whose `window_days` is 0.
KINDS = ("count", "active", "one_at_a_time", "same_role_cooldown")
WINDOWED_KINDS = ("count", "same_role_cooldown")

#: A `same_role_cooldown` IS COUNTED BOARD-WIDE, and this is a known, accepted limitation rather than the
#: intent. Cognition's form says "we limit applications to one per role every 3 months", and with three
#: board-wide submissions on record the preflight blocked a role that had never been applied to. The `kind`
#: was corrected here; the counting was not, because matching a cooldown per role needs the role title passed
#: in, which nothing does yet. Until then EXPECT a per-role cooldown to behave like a board cap - the block
#: was accepted rather than bypassed, deliberately: a false block costs one application, a duplicate costs
#: the candidate's credibility. Choose another employer for now.


def norm_slug(slug: str | None) -> str:
    """Comparison form for a board slug: alphanumerics only, lower-cased.

    Deliberately this loose, because two spellings of one board have to meet: the caps file spelled a tenant
    `Applied Intuition` while the ATS spells its board `applied`, and an entry written with a space or a hyphen
    can never equal a slug parsed out of a URL. That entry's one-application-at-a-time limit never fired once.
    """
    return re.sub(r"[^a-z0-9]+", "", (slug or "").lower())


def tenant_skip_names(path: PathLike) -> set[str]:
    """The tenants `data/tenant_policies.json` records with `policy: skip`, in comparison form.

    A SKIP IS A FACT ABOUT AN EMPLOYER, so it is configuration and the file is the single definition of it.
    `scan_registry_fresh.py` used to carry its own literal set under a comment asking the next reader to keep
    it in step, and the set had drifted: five tenants recorded as `skip` were missing from it, so their roles
    were still reported as fresh candidates. Reading the file is the fix; keeping two lists agreeing is not.

    Each name is returned both ways round, because the scanner compares against a lowercased company name
    OR a board slug and the two do not have to be spelled alike: `Babel Street` is a display name while the
    board it is reached on is `babelstreet`, so a set holding only one of the two spellings would skip
    whichever form it does not hold. A missing or unreadable file means nothing is skipped - the scan still
    runs, which is how it behaved before the set existed, and the tracker already hides the employers applied to.

    Takes the path as an argument like everything else here, so a caller can point it at a fixture.
    """
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8")).get("tenants") or []
    except Exception:  # noqa: BLE001 -- a scan without policies is degraded, not broken
        return set()
    wanted: set[str] = set()
    for entry in entries:
        if (entry.get("policy") or "").strip() != "skip":
            continue
        name = (entry.get("tenant") or "").strip().lower()
        if name:
            wanted.add(name)
            # Both the display spelling and the slug spelling, for the reason in the docstring above.
            wanted.add(norm_slug(name))
    return wanted


def board_slug_of(source: str | None) -> str | None:
    """Return the BOARD SLUG a tracker source URL belongs to, or None if it cannot be determined.

    Added 2026-10-05. The tenant-saturation count used to test `slug in source_url`, which is wrong for short
    slugs: Ro's "ro" matched 84 submissions belonging to Anthropic, Robinhood, Roblox and a dozen others, and
    hard-stopped a round at the >=20 cap for a tenant with one prior application. A slug is a PATH SEGMENT, not
    a substring, so this reads it from where each ATS puts it and returns None rather than guessing.
    """
    s = (source or "").strip().lower()
    if not s:
        return None
    s = s.split("#")[0]

    # Greenhouse: /<slug>/<job id>, or the embed form's ?for=<slug>
    if "greenhouse.io" in s:
        m = re.search(r"for=([a-z0-9._-]+)", s)
        if m:
            return m.group(1).replace("-", "")
        m = re.search(r"greenhouse\.io/([a-z0-9._-]+)/", s)
        if m and m.group(1) not in ("embed", "boards"):
            return m.group(1).replace("-", "")
        return None

    # Lever: jobs.lever.co/<slug>/<uuid>  or  api.lever.co/v0/postings/<slug>/<uuid>
    if "lever.co" in s:
        m = re.search(r"lever\.co/(?:v0/postings/)?([a-z0-9._-]+)/", s)
        if m and m.group(1) not in ("v0", "postings"):
            return m.group(1).replace("-", "")
        return None

    # Ashby: jobs.ashbyhq.com/<slug>/<uuid>
    if "ashbyhq.com" in s:
        m = re.search(r"ashbyhq\.com/([a-z0-9._-]+)", s)
        return m.group(1).replace("-", "") if m else None

    # Workday and everything else: first path segment of the URL, or the leftmost host label.
    m = re.search(r"^https?://([a-z0-9._-]+)", s)
    host = m.group(1) if m else ""
    if "myworkdayjobs.com" in host:
        return host.split(".")[0].replace("-", "")
    rest = re.sub(r"^https?://[^/]+", "", s)
    seg = [p for p in rest.split("/") if p]
    if seg:
        return seg[0].replace("-", "")
    return host.split(".")[0].replace("-", "") if host else None


def board_matches(slug: str | None, source: str | None) -> bool:
    """Is this tracker row's URL on the given board? False when either side is unreadable, never a guess."""
    wanted = norm_slug(slug)
    return bool(wanted) and board_slug_of(source) == wanted


def row_is_on_board(row: dict, slug: str | None) -> bool:
    """Does this tracker row belong to the board?

    By the URL first, because that is the board's own name for itself. Then by the tracker's COMPANY name,
    because some rows carry a URL no board can be read out of: `careers.roblox.com/jobs/8072244` yields the
    segment `jobs`, and `apply.careers.microsoft.com/careers/job/...` yields `careers`, so Roblox's
    5-per-30-days limit counted one submission fewer than the tracker holds (2026-10-09). Under-counting is the
    direction that matters: it lets a capped board take one more application.

    The company comparison is EXACT after normalisation, never a containment test - `Ro` must not be found
    inside `Robinhood`, which is how the same mistake was made once already.
    """
    wanted = norm_slug(slug)
    if not wanted:
        return False
    return board_matches(wanted, row.get("source")) or norm_slug(row.get("company")) == wanted


def rules_of(entry: dict) -> list[dict]:
    """Every limit one caps-file entry states: the recorded one, then any the tenant states elsewhere.

    `also_stated` exists because of Coinbase 2026-10-09: its posting says 3 per 6 months and its own mail says
    4 per 30 days. Both are enforced — see `blocking_rule` — so a board is refused when ANY stated limit is
    reached, which is the only safe reading of two rules that disagree.
    """
    rules = [{
        "cap": entry.get("cap"),
        "window_days": entry.get("window_days", 0),
        "kind": entry.get("kind", "count"),
        "source": entry.get("source", ""),
        "note": entry.get("note", ""),
    }]
    for extra in entry.get("also_stated") or []:
        rules.append({
            "cap": extra.get("cap"),
            "window_days": extra.get("window_days", 0),
            "kind": extra.get("kind", entry.get("kind", "count")),
            "source": extra.get("source", ""),
            "note": extra.get("note", entry.get("note", "")),
        })
    return rules


@dataclass(frozen=True)
class RuleCheck:
    """One stated limit, weighed against the tracker. Frozen: a verdict is data, not a hook for later state."""
    slug: str
    cap: int
    window_days: int
    kind: str
    used: int
    undated: int = 0
    source: str = ""
    note: str = ""

    @property
    def reached(self) -> bool:
        return bool(self.cap) and self.used >= self.cap

    def describe(self) -> str:
        extra = f" ({self.undated} of them without a readable date)" if self.undated else ""
        return (f"{self.slug} allows {self.cap} ({self.kind}, window {self.window_days}d); "
                f"{self.used} used{extra}")


def count_used(rows: list[dict], slug: str, kind: str, window_days: int, today: dt.date) -> tuple[int, int]:
    """How many submissions this board already has, and how many of them carry no readable date.

    Only rows whose STATUS is a submission count: a row recorded but never sent (`not_applied`,
    `filled_for_review`) is not an application, and counting it would lock out a requisition that is still open.
    """
    used = undated = 0
    for row in rows:
        if (row.get("status") or "").strip() not in SUBMITTED_STATUSES:
            continue
        if not row_is_on_board(row, slug):
            continue
        if kind in WINDOWED_KINDS and window_days:
            raw = (row.get("date_added") or "")[:10]
            try:
                when = dt.date.fromisoformat(raw)
            except ValueError:
                # AN UNREADABLE DATE COUNTS. Skipping the row would turn a malformed cell into a free
                # application against a board that has already refused one, and the cell is ours to fix.
                used += 1
                undated += 1
                continue
            if (today - when).days <= window_days:
                used += 1
        else:
            used += 1
    return used, undated


def check_board(rows: list[dict], caps: list[dict], slug: str,
                today: dt.date) -> list[RuleCheck]:
    """Every limit recorded for this board, weighed. Empty when the board has no recorded limit."""
    checks: list[RuleCheck] = []
    wanted = norm_slug(slug)
    if not wanted:
        return checks
    for entry in caps:
        if norm_slug(entry.get("slug")) != wanted:
            continue
        for rule in rules_of(entry):
            kind = rule["kind"] or "count"
            window_days = int(rule["window_days"] or 0)
            used, undated = count_used(rows, wanted, kind, window_days, today)
            checks.append(RuleCheck(
                slug=wanted,
                cap=int(rule["cap"] or 0),
                window_days=window_days,
                kind=kind,
                used=used,
                undated=undated,
                source=rule["source"] or entry.get("source", ""),
                note=rule["note"] or entry.get("note", ""),
            ))
    return checks


def blocking_rule(rows: list[dict], caps: list[dict], slug: str, today: dt.date) -> RuleCheck | None:
    """The first stated limit this board has already reached, or None when every one still allows another."""
    return next((check for check in check_board(rows, caps, slug, today) if check.reached), None)
