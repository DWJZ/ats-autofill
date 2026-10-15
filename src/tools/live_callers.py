#!/usr/bin/env python3
"""live_callers.py — decide whether a script under src/ still has a REAL caller.

WHY THIS EXISTS. Four times in one session a `grep -rn "<name>"` was read as "this file is live-reachable", and
four times that was wrong:

  1. `verify_and_submit.mjs:146` mentions click_radio_plan.mjs inside a `//` comment that says the *next* call
     could use it. No call was ever made.
  2. `click_radio_plan.mjs:6` mentions read_radio_groups.mjs in its docstring.
  3. `read_radio_groups.mjs:4` mentions read_options_by_id.mjs in its docstring.
  4. Searching for `ashby_location` ALSO matches `ashby_location_keys`, which is the one that is actually called.
     A substring hit read as evidence of a caller for a file that had none.

So this tool answers the question directly instead of leaving it to a grep:
  * comment and docstring lines are excluded, by classifying each LINE rather than each match;
  * the file name must appear as a quoted path in a call argument position, not merely somewhere on a line;
  * matching is on whole file names, so `ashby_location` cannot be satisfied by `ashby_location_keys`.

A NOTE ON data/scratch/ CALLERS. That directory is full of one-off scripts from a single round, dead the moment their
application was recorded, so a caller found there is WEAK evidence: answer_by_checkbox was reported as called by
base_blur.mjs and binf_submit.mjs, both 2026-10-03 one-offs, which is why deleting it broke nothing. Treat a src/
caller as strong and a data/scratch/ caller as a question to answer.

AND THE SCRATCH ROOT IS USER-SUPPLIED, which is the other half of that caveat. Whatever orchestrates a round from
there is a file the USER writes; none ships, and on a fresh checkout the directory is not there at all, so
everything that only such a driver invoked is reported as uncalled. The answer
is therefore only ever as complete as the roots it was given: this scans `src/` and `<data>/scratch/`, and a tool
driven from anywhere else (a session's own bash line, a script outside both) is invisible to it.

WHAT THIS DOES NOT ANSWER. It reports whether another SCRIPT invokes a file. Most of this toolbox is invoked
by the agent directly from a bash call, which appears nowhere in src/ - so "NO MENTION AT ALL" means "no script calls
it", NOT "it is dead". open_form, dedupe_tabs and the Greenhouse code-typers all read that way while being used
regularly. The evidence for those is the session log's own invocation counts, and that evidence is NOT in this
repository: this paragraph used to cite `docs/SCRIPT_CONSOLIDATION_AUDIT.md`, a document that does not exist here
(`docs/` holds `CONFIGURATION.md` and `RULES.md` and nothing else). Use this tool to rule liveness IN (a real caller
is proof) and never to rule it OUT.

USAGE
  .venv/bin/python3 src/tools/live_callers.py                 # every script under src/forms
  .venv/bin/python3 src/tools/live_callers.py <name> [...]    # just these
It is read-only: it opens files, prints a table, writes nothing.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

# A call, not a mention: the name as a QUOTED string, inside a call's argument list or as a shell-style command.
# `run([...])`, `spawnSync("node", [...])`, `subprocess.run([...])`, or `execSync("node src/forms/x.mjs")`.
# The placeholder is substituted per target by `call_patterns()` — v1 left the literal `%s` in the regex, so it
# searched every line for the characters "%%s", matched nothing, and reported "REAL CALLERS (0)" as though that
# were a finding. A tool built to stop wrong conclusions produced one; the substitution is now tested.
CALL_TEMPLATES = [
    r'\b(?:run|runSync|spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*\[[^\]]*?["\'][^"\']*{NAME}["\']',
    r'\b(?:run|runSync|spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["\'][^"\']*{NAME}',
    r'\b(?:subprocess\.)?(?:run|check_output|check_call|Popen)\s*\(\s*\[[^\]]*?["\'][^"\']*{NAME}["\']',
]


def call_patterns(name: str) -> list[re.Pattern]:
    """Compile the call patterns for one file name. Whole-name matching, so `ashby_location.mjs` is not satisfied
    by `ashby_location_keys.mjs` — the substring mistake that made a live file look uncalled and an uncalled file
    look live."""
    return [re.compile(t.format(NAME=re.escape(name))) for t in CALL_TEMPLATES]
# A line that IS a comment or a docstring body, whichever language. Classifying the line is what makes this
# reliable: an invocation never starts with `//`, `*`, `#`, or `"""`.
COMMENT_LINE = re.compile(r"^\s*(?://|/\*|\*|#|''')")


def source_lines(path: Path) -> list[tuple[int, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [(i, line) for i, line in enumerate(text.splitlines(), 1)]


def callers_of(target: str, sources: dict[Path, list[tuple[int, str]]]) -> list[str]:
    """Every `file:line` where `target` is invoked for real. `target` is a file name, matched exactly."""
    hits: list[str] = []
    for path, lines in sources.items():
        if path.name == target:
            continue
        for num, line in lines:
            if COMMENT_LINE.match(line):
                continue
            if target not in line:
                continue
            # Whole-name match only: `ashby_location.mjs` must not be satisfied by `ashby_location_keys.mjs`.
            if not re.search(r"(?<![\w.-])" + re.escape(target) + r"(?![\w.-])", line):
                continue
            for pattern in call_patterns(target):
                if pattern.search(line):
                    hits.append(f"{path.relative_to(ROOT)}:{num}")
                    break
    return hits


def mention_only(target: str, sources: dict[Path, list[tuple[int, str]]]) -> list[str]:
    """Every `file:line` that names it in a comment or docstring - i.e. NOT evidence of a caller."""
    hits: list[str] = []
    for path, lines in sources.items():
        if path.name == target:
            continue
        for num, line in lines:
            if not COMMENT_LINE.match(line) or target not in line:
                continue
            if re.search(r"(?<![\w.-])" + re.escape(target) + r"(?![\w.-])", line):
                hits.append(f"{path.relative_to(ROOT)}:{num}")
    return hits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report which src/ scripts still have a real caller.")
    parser.add_argument("names", nargs="*", help="script file names; default is every .mjs under src/forms")
    parser.add_argument("--all", action="store_true", help="also list the comment-only mentions")
    args = parser.parse_args(argv)

    sources: dict[Path, list[tuple[int, str]]] = {}
    # src/ AND data/scratch/: whatever orchestrates a round is a user-written file in the scratch area - none is
    # shipped and the directory may not exist - so scanning only src/ is exactly the blind spot that made v1 report
    # the whole tree as uncalled. The scratch directory is part of the configured data directory, so it is asked for
    # rather than assumed to be `ROOT/data/scratch`. Neither root is exhaustive: see the docstring.
    seen: set[pathlib.Path] = set()
    for base in (ROOT / "src", DATA_DIR / "scratch"):
        if not base.is_dir():
            continue
        for pattern in ("*.mjs", "*.py", "*.command", "*.sh"):
            for path in base.rglob(pattern):
                if "__pycache__" in path.parts or path in seen or "node_modules" in path.parts:
                    continue
                seen.add(path)
                sources[path] = source_lines(path)

    targets = args.names or sorted(p.name for p in (ROOT / "src" / "forms").glob("*.mjs"))
    live, comment_only, silent = [], [], []
    for name in targets:
        real = callers_of(name, sources)
        if real:
            live.append((name, real))
            continue
        notes = mention_only(name, sources)
        (comment_only if notes else silent).append((name, notes))

    print(f"REAL CALLERS ({len(live)}) — safe to keep, deleting breaks a caller")
    for name, hits in live:
        print(f"  {name:34s} {', '.join(hits[:3])}")
    print()
    print(f"COMMENT-ONLY MENTIONS ({len(comment_only)}) — looks used, is not")
    for name, hits in comment_only:
        print(f"  {name:34s} {', '.join(hits[:3])}")
    print()
    print(f"NO MENTION AT ALL ({len(silent)}) — reported, NOT judged dead: no SCRIPT in the scanned roots calls")
    print("  these, which is also what an agent-driven tool looks like. Rule liveness IN with this tool, never OUT.")
    for name, _ in silent:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
