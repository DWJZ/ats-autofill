#!/usr/bin/env python3
"""Read the ledger back: how many times each application was attempted, and why it stuck.

WHAT THIS HAS THAT NOTHING ELSE DOES
------------------------------------
The tracker records an outcome and a paragraph of prose. The session log records that *something*
happened. Only the ledger records, at the moment it happened: **how many submit attempts there were**
and **what each refusal said**.

Usage:  .venv/bin/python3 src/metrics/ledger_report.py [--ledger PATH] [--top N]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import statistics
from collections import defaultdict
from dataclasses import dataclass, field

import ledger  # the event vocabulary and the legacy-outcome list live in one place

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_LEDGER = ROOT / "output" / "metrics" / "ledger.jsonl"

# One line per class, for the report's handover table. The vocabulary itself lives in `ledger.py` so the
# two writers, the CLI's `--class` choices and this rendering cannot drift apart.
HANDOVER_MEANING = {
    "captcha": "an image challenge the drivers cannot solve",
    "login": "a password, 2FA or expired third-party session",
    "email_code": "a code sent to a mailbox that cannot be read",
    "user_content": "only the user can author it",
    "no_truthful_option": "a required control the honest answer is refused by",
    "tooling_gap": "a control the settled tools cannot drive",
    "platform_blocked": "the tenant refuses: an impossible error, a spam flag",
    "duplicate": "already applied to this requisition",
    "other": "unclassified",
}


@dataclass
class Application:
    """One application's events, in order."""

    key: str
    events: list[dict] = field(default_factory=list)

    @property
    def slug(self) -> str:
        return next((e["slug"] for e in self.events if e.get("slug")), "")

    @property
    def url(self) -> str:
        return next((e["url"] for e in self.events if e.get("url")), "")

    @property
    def company(self) -> str:
        return next((e["company"] for e in self.events if e.get("company")), "")

    @property
    def title(self) -> str:
        return next((e["title"] for e in self.events if e.get("title")), "")

    @property
    def platform(self) -> str:
        return next((e["platform"] for e in self.events if e.get("platform")), "")

    @property
    def attempts(self) -> int:
        return sum(1 for e in self.events if e["event"] == "submit")

    @property
    def refusals(self) -> list[str]:
        out = []
        for e in self.events:
            if e["event"] == "submit" and e.get("outcome") != "confirmed":
                detail = e.get("detail") or {}
                # `errors` is what the form said; `tail` is where these ATSs put a refusal. The page HEAD
                # is the job description, so it is never used as a reason — an unconfirmed submit with no
                # error text says only that, which is the truth.
                reason = detail.get("errors") or detail.get("tail") or detail.get("reason")
                out.append(f"{e['outcome']}: {str(reason)[:160]}" if reason else str(e["outcome"]))
            elif e["event"] == "handover":
                detail = e.get("detail") or {}
                if e.get("outcome") in ledger.LEGACY_HANDOVER_OUTCOMES:
                    continue  # a gate refusal is a block, not a handover; see handover_classes
                reason = detail.get("reason") or detail.get("failures") or detail
                out.append(f"{e.get('outcome')}: {str(reason)[:160]}")
        return out

    @property
    def handover_classes(self) -> list[str]:
        return [e.get("outcome") or "other" for e in self.events if self._is_handover(e)]

    @property
    def blocks(self) -> list[str]:
        """Passes at submitting that were stopped before the click — retries, not handovers."""
        return [str((e.get("detail") or {}).get("failures") or e.get("outcome") or "")[:160]
                for e in self.events if self._is_block(e)]

    @staticmethod
    def _is_handover(event: dict) -> bool:
        """A handover stops the application for the user. Legacy rows recorded gate refusals here; see
        `ledger.LEGACY_HANDOVER_OUTCOMES` — the data showed five of the first six went on to submit."""
        if event["event"] != "handover":
            return False
        return event.get("outcome") not in ledger.LEGACY_HANDOVER_OUTCOMES

    @staticmethod
    def _is_block(event: dict) -> bool:
        if event["event"] == "blocked":
            return True
        return event["event"] == "handover" and event.get("outcome") in ledger.LEGACY_HANDOVER_OUTCOMES

    @property
    def status(self) -> str:
        for e in reversed(self.events):
            if e["event"] == "closed":
                return e.get("outcome") or "?"
        if self.refusals:
            return "stuck"
        return "in progress"

    @property
    def first_at(self) -> int:
        return self.events[0]["at"]

    @property
    def last_at(self) -> int:
        return self.events[-1]["at"]


def load(path: pathlib.Path = DEFAULT_LEDGER) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue  # the ledger is appended live; a half-written last line is expected
    return rows


