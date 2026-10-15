#!/usr/bin/env python3
"""check_no_focus_steal.py - report scripts that really steal the user's focus.

USER RULE (2026-10-04): "注意填写时不要抢我的焦点". Filling a form must never pull the browser window to the front
or switch the user's active tab. Playwright's `locator.click()` and `page.keyboard` are dispatched over CDP to the
page's own session and need only DOM focus, so nothing here requires the window to be focused.

`page.bringToFront()` is the one call that does steal it, and `page.focus()` on a Frame is the other. A plain grep
is not enough, because several files mention the call in a COMMENT explaining that they avoid it - so this checker
strips comments before looking, and reports the line number, the file and the actual code.

Usage:
  .venv/bin/python3 src/tools/check_no_focus_steal.py            # report only
  .venv/bin/python3 src/tools/check_no_focus_steal.py --strict   # exit 1 if any real call exists
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

# `tmp/` is included deliberately: a one-off script written there is just as capable of stealing focus, and
# the 2026-10-04 violation happened through a script the checker never saw. THE STANDING BLIND SPOT: an inline
# `node -e "..."` command never touches disk, so NO static checker can see it. Browser work must therefore be
# written to a file (tmp/ or src/forms) and run from there, never typed inline - and reading console output has
# a settled path now: `node src/forms/cdp_tabs.mjs console <url> --grep <prefix>`, which opens a BACKGROUND tab
# via Target.createTarget { background: true } and closes it again.
# `data/scratch/` is part of the configured data directory (`ATS_DATA_DIR`, see `src/paths.py`) - one-off
# drivers that CAN steal focus live there - so it is asked for rather than spelled `ROOT/data/scratch`, and
# scanned wherever the setting points. The other three are directories of this checkout, not configuration.
ROOTS = ("src/forms", "src/autofill", "tmp", str(DATA_DIR / "scratch"))
PATTERNS = (
    (re.compile(r"\.bringToFront\s*\("), "bringToFront() pulls the tab to the front"),
    (re.compile(r"\bpage\.focus\s*\("), "page.focus() focuses the page's frame"),
    # A NEW PAGE BECOMES THE ACTIVE TAB. This is the one that actually took the user's focus: an inline
    # `context.newPage()` used to verify a posting made itself the front tab. The settled way to open a tab is
    # src/forms/cdp_tabs.mjs, which calls Target.createTarget with background: true and never activates it.
    (re.compile(r"\.newPage\s*\("), "newPage() activates a new tab - use src/forms/cdp_tabs.mjs instead"),
    # `Target.createTarget` is sent as a CDP METHOD NAME - `session.send("Target.createTarget", {background: true})`
    # - and never called with parentheses. The old pattern required a "(" and therefore matched nothing at all,
    # which is the quietest kind of broken check: it reported a clean tree for years of not looking. The sites
    # that use it correctly carry an exemption saying so.
)


# A TEST THAT DRIVES A PRIVATE HEADLESS BROWSER CANNOT TAKE THE USER'S FOCUS: no window is ever shown.
# The rule is about the user's browser, so those calls are exempt - but only with this marker ON THE
# LINE ITSELF, so the reason travels with the call and cannot be sprinkled over a file.
EXEMPT = re.compile(r"focus-ok\s*:")

# `Target.createTarget` is NOT a violation: it is the settled way to open a tab, and it is correct
# exactly when the statement passes `background`. Reporting it unconditionally produced 16 findings,
# every one of them a call that already passed `background: true` - and a guard that cries wolf on
# sixteen innocent lines is a guard nobody runs, which is the state this one was in. The argument is
# checked instead of the call, across the statement the line begins.
CREATE_TARGET = re.compile(r"[\"']Target\.createTarget[\"']")
BACKGROUND = re.compile(r"background\s*:")


def strip_comments(text: str) -> str:
    """Remove comments WITHOUT guessing at string boundaries.

    An earlier version also blanked backtick/quote-delimited strings and multi-line /* */ runs. On a real file that
    swallowed executable code along with a comment, so `src/forms/cdp_fill_driver.mjs:146` - a genuine
    `context.newPage()` - was reported as clean. A false negative is the dangerous direction for this check, so the
    stripper now does the least it can: drop /* */ blocks and whole lines that are comments. A mention inside a string
    literal will be reported, and that is the acceptable failure mode - it gets whitelisted explicitly rather than
    silently missed.
    """
    # Blank the block but KEEP ITS LINE COUNT: collapsing it to one space shifted every line after it,
    # so the reported line number pointed at innocent code instead of the call.
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    kept = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
            kept.append("")
        else:
            # trailing line comments only, which cannot contain a quote boundary problem
            kept.append(re.sub(r"(?<![:\"'`])//.*$", "", line))
    return "\n".join(kept)


def main() -> None:
    strict = "--strict" in sys.argv
    hits: list[tuple[str, int, str]] = []
    scanned = 0
    for root in ROOTS:
        base = pathlib.Path(root)
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.mjs")):
            scanned += 1
            raw = path.read_text(errors="ignore")
            code = strip_comments(raw)
            raw_lines = raw.splitlines()
            scanned_lines = code.splitlines()
            for i, line in enumerate(scanned_lines, 1):
                raw_line = raw_lines[i - 1] if i <= len(raw_lines) else ""
                for pat, why in PATTERNS:
                    if pat.search(line) and not EXEMPT.search(raw_line):
                        hits.append((str(path), i, why))
                if CREATE_TARGET.search(line) and not EXEMPT.search(raw_line):
                    statement = "\n".join(scanned_lines[i - 1:i + 2])
                    if not BACKGROUND.search(statement):
                        hits.append((str(path), i,
                                     "createTarget without `background:` activates the tab"))

    print(f"scanned {scanned} script(s) under {', '.join(ROOTS)}")
    if not hits:
        print("no focus-stealing calls found")
        return
    print(f"{len(hits)} focus-stealing call(s):")
    for path, line, why in hits:
        print(f"  {path}:{line} - {why}")
    if strict:
        print("\nThe user asked that filling never take their focus. Replace the call with a locator click or a DOM")
        print("focus() on the element itself: both are dispatched to the page's own session over CDP.")
        sys.exit(1)


if __name__ == "__main__":
    main()
