#!/bin/bash
# run-contract-tests.sh - run the whole suite against the CONTRACT FIXTURE SET.
#
# WHY THIS EXISTS. Part of this suite asserts facts that belong to a configured toolkit: the
# tracker's own scale, the employer that publishes one limit and enforces another, the saved role
# profile an assertion reads, the per-platform control maps the reference guidance resolves. A fresh
# checkout has none of that, so those assertions skip - and a suite that skips is a suite where a
# regression in exactly that area is invisible. This script materialises a fabricated fixture set,
# runs the full suite against it, and takes the fixture set away again.
#
# NOTHING THE USER OWNS IS TOUCHED, AND NOTHING IS INSTALLED INSIDE THE CHECKOUT. Configuration is read from
# `DATA_DIR`, the single definition of the `ATS_DATA_DIR` setting in `src/paths.py`, so the fixture
# configuration is written into a TEMPORARY directory outside the repository and `ATS_DATA_DIR` points the
# whole run at it. The checkout's own `data/` - where a real user's identity, work history, visa answers and
# application history live - is never read, never written and never moved. An earlier version of this script
# could only run against fabricated data by MOVING that directory aside and restoring it afterwards, with a
# refusal guard, a snapshot and a restore-on-every-exit-path; all of it existed to protect the user's answers
# from the fixtures, and pointing the setting elsewhere protects them by construction.
#
# ANOTHER EARLIER VERSION INSTALLED THE PER-ATS REFERENCE FILES INSIDE THE REPOSITORY, because they were
# skill material rather than configuration and `ATS_DATA_DIR` could not cover them. That was the one thing a
# run had to clean up, it needed a guard refusing to overwrite a real user's own copies, and it is gone with
# the files: the knowledge they held is asserted by tests, and a test needs no directory in the tree.
#
# USAGE
#   bash scripts/run-contract-tests.sh                 # the whole suite against the fixture set
#   bash scripts/run-contract-tests.sh --self-test     # exercise the install step, run no tests
#   bash scripts/run-contract-tests.sh --keep-fixtures # leave the temporary fixture tree in place for inspection
#
# EXIT STATUS: the suite's own status (0 only when both suites pass with zero failures and the fixture
# guards below still hold).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="$ROOT/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3)"

SELF_TEST=0
KEEP_FIXTURES=0
for arg in "$@"; do
  case "$arg" in
    --self-test) SELF_TEST=1 ;;
    --keep-fixtures) KEEP_FIXTURES=1 ;;
    -h|--help) sed -n '2,33p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if (( SELF_TEST == 1 )); then
  echo "== self-test: the install step, and the fact that it touches nothing in the tree =="
  # Byte-compiled files are build artifacts, never the run's result. This has to be set before the FIRST
  # python3 invocation, not after it: the self-test below imports `run_contract_fixtures`, which imports
  # `src.paths`, and the interpreter writes `scripts/__pycache__` on the way. That is a file the run added to
  # the tree, and the guard at the end of a real run compares the tree - so leaving it on would make the
  # guard report a leak that the run itself created.
  export PYTHONDONTWRITEBYTECODE=1
  "$PYTHON" scripts/run_contract_fixtures.py --self-test || exit 1
  exit 0
fi

# --------------------------------------------------------------------------- the run
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ats-contract.XXXXXX")" || exit 1
export ATS_DATA_DIR="$RUN_DIR/data"
mkdir -p "$ATS_DATA_DIR"
# Byte-compiled files are build artifacts of the run, not its result: without this the suite leaves new
# `__pycache__` directories all over src/, and the point of the check below is that a contract run leaves
# the tree exactly as it found it.
export PYTHONDONTWRITEBYTECODE=1
# The tree as the run found it, so the guard at the end can prove nothing was left behind in it rather than
# promising that the cleanup below covers every path.
TREE_BEFORE="$(find . -path ./node_modules -prune -o -path ./.venv -prune -o \
  -path ./output -prune -o -path ./tmp -prune -o -path ./.cache -prune -o -print | sort)"

cleanup() {
  local status=$?
  echo
  echo "== removing the fixture set =="
  # Everything the run installed lives in the temporary tree, so this is the whole removal.
  if (( KEEP_FIXTURES == 1 )); then
    echo "fixture tree kept at $RUN_DIR (ATS_DATA_DIR pointed there)"
  else
    rm -rf "$RUN_DIR"
  fi
  exit $status
}
trap cleanup EXIT INT TERM

echo "== installing the contract fixture set =="
"$PYTHON" scripts/run_contract_fixtures.py install || exit 1
echo
echo "data directory for this run: $ATS_DATA_DIR"
echo

# The 8 files a fresh checkout gets from the examples, for everything the fixture set does NOT own:
# the two canonical profiles, the live fill-spec inventory, the cover-letter template and the
# standing Ashby table. Its "keep" lines are the fixture set's own files, which it must not
# overwrite - so a `keep` here is the script working, not an error. `setup-examples.sh` asks
# `src/paths.py` where the data directory is, so it fills in the temporary tree and not the checkout.
echo "== filling in the example configuration around the fixtures =="
bash scripts/setup-examples.sh || exit 1

if [[ ! -f "$ATS_DATA_DIR/form_specs/answer_rules.json" || \
      ! -f "$ATS_DATA_DIR/applications.csv" ]]; then
  echo "REFUSING TO RUN: the fixture set was overwritten by the setup step" >&2
  exit 1
