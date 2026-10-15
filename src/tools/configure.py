#!/usr/bin/env python3
"""configure.py — write a person's answers into the data directory, one file at a time.

WHY THIS EXISTS. `scripts/setup-examples.sh` installs the examples, `AGENTS.md` says to stop and ask for the
facts, and `docs/CONFIGURATION.md` says which file holds which fact — but the step BETWEEN them, "an agent
writes the nine files correctly by hand", is the one nothing had ever verified. It is also the step most
likely to go wrong in a way nobody sees: a profile with the right name and the example's
`work_authorization: Yes` still passes every parse, and the false answer is only visible on a real employer's
form, under the applicant's own name. This tool takes the answers as ONE document, writes them into the
files the toolkit reads, and reports what it wrote — so the mapping from "what the person told me" to "which
key holds it" is done once, in code, and can be tested.

THE ANSWERS FILE. JSON, documented in `docs/CONFIGURATION.md` under "Bringing your own facts in":

    {
      "files": {
        "candidate_profile.json":   { ...answers, merged into the example... },
        "application_profile.json": { ... },
        "screening/sources.json":   { "filters": { "field_include": ["nurse"] } },
        "applications.csv":         { "rows": [] },
        "cover_letter/template.txt": "the whole letter, with {{placeholders}}",
        "resume_profiles/toronto_rn.json": { "company": "...", "role": "...", "source": "...", "summary": "..." }
      }
    }

  * A key is a path RELATIVE TO THE DATA DIRECTORY, and it must be one this toolkit reads: the ten files in
    `check_configuration.py`'s table, or `<something>.json` under `resume_profiles/` (the per-application
    template, from `examples/resume_profile.example.json`). An absolute path or a `..` is refused rather than
    resolved: this tool writes into one directory and nowhere else.
  * The skeleton is always the shipped example, so the shape of every file comes from `examples/` and cannot
    drift from it. Your answers are merged INTO it.
  * MERGE: objects merge key by key, lists and scalars replace wholesale, and a value of `null` DELETES the
    key. Deleting is how an example override that does not apply to you is removed (`"template_docx": null`,
    `"header_image": null`) — and it is the honest outcome, because a key that is not there leaves the
    question blank and reported rather than answered with something plausible.
  * `applications.csv` is a table, not a document: its answers are `{"rows": [...]}`, one object per row,
    keyed by the example's own column names. `{"rows": []}` is an empty tracker that still has its header.
  * The master resume DOCX is a binary file. Answers cannot write one; put your own there and name it in
    `resume_tracks.<track>.template_docx`.

NEVER OVERWRITE A REAL ANSWER — the rule this tool is built around. A destination is written only when it is
MISSING or still BYTE-FOR-BYTE the example it was copied from. A file that differs from its example is
somebody's own work — a hand-corrected profile, a tracker with a hundred rows in it — and it is reported as
`keep` and left untouched, with no flag to override that. `--dry-run` reports what would be written without
writing it.

WHAT IT DOES NOT DO. It does not invent a value, fill a gap, or tidy a file. If the answers do not cover a
value the example shipped, the example's value stays in the file and the tool says so, per file, at the end —
set it in the answers, or set it to `null` to delete the key. A file whose example value is still marked
"Example ..." is exactly what `check_configuration.py` reports as `partly`, and this tool exits non-zero for
the same reason: an incomplete bootstrap is not a configured checkout.

EXIT STATUS: 0 when the data directory is `configured` afterwards, 1 when it is not (including when a file
was refused), 2 for a usage or answers-file error. Usage:

  .venv/bin/python3 src/tools/configure.py answers.json [--data-dir DIR] [--dry-run]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)
from src.tools import check_configuration as cc  # noqa: E402  (the table and the state live there)


class Refused(SystemExit):
    """A message the caller has to read, rather than a traceback. Raised for anything an answers file can
    get wrong — a destination this toolkit does not read, a binary file, an unreadable document."""


def safe_destination(data_dir: pathlib.Path, dest: str) -> pathlib.Path:
    """The path to write, proven to be inside `data_dir`.

    A bootstrap tool that resolves whatever an answers file names is a tool that can be talked into writing
    outside the directory it was pointed at — and the whole design here is that a person's facts live in one
    directory that can be moved. Absolute paths and `..` are refused, not resolved.
    """
    if pathlib.PurePosixPath(dest).is_absolute() or dest.startswith("~"):
        raise Refused(f"REFUSED: `{dest}` is an absolute path. Destinations are relative to the data "
                      f"directory, which is {data_dir}.")
    try:
        resolved = (data_dir / dest).resolve()
    except (OSError, ValueError) as exc:      # a name the filesystem cannot even spell
        raise Refused(f"REFUSED: `{dest}` is not a usable path ({exc}).") from exc
    if resolved != data_dir.resolve() and data_dir.resolve() not in resolved.parents:
        raise Refused(f"REFUSED: `{dest}` resolves outside the data directory ({resolved}).")
    return resolved


def merge(example: Any, answers: Any) -> Any:
    """The example with the answers applied: objects merge, everything else replaces, `null` deletes."""
    if isinstance(example, dict) and isinstance(answers, dict):
        merged = dict(example)
        for key, value in answers.items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[key] = merge(merged.get(key), value)
        return merged
    return answers


def deleted_paths(example: Any, answers: Any, path: str = "") -> list[str]:
    """Paths the answers delete, so the report can name them — a deletion is a decision worth showing."""
    if not isinstance(answers, dict) or not isinstance(example, dict):
        return []
    out: list[str] = []
    for key, value in answers.items():
        here = f"{path}{key}"
        if value is None:
            if key in example:
                out.append(here)
        else:
            out.extend(deleted_paths(example.get(key), value, f"{here}."))
    return out


def render_json(example_path: pathlib.Path, answers: dict) -> tuple[str, list[str]]:
    """The text of a JSON destination, and the paths the answers deleted.

    An answer that is not an OBJECT is refused rather than written: every file this toolkit reads is a JSON
    object, and a list or a bare string is a shape the reader would fail on much later, in a tool that has
    no idea an answers file exists.
    """
    if not isinstance(answers, dict):
        raise Refused(f"the answers for {example_path.name} must be a JSON object — every configuration file "
                      f"here is one, and a {type(answers).__name__} would parse as a file of the wrong shape")
    example = json.loads(example_path.read_text(encoding="utf-8"))
    merged = merge(example, answers)
    return json.dumps(merged, indent=2, ensure_ascii=False) + "\n", deleted_paths(example, answers)


def render_csv(example_path: pathlib.Path, answers: Any) -> str:
    """The tracker, from `{"rows": [...]}`. The columns come from the example, so a row cannot invent one."""
    if not isinstance(answers, dict) or not isinstance(answers.get("rows"), list):
        raise Refused('an applications.csv answer must be {"rows": [...]} — see the docstring. Use '
                      '{"rows": []} for a tracker with its header and no applications yet.')
    header: list[str] = []
    for row in csv.reader(io.StringIO(example_path.read_text(encoding="utf-8-sig"))):
        header = row
        break
    unknown: set[str] = set()
    for row in answers["rows"]:
        if not isinstance(row, dict):
            raise Refused(f"every row must be an object of column: value; found {type(row).__name__}")
        unknown |= set(row) - set(header)
    if unknown:
        raise Refused(f"these columns are not in the example tracker's header: {sorted(unknown)} — "
                      f"the header is {header}")
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    for row in answers["rows"]:
        writer.writerow({column: row.get(column, "") for column in header})
    return buffer.getvalue()


def render_text(answers: Any) -> str:
    if not isinstance(answers, str):
        raise Refused("a text file's answer must be the file's whole content, as a string")
    return answers if answers.endswith("\n") else answers + "\n"


def render(example_path: pathlib.Path, answers: Any) -> tuple[bytes, list[str]]:
    """Bytes to write, plus any paths the answers deleted. The destination's suffix decides the shape."""
    suffix = example_path.suffix.lower()
    if suffix == ".json":
        text, deleted = render_json(example_path, answers)
        return text.encode("utf-8"), deleted
    if suffix == ".csv":
        return render_csv(example_path, answers).encode("utf-8-sig"), []
    if suffix in (".txt", ".md"):
        return render_text(answers).encode("utf-8"), []
    raise Refused(f"cannot write {example_path.name} from answers: it is not JSON, CSV or text. A binary "
                  f"file (the master resume DOCX) is yours to supply — put it there yourself.")


