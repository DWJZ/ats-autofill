#!/usr/bin/env python3
"""preflight_role.py - may this requisition be applied to, BEFORE any material is written?

THIS COPY IS A CONTRACT FIXTURE, NOT A WORKING ENTRY POINT. It lives in
`tests/fixtures/contract/data/scratch/` and `scripts/run-contract-tests.sh` installs it at
`<data directory>/scratch/preflight_role.py` for the duration of one test run, then removes it again -
the data directory being the temporary one `ATS_DATA_DIR` points at, not the checkout's own `data/`.

WHY IT EXISTS. `src/screening/test_tenant_caps.py::ThePreflightEntryPointRefusesTheBoard` drives
this script as a caller does and asserts three things about the CALLER - that a capped board is
refused with a non-zero exit status, that a board whose cap used to be keyed by company name is
refused now, and that an uncapped board is still cleared. `tenant_caps.py` has its own tests for
the counting; this fixture is what checks that the entry point reaches them and reports what they
say.

IT IMPORTS THE REAL COUNTER, deliberately. The fixture does not re-implement `blocking_rule`, so a
divergence between what this script reports and what `src/screening/tenant_caps.py` decides is
impossible by construction rather than by review.

Exit code 0 means the requisition is not recorded and tailoring may proceed; 1 means STOP.

USAGE
  .venv/bin/python3 data/scratch/preflight_role.py --ats greenhouse --slug example-board --job-id 1234567
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import json
import pathlib
import sys

def _find_repo(anchor: pathlib.Path) -> pathlib.Path | None:
    """The checkout that contains a `package.json`, looking up from `anchor`."""
    for candidate in (anchor, *anchor.parents):
        if (candidate / "package.json").is_file():
            return candidate
    return None


# THIS FILE IS NO LONGER NECESSARILY INSIDE THE CHECKOUT IT CHECKS. The data directory is a setting
# (`ATS_DATA_DIR`, single definition in `src/paths.py`), and `scripts/run-contract-tests.sh` installs this
# fixture into a temporary one OUTSIDE the repository - so walking up from this file finds no checkout, and
# the script must be anchored the way its caller runs it: from the checkout it drives. `parents[1]` below is
# still this file's own data directory, in-tree or not, which is what makes the two work together.
ROOT = _find_repo(pathlib.Path(__file__).resolve().parent) or _find_repo(pathlib.Path.cwd().resolve())
assert ROOT is not None, "preflight_role.py is not inside the repository it is meant to check"

DATA_DIR = pathlib.Path(__file__).resolve().parents[1]
CSV = DATA_DIR / "applications.csv"
CAPS = DATA_DIR / "form_specs" / "tenant_caps.json"

# The kinds the caps file may declare. Kept here as a constant so the split below reads the way the
# counter does; `src/screening/tenant_caps.py` is the module that owns the counting itself.
KINDS = ("count", "active", "one_at_a_time", "same_role_cooldown")


def load_tenant_caps():
    """Import the cap checker from its real home, so the rule applied here is the rule that has tests."""
    screening = ROOT / "src" / "screening"
    if str(screening) not in sys.path:
        sys.path.insert(0, str(screening))
    spec = importlib.util.spec_from_file_location("tenant_caps", screening / "tenant_caps.py")
    module = importlib.util.module_from_spec(spec)
    # REGISTER IT BEFORE EXECUTING: a module loaded by path is not in sys.modules, and `@dataclass`
    # resolves its own annotations through sys.modules[cls.__module__], so the import raised
    # AttributeError instead of returning a checker.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_rows() -> list[dict]:
    """The tracker, BOM handled. `utf-8-sig` is load-bearing: a plain utf-8 read makes the first
    column key `\\ufeffdate_added` and the first row raises KeyError."""
    if not CSV.is_file():
        return []
    with CSV.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser(description="Refuse a requisition that is recorded or capped.")
    parser.add_argument("--ats", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--title", default="")
    args = parser.parse_args()

    caps_mod = load_tenant_caps()
    rows = load_rows()
    board = caps_mod.norm_slug(args.slug)
    print(f"checking {args.ats}:{args.slug} job {args.job_id}" + (f" ({args.title})" if args.title else ""))

    # 1) the requisition itself. The tracker is read once, up front, for both checks below.
    recorded = [row for row in rows
                if str(row.get("source") or "").lower().find(str(args.job_id).lower()) >= 0]

    # 2) the board's own limits. A cap documented only in prose is a cap nobody consults, so every
    #    limit the entry states is weighed and the board is refused by whichever one is reached.
    caps = []
    try:
        caps = json.loads(CAPS.read_text(encoding="utf-8")).get("caps", [])
    except Exception as exc:  # noqa: BLE001 - a missing cap file must not break the preflight
        print(f"  (tenant caps NOT checked: {str(exc)[:60]})")

    for check in caps_mod.check_board(rows, caps, board, dt.date.today()):
        print(f"TENANT CAP: {check.describe()}")
        if check.source:
            print(f"    stated in: {check.source}")
        if check.reached:
            print(f"  -> KNOWN CAP REACHED: do not prepare or open another {check.slug} application.")
            if check.note:
                print(f"    {check.note}")
            print("\nRESULT: STOP - do not tailor, do not open the form.")
            return 1

    if recorded:
        print(f"  -> RECORDED: {len(recorded)} tracker row(s) already carry this requisition id.")
        print("\nRESULT: STOP - this requisition is already in the tracker.")
        return 1

    print("\nRESULT: clear - not recorded in the tracker, and no recorded limit for this board is "
          "reached. Tailoring may proceed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