fi

echo
echo "== the suite, against the fixtures =="
# The discovery arguments come from `scripts['test:python']` - the ONE place they are written - so a
# change to the discovery roots reaches this run and `npm test` together, or neither. It used to read
# `scripts.test`, which is now the whole-suite entry point and no longer holds them.
MODULES="$(node -p "require('./package.json').scripts['test:python'].split(' -m unittest ')[1]")"
# The logs belong to the run, so they live in the run's own temporary directory: writing them under
# the checkout's `tmp/` left a file behind in the tree the contract run is supposed to leave untouched.
LOG="$RUN_DIR/contract-suite.log"
LOG_NODE="$RUN_DIR/contract-suite.node.log"

# The output is tee'd rather than captured, because the fixture guards below need their own copy of
# what the suites reported and the reader needs to see it as it happens. unittest runs with `-v` so
# that the log NAMES any test that skipped - the summary count alone cannot be acted on.
#
# `-v` GOES LAST, NOT FIRST, and the position is load-bearing. `unittest` only treats `discover` as a
# subcommand when it is the FIRST argument: with `-m unittest -v discover -s src -t .` the word
# `discover` is parsed as a test name and `-s`/`-t` are rejected as unrecognised arguments, so the
# whole run aborts with a usage message and no tests. Trailing `-v` is accepted by both the discovery
# form and a plain module list, so this one survives either way `scripts.test` is written.
"$PYTHON" -m unittest $MODULES -v 2>&1 | tee "$LOG"
python_status=${PIPESTATUS[0]}
node --test "src/forms/**/test_*.mjs" 2>&1 | tee "$LOG_NODE"
node_status=${PIPESTATUS[0]}
echo

python_summary="$(grep -E '^(OK|FAILED)' "$LOG" | tail -1)"
node_summary="$(grep -E '^(#|ℹ) ' "$LOG_NODE" | tr '\n' ' ')"
skips="$(grep -c " \.\.\. skipped " "$LOG")"
if (( skips > 0 )); then
  printf '\n%s test(s) skipped, by name:\n' "$skips"
  grep " \.\.\. skipped " "$LOG" | sed 's/^/  /' | cut -c1-160
fi

summary=0
if (( python_status != 0 )); then
  echo "python suite: FAILED (exit $python_status)"
  summary=1
else
  echo "python suite: passed"
fi
if (( node_status != 0 )); then
  echo "node suite: FAILED (exit $node_status)"
  summary=1
else
  echo "node suite: passed"
fi

# --------------------------------------------------------------------------- the fixture guards
# The numbers this whole exercise is for. Both totals come from the run that just finished, and the
# zero-skip requirement is a REFUSAL rather than a warning: a fixture set that leaves a test
# skipping has left the assertion it was written for invisible.
echo
echo "== fixture guards =="
guard_status=0
guard() {
  if printf '%s' "$1" | grep -Eq "$2"; then
    printf '  ok    %s\n' "$3"
  else
    printf '  FAIL  %s\n' "$3"
    guard_status=1
  fi
}
guard "$python_summary" '^OK' "the python suite passed (no failures, no errors)"
guard "$python_summary" 'skipped=(0|[^0-9])$|^OK$' "the python suite reported no skips"
guard "$node_summary" '(#|ℹ) fail 0' "the node suite reported no failures"
guard "$node_summary" '(#|ℹ) (skipped|skip) 0' "the node suite reported no skips"
printf '  python: %s\n  node:   %s\n' "$python_summary" "$node_summary"

# THE RUN LEFT THE TREE AS IT FOUND IT, and this is now a fact about the whole tree rather than about one
# directory the run used to install into. Everything the fixture set writes goes to the temporary tree, so
# anything new here is something that escaped it - which is the failure this guard exists to make loud.
# `output/` and `tmp/` ARE EXCLUDED, AND THEY ARE THE ONLY TWO. They are the directories this project
# documents as generated and gitignores; the suite's own scratch goes there (`tmp/apply/refill_r*`,
# `output/docx/`), so on a checkout that has never run anything they appear for the first time here and
# the guard failed on its own test suite's scratch. A guard that fails the first run and passes the
# second teaches the reader to run it twice, which is worse than the thing it was watching for. What it
# is for is a FIXTURE - a fabricated configuration or reference - escaping into the checkout, and that
# lands anywhere else.
TREE_AFTER="$(find . -path ./node_modules -prune -o -path ./.venv -prune -o \
  -path ./output -prune -o -path ./tmp -prune -o -path ./.cache -prune -o -print | sort)"
if [[ "$TREE_BEFORE" == "$TREE_AFTER" ]]; then
  printf '  ok    the run left no file behind in the checkout\n'
else
  printf '  FAIL  the run changed the tree; these paths are new:\n'
  comm -13 <(printf '%s\n' "$TREE_BEFORE") <(printf '%s\n' "$TREE_AFTER") | sed 's/^/        /'
  guard_status=1
fi

if (( guard_status != 0 )); then
  echo
  echo "The fixture set did not reach zero skips and zero failures. Nothing was weakened to get here:"
  echo "an assertion this set cannot satisfy is reported, not edited - see the suite's own output above."
  summary=1
fi

echo
if (( summary != 0 )); then
  echo "RESULT: FAILED"
else
  echo "RESULT: 0 failures, 0 skips in both suites"
fi
exit $summary
