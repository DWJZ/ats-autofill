#!/usr/bin/env python3
"""Append-only ledger of what happened to each application, written as it happens.

WHY A LEDGER
------------
Two of the numbers the tracker cannot answer — how many times a submit was attempted, and why it was
refused — exist nowhere machine-readable: the tracker's `notes` is prose (median 1,370 characters) and
the session log only shows that *some* `record-status` ran. A line written at the moment of the event is
the only reliable source.

WHAT IT MUST NEVER DO
---------------------
Break a submission. `record()` swallows every exception and returns None on failure, because telemetry
that can fail a submit is worse than no telemetry. It writes one line and never edits or rewrites.

WHERE IT GOES
-------------
`output/metrics/ledger.jsonl`, under the gitignored part of `output/`: this is high-churn telemetry, not
a record to version. The tracker stays the durable record of what was submitted.

Usage:  from ledger import record
        record("submit", slug=slug, url=url, outcome="refused", detail={"reason": text})
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEDGER = ROOT / "output" / "metrics" / "ledger.jsonl"

# Event names. Kept short and stable: the report groups by them.
# `PREFLIGHT` IS HISTORICAL, AND STAYS DEFINED FOR THAT REASON. The `preflight` subcommand that wrote it was
# removed on 2026-10-06 (see the note in `application_pipeline.main()`), so nothing emits this event any more and
# nothing should be written to start emitting it. It is kept because the ledger is append-only: seven `preflight`
# lines survive in older ledgers, `_ledger.mjs` mirrors this list and a test pins the two together, and dropping
# the name here would leave a reader of those lines with a name the vocabulary does not admit to knowing.
PREFLIGHT = "preflight"      # historical: the pre-form check, removed 2026-10-06
PREPARE = "prepare"          # tailoring rendered: profile, pages, QA verdict
SUBMIT = "submit"            # one attempt at pressing Submit, with the verdict
CLOSED = "closed"            # the tracker row was recorded; this closes the application
HANDOVER = "handover"        # stopped and left for the user, with the reason
BLOCKED = "blocked"          # a pass at submitting was stopped BEFORE the click, and why

# `verify_and_submit.mjs` recorded its gate refusals as `handover` until 2026-10-03. They are not
# handovers: of the first six, five went on to submit successfully once the form was corrected, so they
# are retries inside the submit flow. The ledger is append-only (and another session may be appending to
# it right now), so the report reclassifies those legacy lines instead of rewriting history.
LEGACY_HANDOVER_OUTCOMES = ("gate_failed",)

# Why a handover happened. Every class must be declared by the caller through
# `run_application_pipeline.command handover`, because a handover nothing records is a blocker nobody
# can count. The three that were meant to be raised automatically lived in a module nothing called, so
# they never fired once. A test asserts this tuple, `_ledger.mjs` and the handover reference agree — a
# class the report does not know is a class nobody sees.
HANDOVER_CLASSES = (
    "captcha",            # an image challenge the drivers cannot solve
    "login",              # a password, 2FA or expired third-party session the saved profile cannot satisfy
    "email_code",         # a code sent to a mailbox that cannot be read
    "user_content",       # only the user can author it: an anecdote, a video, a signature
    "no_truthful_option", # a required control whose honest answer the form will not accept
    "tooling_gap",        # a control the settled tools cannot drive
    "platform_blocked",   # the tenant itself refuses: an impossible error, a spam flag
    "duplicate",          # already applied to this requisition
    "other",
)


def record(event: str, path: pathlib.Path | None = None, **fields) -> dict | None:
    """Append one event. Returns the line it wrote, or None if anything went wrong.

    Never raises: a caller is usually mid-application, and a telemetry failure must not become a
    submission failure. `path` defaults to `LEDGER` at call time, so a test can redirect it."""
    try:
        path = path or LEDGER
        line = {
            "at": int(dt.datetime.now().timestamp() * 1000),
            "event": event,
            **{k: v for k, v in fields.items() if v is not None},
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        return line
    except Exception:  # noqa: BLE001 -- deliberately total: see the module docstring
        return None