def configure(data_dir: pathlib.Path, answers_doc: dict, *, dry_run: bool = False) -> tuple[list[str], int]:
    """Write every file the answers name. Returns (report lines, exit code)."""
    if not isinstance(answers_doc, dict) or not isinstance(answers_doc.get("files"), dict):
        raise Refused('the answers file must be an object with a "files" object — {"files": {...}}')
    files: dict[str, Any] = answers_doc["files"]
    if not files:
        raise Refused('the answers file names no files: "files" is empty, so there is nothing to configure')

    lines = [f"data directory: {data_dir}", f"answers file: {len(files)} file(s)"]
    if dry_run:
        lines.append("DRY RUN: nothing is written.")
    lines.append("")

    # SORTED BY THE TABLE'S ORDER, not by the answers file's: a bootstrap is read top to bottom, and the two
    # canonical profiles coming first is what makes that reading make sense.
    order = {spec.dest: index for index, spec in enumerate(cc.FILES)}
    written = 0
    for dest in sorted(files, key=lambda d: (order.get(d, len(order)), d)):
        example_name = cc.example_for(dest)
        if example_name is None:
            raise Refused(f"REFUSED: this toolkit reads no file at `{dest}`. Destinations are the ten in "
                          f"src/tools/check_configuration.py, or `<name>.json` under "
                          f"{cc.PER_APPLICATION_PREFIX.rstrip('/')}/.")
        example_path = cc.example_path(example_name)
        if not example_path.is_file():
            raise Refused(f"the repo has no examples/{example_name}, so `{dest}` has no skeleton to build on")
        target = safe_destination(data_dir, dest)

        if target.is_file() and target.read_bytes() != example_path.read_bytes():
            lines.append(f"  keep   {dest:<46} already yours (not the example) — NOT overwritten")
            continue

        payload, deleted = render(example_path, files[dest])
        if target.is_file() and target.read_bytes() == payload:
            lines.append(f"  same   {dest:<46} the answers reproduce the file it already is")
            continue
        if dry_run:
            lines.append(f"  would  {dest:<46} from examples/{example_name}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        written += 1
        lines.append(f"  wrote  {dest:<46} from examples/{example_name}")
        if deleted:
            lines.append(f"         deleted keys: {', '.join(deleted)}")

    lines += ["", f"wrote {written} file(s)" + (" (a dry run writes nothing)" if dry_run else "")]
    if dry_run:
        # A dry run does not predict the state, and says so rather than guessing: the state is read from the
        # files, and no file changed. Running it for real is safe — the refusal rule above is what makes that
        # true — so the dry run is for reading the plan, not for deciding whether to apply it.
        state, _ = cc.check_state(data_dir, cc.EXAMPLES_DIR)
        lines += ["", f"the data directory is still `{state}`: a dry run changes nothing."]
        return lines, 0

    state, verdicts = cc.check_state(data_dir, cc.EXAMPLES_DIR)
    lines += ["", *cc.report_lines(data_dir, state, verdicts)]
    return lines, (0 if state == cc.CONFIGURED else 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Write a person's answers into the data directory, one file at a time. Never "
                    "overwrites a file that is not still its shipped example.")
    parser.add_argument("answers", help="the answers JSON — see this module's docstring for its shape")
    parser.add_argument("--data-dir", default=None,
                        help="the data directory to write into (default: the ATS_DATA_DIR setting, src/paths.py)")
    parser.add_argument("--dry-run", action="store_true", help="report what would be written; write nothing")
    args = parser.parse_args(argv)

    data_dir = pathlib.Path(args.data_dir).expanduser().resolve() if args.data_dir else DATA_DIR
    try:
        answers_doc = json.loads(pathlib.Path(args.answers).read_text(encoding="utf-8"))
        lines, status = configure(data_dir, answers_doc, dry_run=args.dry_run)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read the answers file {args.answers}: {exc}", file=sys.stderr)
        return 2
    except Refused as exc:
        print(exc, file=sys.stderr)
        return 2
    print("\n".join(lines))
    return status


if __name__ == "__main__":
    sys.exit(main())
