#!/usr/bin/env python3
"""check_configuration.py — which of four states the data directory is in, and what is still the example.

WHY THIS EXISTS. `AGENTS.md` opens by telling an agent that the configuration shipped here describes a
fictional person, and to stop and ask for the facts before filling anything. That instruction was prose with
nothing behind it: an agent could not ASK whether this checkout was configured, so it had to compare the data
directory against `examples/` by eye and decide for itself. The realistic state is not the two the prose names
either — it is HALF WAY THROUGH: two files replaced with a real person's facts and three still holding the
example's, where the example's `work_authorization: Yes` answers a question the person never answered. Nothing
in `src/` distinguished "the examples are installed" from "the directory does not exist" from "these are
somebody's own facts", and the failure of getting it wrong is silent: a form filled with `Example Candidate`
of Springfield, submitted under a real person's name.

WHAT IT PRINTS, AND WHAT IT MUST NEVER PRINT. It reports which FILES still hold the example's values, and the
PATHS inside them where an example value survived — never a value, in either direction. The output is read by
a model and by a person mid-bootstrap, and the one thing it may not do is put the facts it is complaining
about back in front of them in a form that reads like an answer. A path like `candidate.location` says "this
is still the example's"; `Springfield, Illinois, USA` would be a value, and the check never prints one.

THE FOUR STATES

  absent      nothing has been set up: the data directory does not exist, or holds none of these files.
  example     the files are installed and untouched — every one of them is byte-for-byte its shipped example.
  partial     the realistic half-way state: some files are the person's own and some are not (still the
              example, still holding example values, or missing).
  configured  every file this toolkit reads for a fact about the person exists and none of them is the
              example's. Only this one is usable.

EXIT STATUS: 0 for `configured`, 1 for everything else, so `npm test`-style automation can branch on it. The
first line of the output is `state: <one of the four>`, which is the same answer for a caller that would
rather read than branch.

HOW IT DECIDES — three signals, because no single one is enough:

  1. BYTE IDENTITY with the shipped example. Certain, and it is what says "untouched": an agent that has
     replaced nothing is in the state the contract calls "stop and ask".
  2. THE IDENTITY PATHS — a short list per canonical profile of the values that name or contact the person
     (`candidate.name`, `candidate.phone.formatted`, `work_experience.0.company`, `resume.summary`, …). Each
     one is checked against the example's value at the same path. This is what catches the file that was
     EDITED but not replaced — one field changed, everything else still the example's — which byte identity
     cannot see and which is how a half-finished bootstrap looks. Every path is asserted to exist in the
     example by `test_check_configuration.py`, so a rename in `examples/` fails loudly instead of silently
     checking nothing.
  3. THE EXAMPLE'S OWN PLACEHOLDER MARKERS. Every invented value in `examples/` is labelled as one — the
     word "Example" (`Example Candidate`, `candidate@example.edu`), an `<angle bracketed>` instruction, or
     `示例姓名`. Where the person's file still carries a marked value at the same path, the file is still
     partly the example's. Reader-facing prose keys (`note`, `comment`, `rule`, …) are excluded: they are
     printed for whoever edits the file and are never written into a form field.

  WHAT IT CANNOT SEE, stated here rather than discovered later: an example value that carries no marker and
  is not on the identity list — the example's `gpa: "0.0"`, or a date shaped `MM/YYYY`. Those are invisible
  to signal 3 by construction, and the check errs toward "not configured" wherever it has to guess, never
  toward "configured". A false `partial` costs one question; a false `configured` puts a stranger's name on
  a real application.

  AND WHAT IT DOES NOT ASK AT ALL: it reads the PROVENANCE of the configuration, not its completeness. A
  file that is somebody's own and half empty is `own` here and fails later, inside the pipeline, with the
  pipeline's own message — which is why `test_bootstrap_end_to_end.py` does not stop at this check: it runs
  `prepare` and the drafter against a bootstrapped directory. "Are these facts mine" and "is every key
  present" are two questions, and this tool answers only the first.

WHAT IS NOT BLOCKING, AND WHY. Five files decide the state (see `blocks=` in the table): the two canonical
profiles, the two answer tables and the tracker. The rest are reported but do not hold the checkout
unusable — `screening/sources.json` ships as a starting registry of real boards, the cover-letter template is
wording whose every fact is a `{{placeholder}}` filled from the profiles, the master DOCX contributes a page
setup and three named styles and nothing else, and the tenant caps and policies are facts about employers
rather than about the person. A file that cannot put a false statement about the person on a form must not be
able to block the bootstrap.

Usage:
  .venv/bin/python3 src/tools/check_configuration.py                  # the data directory as configured
  .venv/bin/python3 src/tools/check_configuration.py --data-dir DIR   # anywhere else, e.g. a bootstrap
  .venv/bin/python3 src/tools/check_configuration.py --data-dir DIR --quiet   # the state line only

`--data-dir` exists because `src/paths.py` reads `ATS_DATA_DIR` ONCE at import time, so a caller that has to
compare several directories in one process - a test, or an agent walking a bootstrap - cannot use the
environment for it. A test that pointed `ATS_DATA_DIR` at one directory and asserted about another would be
the kind of check that passes for the wrong reason.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import re
import sys
from typing import Any, NamedTuple

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

EXAMPLES_DIR = ROOT / "examples"


class ConfigFile(NamedTuple):
    """One file this toolkit reads, and the example it ships as.

    `blocks` is whether an untouched copy makes the checkout unusable — see the module docstring for the
    rule, which is "could a form be filled from it with a statement about the person that is false".
    `holds` is what the person has to be asked for; it is printed as the next question to ask, because
    mapping the facts onto the files is the other half of what this check is for.
    """

    dest: str
    example: str
    blocks: bool
    holds: str


#: THE ONE TABLE. `scripts/setup-examples.sh` copies the same example->destination pairs and
#: `configure.py` writes them; the shell script is checked against this list by
#: `test_check_configuration.py`, so a file added to one and not the other is a failing test rather than a
#: bootstrap that silently installs nine files and reports ten.
FILES: tuple[ConfigFile, ...] = (
    ConfigFile("candidate_profile.json", "candidate_profile.example.json", True,
               "identity and contact, the standard answers every form asks (work authorisation, "
               "sponsorship, consent, demographics), `do_not_claim`, and the compensation rule"),
    ConfigFile("application_profile.json", "application_profile.example.json", True,
               "address and phone, education, work history with the resume bullets, and the resume summary"),
    ConfigFile("form_specs/answer_rules.json", "answer_rules.example.json", True,
               "wordings that recur, answered once each with a note naming where the answer comes from"),
    ConfigFile("form_specs/ashby_pairs_standing.json", "ashby_pairs_standing.example.json", True,
               "the standing answers to questions that recur on Ashby forms"),
    ConfigFile("applications.csv", "tracker.example.csv", True,
               "the record of what has been applied to — the shipped rows are invented, and one of them "
               "claims a submission"),
    ConfigFile("screening/sources.json", "daily_sources.example.json", False,
               "the boards you track, and the words that describe your field"),
    ConfigFile("cover_letter/template.txt", "cover_letter_template.example.txt", False,
               "the letter's sentences; every fact in them is a {{placeholder}} filled from the profiles"),
    ConfigFile("tenant_policies.json", "tenant_policies.example.json", False,
               "what individual employers will and will not do"),
    ConfigFile("form_specs/tenant_caps.json", "tenant_caps.example.json", False,
               "the application caps per board, read before a form is opened"),
    ConfigFile("resume_templates/Example_Candidate_Backend_Resume.docx", "resume_template.example.docx", False,
               "the master resume layout the renderer patches (its body text is discarded)"),
)

#: The per-application template, which `setup-examples.sh` deliberately does NOT install: a role profile is
#: a judgement about one posting and there is no "the" one. `configure.py` writes them under this prefix
#: from this example, so the file the check never requires is still the file the bootstrap can produce.
PER_APPLICATION_PREFIX = "resume_profiles/"
PER_APPLICATION_EXAMPLE = "resume_profile.example.json"

#: The values that name or contact the person, per canonical profile. Checked against the example's value at
#: the same path; a path missing from either file is "not the example's", which is what deleting a key does.
#: Kept to facts a person essentially never shares with the invented one - a state or a country is left out
#: on purpose, because "Springfield, Illinois" is also somebody's real answer and a check that is wrong in
#: that direction on purpose is better than one whose every `partial` is a false alarm.
IDENTITY_PATHS: dict[str, tuple[str, ...]] = {
    "candidate_profile.json": (
        "candidate.name",
        "candidate.email",
        "candidate.location",
        "candidate.current_education",
        "candidate.previous_education",
        "candidate.linkedin",
        "candidate.citizenship",
    ),
    "application_profile.json": (
        "candidate.name",
        "candidate.first_name",
        "candidate.last_name",
        "candidate.email",
        "candidate.phone.formatted",
        "candidate.address.address_line_1",
        "education.0.school",
        "work_experience.0.company",
        "resume.summary",
    ),
}

#: A key whose value is written for whoever edits the file - advice, a provenance note, a rule about how an
#: answer is chosen - and is never written into a form field. The substring forms are safe because no key
#: that holds a fact about a person has "note", "comment" or "readme" in its name; the exact forms are where
#: substring matching would be wrong (`rules` holds answers and must NOT be excluded by `rule`).
PROSE_KEYS_EXACT = frozenset({
    "rule", "why", "_why", "fields", "_fields", "see_also", "_see_also", "required", "_required",
    "optional", "_optional", "positioning", "detail", "evidence", "reason", "use_for", "strategy",
})
PROSE_KEY_PARTS = ("note", "comment", "readme")

#: How the shipped examples label an invented value. `_EDU`/`example.invalid` are covered by "example".
MARKER = re.compile(r"example|<[^>]*>|示例", re.IGNORECASE)

#: A value that names a FILE rather than a fact about a person. The installed master DOCX is named after the
#: example person and legitimately stays - `resume_tracks.*.template_docx` and `candidate.base_resume_docx`
#: are paths to a document the renderer opens, not claims about anyone.
PATH_LIKE = re.compile(r"\.(docx|doc|pdf|md|json|txt|csv|png|jpe?g|gif|zip|html?|xlsx?)$", re.IGNORECASE)

#: `partial` and `example` are the same thing said twice: `example` is every file untouched, `partial` is
#: some. `absent` is nothing at all - a directory that does not exist, or one that holds none of the files.
ABSENT, EXAMPLE, PARTIAL, CONFIGURED = "absent", "example", "partial", "configured"


def example_path(example: str, examples_dir: pathlib.Path | None = None) -> pathlib.Path:
    """Where one shipped example lives. A parameter rather than a constant so a test can point the check at
    a fabricated `examples/` tree, and so both CLI tools resolve it in exactly one place."""
    return (examples_dir or EXAMPLES_DIR) / example


def example_for(dest: str) -> str | None:
    """The example a destination is built from, or None when this toolkit reads no such file.

    ONE ANSWER, TWO CALLERS: `configure.py` refuses a destination this returns None for (its answers file may
    only name files the toolkit reads), and the check's table is what the destinations came from.
    """
    for spec in FILES:
        if spec.dest == dest:
            return spec.example
    if dest.startswith(PER_APPLICATION_PREFIX) and dest.endswith(".json"):
        return PER_APPLICATION_EXAMPLE
    return None


def _leaves(value: Any, path: tuple[Any, ...] = ()) -> list[tuple[tuple[Any, ...], Any]]:
    """Every scalar in a JSON document, with the path that reaches it."""
    if isinstance(value, dict):
        out: list[tuple[tuple[Any, ...], Any]] = []
        for key, item in value.items():
            out.extend(_leaves(item, path + (str(key),)))
        return out
    if isinstance(value, list):
        out = []
        for index, item in enumerate(value):
            out.extend(_leaves(item, path + (index,)))
        return out
    return [(path, value)]


def spell(path: tuple[Any, ...]) -> str:
    """`('education', 0, 'school')` -> `education.0.school`, the form IDENTITY_PATHS is written in."""
    return ".".join(str(part) for part in path)


def is_prose(path: tuple[Any, ...]) -> bool:
    """Is this leaf written for the reader of the file rather than for a form field?"""
    key = str(path[-1]) if path else ""
    if key in PROSE_KEYS_EXACT:
        return True
    return any(part in key.lower() for part in PROSE_KEY_PARTS)


def is_path_like(value: Any) -> bool:
    return isinstance(value, str) and bool(PATH_LIKE.search(value.strip()))


def is_marked(value: Any) -> bool:
    """Does the example label this value as invented?"""
    return isinstance(value, str) and bool(MARKER.search(value))


def load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def surviving_example_values(user_doc: Any, example_doc: Any) -> list[str]:
    """Paths where the person's file still carries an example value the example labelled as invented.

    Prose keys and file paths are skipped (see the two constants); everything else is compared leaf by leaf
    against the example, so a value that was replaced reads as replaced and a value that was not is named.
    """
    theirs = dict(_leaves(user_doc))
    out: list[str] = []
    for path, example_value in _leaves(example_doc):
        if is_prose(path) or is_path_like(example_value) or not is_marked(example_value):
            continue
        if path in theirs and theirs[path] == example_value:
            out.append(spell(path))
    return out


def surviving_identity_values(user_doc: Any, example_doc: Any, paths: tuple[str, ...]) -> list[str]:
    """The identity paths that still read exactly as the example does. Named, never quoted.

    BOTH SIDES ARE KEYED BY THE SPELLED PATH, and that is not a detail: `_leaves` yields tuples, so a table
    written as `candidate.name` compared against a dict keyed by `('candidate', 'name')` matches nothing and
    the whole signal goes quiet. It did, until `test_every_identity_path_is_load_bearing` reverted one value
    at a time in a configured profile and watched the state stay `configured`.
    """
    theirs = {spell(path): value for path, value in _leaves(user_doc)}
    by_path = {spell(path): value for path, value in _leaves(example_doc)}
    return [p for p in paths if p in theirs and by_path.get(p) == theirs[p]]


def surviving_tracker_rows(user_text: str, example_text: str) -> int:
    """How many rows of the shipped example tracker are still in this one, verbatim.

    Compared as whole rows rather than as cells: a row is the unit the tracker's own reader works in, and
    "an invented application is still in the tracker" is the fact that matters (one shipped row claims a
    submission, which is the one status that must never be re-applied to and does consume a cap slot).
    """
    def rows(text: str) -> list[dict]:
        return [dict(row) for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff")), delimiter=",")]

    try:
        example_rows = rows(example_text)
        user_rows = rows(user_text)
    except csv.Error:
        return 0
    return sum(1 for row in user_rows if row in example_rows)


class Verdict(NamedTuple):
    """What one file is, and the evidence for it - paths and counts, never values."""

    spec: ConfigFile
    state: str                  # missing | example | partly | own
    detail: tuple[str, ...]     # the paths (or a count) that are still the example's
    message: str                # one line, printed


#: How many paths are SHOWN for one file. A half-edited profile has forty of them, and forty paths in a
#: report that a model reads is noise that hides the file's own name; the count is what says how far from
#: done it is. The full list is what `Verdict.detail` holds, for a caller that wants to work on it.
SHOWN_PATHS = 8


def _summarise(paths: tuple[str, ...], limit: int = SHOWN_PATHS) -> str:
    if len(paths) <= limit:
        return ", ".join(paths)
    return ", ".join(paths[:limit]) + f", … (+{len(paths) - limit} more)"


def verdict_for(data_dir: pathlib.Path, spec: ConfigFile, examples_dir: pathlib.Path | None = None) -> Verdict:
    """Decide one file. Read-only; it never writes and never reports a value."""
    example = example_path(spec.example, examples_dir)
    target = data_dir / spec.dest
    if not target.is_file():
        return Verdict(spec, "missing", (), f"missing — {spec.example} is not installed here")
    if not example.is_file():
        return Verdict(spec, "missing", (), f"the repo has no {spec.example} to compare against")

    theirs = target.read_bytes()
    if theirs == example.read_bytes():
        return Verdict(spec, "example", (), f"untouched copy of examples/{spec.example}")

    if target.suffix == ".csv":
        survived = surviving_tracker_rows(theirs.decode("utf-8", "replace"),
                                          example.read_text(encoding="utf-8"))
        if survived:
            return Verdict(spec, "partly", (f"{survived} row(s)",),
                           f"{survived} invented row(s) of examples/{spec.example} are still in it")
        return Verdict(spec, "own", (), f"your own — differs from examples/{spec.example}")

    if target.suffix == ".json":
        try:
            user_doc, example_doc = json.loads(theirs), load_json(example)
        except json.JSONDecodeError as exc:
            return Verdict(spec, "partly", (), f"not readable as JSON ({exc.msg}, line {exc.lineno})")
        found = surviving_identity_values(user_doc, example_doc, IDENTITY_PATHS.get(spec.dest, ()))
        found += surviving_example_values(user_doc, example_doc)
        if found:
            # A path can be reported once by both signals; the order is the table's, so the report is stable
            # and a caller can diff two runs of it.
            unique = list(dict.fromkeys(found))
            return Verdict(spec, "partly", tuple(unique),
                           f"{len(unique)} example value(s) still present: {_summarise(tuple(unique))}")
        return Verdict(spec, "own", (), f"your own — differs from examples/{spec.example}")

    # A text file (the cover-letter wording) has no structure to compare, so a byte difference is all there
    # is to say. It is not blocking for exactly that reason: its facts are the profiles' placeholders.
    return Verdict(spec, "own", (), f"your own — differs from examples/{spec.example}")


def check_state(data_dir: pathlib.Path, examples_dir: pathlib.Path | None = None) -> tuple[str, list[Verdict]]:
    """The state of the data directory, and the verdict on every file. Pure: no printing, no exit."""
    verdicts = [verdict_for(data_dir, spec, examples_dir) for spec in FILES]
    present = [verdict for verdict in verdicts if verdict.state != "missing"]
    if not data_dir.is_dir() or not present:
        return ABSENT, verdicts
    blocking = [verdict for verdict in verdicts if verdict.spec.blocks]
    if all(verdict.state == "own" for verdict in blocking):
        return CONFIGURED, verdicts
    if all(verdict.state == "example" for verdict in verdicts):
        return EXAMPLE, verdicts
    return PARTIAL, verdicts


#: Directories `setup-examples.sh` creates and a run needs. Reported, never blocking: `prepare` errors on
#: the copy it cannot make, and naming them here is cheaper than that error.
DIRECTORIES: dict[str, str] = {
    "resume_profiles": "one role profile per application goes here",
    "resume_templates": "the master DOCX the renderer patches goes here",
}


def missing_directories(data_dir: pathlib.Path) -> list[str]:
    return [name for name in DIRECTORIES if not (data_dir / name).is_dir()]


def report_lines(data_dir: pathlib.Path, state: str, verdicts: list[Verdict], *,
                 examples_dir: pathlib.Path | None = None, quiet: bool = False) -> list[str]:
    """The report. Line 1 is `state: <state>`; every other line is a file, a path or a count."""
    width = max(len(spec.dest) for spec in FILES)
    lines = [f"state: {state}", f"data directory: {data_dir}"]
    if quiet:
        return lines[:1]
    lines.append(f"examples: {examples_dir or EXAMPLES_DIR}")
    lines.append("")
    if state == ABSENT:
        # Ten identical `missing` lines are noise: in this state there is nothing to report file by file,
        # and the interesting fact is that the directory holds none of them.
        lines.append(f"  none of the {len(FILES)} files this toolkit reads is present")
    else:
        for verdict in verdicts:
            lines.append(f"  {verdict.spec.dest:<{width}}  {verdict.state:<8} {verdict.message}")
    for name in missing_directories(data_dir):
        lines.append(f"  {name + '/':<{width}}  {'missing':<8} {DIRECTORIES[name]}")

    if state == CONFIGURED:
        lines += ["", "Configured: every file this toolkit reads for a fact about a person is the person's own,",
                  "so nothing has to be asked for before a form is filled. A line above still marked `example`",
                  "holds layout or generic wording rather than an answer — the master DOCX's page setup, a registry",
                  "kept as shipped — and cannot put a false statement about the person on a form."]
        return lines
    if state == ABSENT:
        lines += ["",
                  "Nothing has been set up. The examples are the schema, not facts about anyone:",
                  "    bash scripts/setup-examples.sh",
                  "then replace them — one answers file through `src/tools/configure.py` is the documented way."]
        return lines
    if state == EXAMPLE:
        lines += ["",
                  "The shipped examples are installed and untouched: they describe a fictional person, and every",
                  "value in them reads as an answer to a real employer. DO NOT FILL A FORM FROM THEM — ask the",
                  "person for the facts listed below."]
    else:
        lines += ["",
                  "Partly configured — the state a bootstrap is in half way through, and the one that is easy to",
                  "mistake for done. Do not fill a form from the files listed above as `example` or `partly`."]

    unfinished = [v for v in verdicts if v.spec.blocks and v.state != "own"]
    lines += ["", f"NOT USABLE: {len(unfinished)} file(s) that decide whether this checkout is usable are still "
                  f"the example's.",
              "Ask the person for the facts each one holds (docs/CONFIGURATION.md maps every file to what it holds):"]
    for verdict in unfinished:
        lines.append(f"  {verdict.spec.dest}: {verdict.spec.holds}")
        if verdict.detail:
            lines.append(f"      still the example's: {_summarise(verdict.detail, 12)}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report the configuration state of the data directory. Exit 0 only when it is "
                    "configured; the first output line is `state: absent|example|partial|configured`.")
    parser.add_argument("--data-dir", default=None,
                        help="the data directory to check (default: the ATS_DATA_DIR setting, src/paths.py)")
    parser.add_argument("--examples-dir", default=None, help="override the examples/ tree (tests only)")
    parser.add_argument("--quiet", action="store_true", help="print the state line only")
    args = parser.parse_args(argv)

    data_dir = pathlib.Path(args.data_dir).expanduser().resolve() if args.data_dir else DATA_DIR
    examples_dir = pathlib.Path(args.examples_dir).expanduser().resolve() if args.examples_dir else EXAMPLES_DIR
    state, verdicts = check_state(data_dir, examples_dir)
    print("\n".join(report_lines(data_dir, state, verdicts, examples_dir=examples_dir, quiet=args.quiet)))
    return 0 if state == CONFIGURED else 1


if __name__ == "__main__":
    sys.exit(main())
