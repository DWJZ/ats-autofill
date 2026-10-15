#!/usr/bin/env python3
"""run_contract_fixtures.py - lay the contract fixture set down, and take it away again.

CALLED BY `scripts/run-contract-tests.sh`, WHICH OWNS THE GUARD. This script is the mechanical half: it
writes the fabricated configuration where the suite reads it and asserts that the fixture set really carries
what the suite compares against.

NOTHING IS INSTALLED INSIDE THE REPOSITORY ANY MORE, AND THAT IS THE POINT. Configuration is read from
`DATA_DIR` - the single definition of the `ATS_DATA_DIR` setting, in `src/paths.py` - and that directory is
normally a temporary one outside the repository, so the fixture configuration is written THERE, the
repository's own `data/` is never read, never written and never moved, and the machinery that used to
snapshot and restore a real user's answers (whose failure mode was a destroyed application history) is gone.
`install` refuses to write into a checkout's own `data/` for the same reason, from the other side: that
directory is where a real person's identity, work history and visa answers live, and a fixture that
overwrote it would be a false statement waiting to be filled into a real application.

WHAT USED TO BE THE EXCEPTION, AND WHY IT IS GONE. The per-ATS reference files were skill material rather
than configuration - the code resolved them from `skills/<skill>/references/`, which `ATS_DATA_DIR` did not
cover - so they alone were copied into the checkout and removed again on every exit path. That mechanism is
deleted with the files: the knowledge those files held is asserted by tests now, and a test needs no
directory inside the repository to live in. Nothing this script writes can be left behind in the tree.

USAGE (from `scripts/run-contract-tests.sh`, which sets `ATS_DATA_DIR` first):
  python3 scripts/run_contract_fixtures.py install        # configuration -> $ATS_DATA_DIR
  python3 scripts/run_contract_fixtures.py check          # assert the installed fixture set is usable
  python3 scripts/run_contract_fixtures.py --self-test    # exercise the install in a temporary directory
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import io
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "contract"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

#: The configuration half of the fixture set, as paths INSIDE the data directory. The fixture tree keeps
#: each of them under `tests/fixtures/contract/data/<the same path>`, so installing one is a copy and no
#: path has to be written out twice.
DATA_FIXTURES = (
    "tracker/fresh.csv",
    "tracker/bulk.csv",
    "form_specs/tenant_caps.json",
    "form_specs/answer_rules.json",
    "tenant_policies.json",
    "resume_profiles/atoms_software_engineer_new_grad.json",
    "resume_profiles/twitch_software_engineer_i_memberships.json",
    "scratch/preflight_role.py",
)

#: The suite refuses to run on an empty caps file and skips on a tracker that is too small, so both
#: counts are checked at install time rather than left to show up as a skip.
LEARNED_BOARDS = ("roblox", "coinbase", "applied", "oneapp")
TRACKER_FLOOR = 1001        # `resolved + unknown` must reach this for the scale check to run
UNKNOWN_CEILING = 40        # and the unrecognised-host count must stay under this

#: The tracker is ONE file to the suite and two halves in the fixture set: the dated rows that make
#: the tenant caps fire, then the bulk half that gives the tracker its scale. The header is taken
#: from the first half and skipped in the rest.
TRACKER_HALVES = ("tracker/fresh.csv", "tracker/bulk.csv")
TRACKER_OUT = "applications.csv"


def fail(message: str) -> int:
    print(f"REFUSING TO RUN: {message}", file=sys.stderr)
    return 1


def install(data_dir: pathlib.Path = DATA_DIR) -> int:
    """Write the fixture configuration into `data_dir`."""
    if data_dir == ROOT / "data":
        return fail(
            "the data directory is this checkout's own `data/`, which is where a real user's answers live - "
            "identity, work history, visa answers and the record of every application sent. The fixture set "
            "is not installed there: run the suite through `scripts/run-contract-tests.sh`, which points "
            "ATS_DATA_DIR at a temporary directory, or set ATS_DATA_DIR yourself")

    for rel in DATA_FIXTURES:
        source, destination = FIXTURES / "data" / rel, data_dir / rel
        if not source.is_file():
            return fail(f"the fixture {source.relative_to(FIXTURES)} is missing from {FIXTURES}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    # The two tracker halves become one file, in order: the dated rows that carry the tenant caps
    # first, then the bulk scale half. It is written WITH a UTF-8 BOM because the fixture half of
    # the suite pins the BOM being handled - `src/screening/test_tracker_index.py` asserts both that
    # a plain utf-8 read breaks on this file and that the shared reader strips it - and the header
    # line is written as plain ASCII so the first column key is `date_added` and not `\ufeffdate_added`.
    parts = [(data_dir / rel).read_text(encoding="utf-8-sig").splitlines() for rel in TRACKER_HALVES]
    combined = [parts[0][0]] + [line for part in parts for line in part[1:]]
    (data_dir / TRACKER_OUT).write_bytes(b"\xef\xbb\xbf" + ("\n".join(combined) + "\n").encode("utf-8"))

    # THE MASTER RESUME DOCX, GENERATED RATHER THAN COMMITTED. The resume pipeline is template-driven and
    # stops with "Master resume template not found" when there is none - which is the normal state of a
    # fresh checkout, and the reason `make_master_resume.py` exists. Without it the assertions about a
    # rendered resume have no subject, and which ones those are is not obvious: they pass when the suite
    # is run against a checkout where `setup-examples.sh` has been followed by that command, and error
    # only under this fixture set. A binary in `tests/fixtures/` would be one more thing to keep in step;
    # this is three lines and cannot drift.
    try:
        sys.path.insert(0, str(ROOT))
        from src.pipeline import build_resume  # noqa: PLC0415 -- after the path insert, on purpose
        from src.pipeline.make_master_resume import make_master  # noqa: PLC0415
        template = data_dir / "resume_templates" / build_resume.TEMPLATE.name
        template.parent.mkdir(parents=True, exist_ok=True)
        make_master("Example Candidate").save(template)
    except Exception as error:  # noqa: BLE001 -- a fixture that cannot be built is a failure, not a crash
        return fail(f"could not write the master resume DOCX the resume assertions need: {error}")

    # The contract check reads the installed files through the very modules the suite uses, and those resolve
    # `DATA_DIR` themselves (`src/paths.py`), so it is meaningful only for the real installation - a throwaway
    # copy made by `--self-test` is verified by looking at the files it wrote, not by asking the suite's
    # readers, which are pointed at the configured directory by construction.
    if data_dir == DATA_DIR:
        problems = check()
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        if problems:
            return fail("the installed fixture set does not satisfy the contract")
    return 0


def check() -> list[str]:
    """The properties the installed fixture set must have, asserted rather than assumed.

    Reads the installed files through the same modules the suite uses, so it checks the plumbing and the
    fixture at once: `tracker_index.TRACKER` resolving into the CONFIGURED data directory is itself part of
    what has to hold, and a fixture that installed correctly while the reader looked somewhere else would
    show up here rather than as a hundred failures.

    Called at the END of this script's `install`, which is BEFORE the shell script fills in the
    example configuration around the fixtures - so the files `scripts/setup-examples.sh` provides
    are checked by that script, and by the two guards in `run-contract-tests.sh` that read the
    installed tracker and answer-rule table back. What is checked here is what THIS set owns.
    """
    problems: list[str] = []

    try:
        caps = json.loads((DATA_DIR / "form_specs" / "tenant_caps.json").read_text(encoding="utf-8"))["caps"]
    except Exception as exc:  # noqa: BLE001
        return problems + [f"the caps fixture cannot be parsed: {exc}"]
    slugs = {entry.get("slug") for entry in caps}
    absent = [slug for slug in LEARNED_BOARDS if slug not in slugs]
    if absent:
        problems.append(f"the caps fixture does not record {', '.join(absent)}")

    sys.path.insert(0, str(ROOT / "src" / "screening"))
    sys.path.insert(0, str(ROOT / "src" / "pipeline"))
    try:
        import application_pipeline as pipeline
        import tracker_index
        import tenant_caps
    except Exception as exc:  # noqa: BLE001
        return problems + [f"the screening modules cannot be imported: {exc}"]

    installed = DATA_DIR / TRACKER_OUT
    if tracker_index.TRACKER != installed:
        return problems + [
            f"the shared tracker reader resolves {tracker_index.TRACKER}, not the installed {installed}: "
            "the suite would read a different file from the one this install wrote"]

    rows = tracker_index.load_rows()
    resolved = unknown = 0
    for row in rows:
        url = (row.get("source") or "").strip()
        if not url:
            continue
        if pipeline.detect_platform(url, "auto") == "unsupported":
            unknown += 1
        else:
            resolved += 1
    if resolved + unknown < TRACKER_FLOOR:
        problems.append(
            f"the tracker fixture holds {resolved + unknown} url(s); the scale check it exists for "
            f"compares a recognised-host count against a floor of {TRACKER_FLOOR}")
    if unknown >= UNKNOWN_CEILING:
        problems.append(
            f"the tracker fixture holds {unknown} unrecognised host(s); that check allows fewer "
            f"than {UNKNOWN_CEILING}")

    # A cap entry whose slug can never reach a tracker row is a cap that never fires - the failure
    # two of these very entries were written for. The suite asserts it as well; asserting it here
    # means the copy is checked before a run rather than after a failure.
    orphans = [entry["slug"] for entry in caps
               if not any(tenant_caps.row_is_on_board(row, entry["slug"]) for row in rows)]
    if orphans:
        problems.append(f"these caps match no tracker row, so they can never fire: {', '.join(orphans)}")

    # And the counting itself, at TODAY, because that is the date the driven entry point uses. The
    # fixture's rows are dated; a fixture that installs cleanly and can no longer block the board it
    # is about is worse than no fixture, and this is where that shows up as a refusal instead.
    today = dt.date.today()
    for slug in LEARNED_BOARDS:
        if tenant_caps.blocking_rule(rows, caps, slug, today) is None:
            problems.append(
                f"the {slug} cap does not fire against the tracker fixture at {today.isoformat()}: "
                "the fixture's dated rows need moving forward")

    print(f"installed: {resolved} recognised host(s), {unknown} unrecognised, {len(rows)} tracker "
          f"row(s), {len(caps)} cap entr(y/ies) into {DATA_DIR}")
    return problems


def self_test() -> int:
    """Install a throwaway copy, and prove the install cannot reach anything that is not the fixture set.

    The point is the property the real run depends on: that `install` puts the fixture files where the suite
    looks (a temporary data directory, NOT the repository's `data/`), and that nothing it does lands inside
    the checkout - there is no removal step any more, because there is nothing of the run's to remove from
    the tree. The shipped `SKILL.md` is written here as the thing that must survive an install untouched.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        shipped = root / "skills" / "submitting-an-application" / "SKILL.md"
        shipped.parent.mkdir(parents=True)
        shipped.write_text("shipped documentation\n", encoding="utf-8")
        data_dir = root / "data-dir"
        # What the checkout looked like before the install, so "it wrote nothing into the tree" is a fact
        # read off the tree rather than a promise about the code.
        before = sorted(path_.relative_to(root).as_posix() for path_ in root.rglob("*"))

        status = install(data_dir=data_dir)
        if status != 0:
            return status
        for rel in ("applications.csv", "form_specs/tenant_caps.json", "tenant_policies.json",
                    "resume_templates"):
            if not (data_dir / rel).exists():
                print(f"FAIL: install did not write {rel} into the configured data directory", file=sys.stderr)
                return 1
        if (root / "data").exists():
            print("FAIL: install wrote into a checkout's own data/", file=sys.stderr)
            return 1

        after = sorted(path_.relative_to(root).as_posix() for path_ in root.rglob("*"))
        added = [name for name in after if name not in before and not name.startswith("data-dir")]
        if added:
            print(f"FAIL: install wrote {added} into the checkout - it must touch nothing in the tree",
                  file=sys.stderr)
            return 1
        if not shipped.is_file():
            print("FAIL: install deleted the shipped SKILL.md", file=sys.stderr)
            return 1

        # The refusal below is the expected one, so its message is captured rather than printed: a self-test
        # that shouts "REFUSING TO RUN" in the middle of a passing run teaches the reader to ignore the line.
        with contextlib.redirect_stderr(io.StringIO()):
            refused = install(data_dir=ROOT / "data")
        if refused == 0:
            print("FAIL: install wrote into a checkout's own data/ when asked to", file=sys.stderr)
            return 1

    print("self-test: the fixture set installs into the configured data directory and nowhere else, and "
          "nothing it writes lands inside the checkout")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the contract fixture set.")
    parser.add_argument("action", nargs="?", choices=("install", "check"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.action == "install":
        return install()
    if args.action == "check":
        problems = check()
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