def group(rows: list[dict]) -> list[Application]:
    """One Application per real application, by unioning the events that share an identifier.

    No single field identifies an application across the whole ledger: `prepare` and `submit` carry the
    slug, `record-status` does not, and `submit` records the *page* URL (`…/<id>/application`) while the
    rest record the job URL. Keying on `slug or url` therefore split every application in two and counted
    each half separately. Unioning on "shares a slug OR shares a url" links them: prepare↔submit by slug,
    prepare↔closed by url, and so all three."""
    parent: dict[int, int] = {index: index for index in range(len(rows))}

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    by_slug: dict[str, int] = {}
    by_url: dict[str, int] = {}
    for index, row in enumerate(rows):
        for field, seen in (("slug", by_slug), ("url", by_url)):
            value = (row.get(field) or "").rstrip("/")
            if not value:
                continue
            if value in seen:
                union(seen[value], index)
            else:
                seen[value] = index

    groups: dict[int, Application] = {}
    for index, row in enumerate(rows):
        root = find(index)
        key = row.get("slug") or row.get("url") or "?"
        groups.setdefault(root, Application(key=key)).events.append(row)
    for app in groups.values():
        app.events.sort(key=lambda e: e["at"])
    return sorted(groups.values(), key=lambda a: a.first_at)


def spread(values: list[float]) -> str:
    if not values:
        return "-"
    ordered = sorted(values)
    return "%.0f / %.0f / %.0f" % (ordered[len(ordered) // 10], statistics.median(ordered),
                                   ordered[len(ordered) * 9 // 10])


def report(rows: list[dict], apps: list[Application], top: int) -> str:
    out: list[str] = []
    out.append("# Application ledger\n")
    out.append("Every line is written as the event happens: the pipeline at prepare / record-status, and each")
    out.append("submit path at the moment it knows the verdict.")
    out.append("")
    out.append("(`preflight` is the one historical name in that vocabulary: the subcommand that wrote it was")
    out.append("removed on 2026-10-06, and seven such events survive in older ledgers, which is why the name is")
    out.append("still defined in `ledger.py`.)\n")

    if not rows:
        out.append("The ledger is empty — nothing has been instrumented into it yet.\n")
        return "\n".join(out)

    out.append("## What is in it\n")
    out.append(f"- events: **{len(rows)}** across **{len(apps)}** applications")
    kinds: dict[str, int] = defaultdict(int)
    for row in rows:
        kinds[row["event"]] += 1
    out.append("- " + ", ".join(f"`{k}` {v}" for k, v in sorted(kinds.items())))

    stuck = [a for a in apps if a.refusals]
    out.append(f"\n## Attempts and blockers\n")
    out.append(f"- applications with at least one refusal: **{len(stuck)}** of {len(apps)}")
    out.append(f"- applications with more than one submit attempt: "
               f"**{sum(1 for a in apps if a.attempts > 1)}**")
    out.append(f"- submit attempts: p10/median/p90 = {spread([float(a.attempts) for a in apps])}")
    if stuck:
        out.append("\n| application | attempts | what the refusal said |")
        out.append("|---|---|---|")
        for app in sorted(stuck, key=lambda a: -a.attempts)[:top]:
            out.append("| %s | %d | %s |" % ((app.company or app.key)[:28], app.attempts,
                                             app.refusals[0].replace("|", "/")[:120]))

    handovers = [a for a in apps if a.handover_classes]
    if handovers:
        classes: dict[str, int] = defaultdict(int)
        for app in handovers:
            for name in app.handover_classes:
                classes[name] += 1
        out.append("\n### Where applications stopped — the handover classes\n")
        out.append("Every handover here was declared by the agent, through")
        out.append("`run_application_pipeline.command handover` — including the classes that were meant to be")
        out.append("detected automatically, which never fired.\n")
        out.append("| class | applications | what it means |")
        out.append("|---|---|---|")
        for name, count in sorted(classes.items(), key=lambda kv: -kv[1]):
            out.append("| `%s` | %d | %s |" % (name, count, HANDOVER_MEANING.get(name, "")))
        out.append(f"\n{len(handovers)} of {len(apps)} applications ended in a handover.")

    blocked = [a for a in apps if a.blocks]
    if blocked:
        out.append("\n### Passes at submitting that were stopped before the click\n")
        out.append("A `blocked` event is not a handover: the pre-submit gate refused, and the agent normally")
        out.append("corrects the form and retries. Counting these as handovers overstated the first run's")
        out.append("handover rate threefold — five of the first six went on to submit.\n")
        out.append("| application | blocked | what the gate refused on |")
        out.append("|---|---|---|")
        for app in sorted(blocked, key=lambda a: -len(a.blocks))[:top]:
            out.append("| %s | %d | %s |" % ((app.company or app.key)[:28], len(app.blocks),
                                             app.blocks[0].replace("|", "/")[:110]))

    out.append("\n## Recent applications\n")
    out.append("| when | application | platform | events | attempts | status |")
    out.append("|---|---|---|---|---|---|")
    for app in apps[-top:][::-1]:
        when = dt.datetime.fromtimestamp(app.last_at / 1000).strftime("%m-%d %H:%M")
        out.append("| %s | %s | %s | %d | %d | %s |" % (
            when, (app.company or app.key)[:26], app.platform or "?", len(app.events), app.attempts,
            app.status))
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args(argv)

    rows = load(pathlib.Path(args.ledger))
    apps = group(rows)
    print(report(rows, apps, args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
