#!/bin/bash
# test-all.sh - every assertion this repository has, through one command.
#
# WHY TWO RUNS, AND WHY ONLY TWO. They have different subjects, so neither replaces the other:
#
#   1. THE CONTRACT SUITE runs both suites against a fabricated fixture set and asserts ZERO skips.
#      Twenty-two assertions read a fact that only a CONFIGURED toolkit has - someone's application
#      cap, a saved role profile, a per-ATS control map, the answer rules for one employer's wording -
#      so on a checkout holding the example files they have nothing to read and skip. This half is
#      what gives them a subject, and it is the half that works on a bare clone, so it runs first.
#
#   2. THE CONFIGURATION SUITE runs the Python modules against whatever `data/` holds - the examples
#      after `setup-examples.sh`, or your own facts. The contract half cannot check this: it REPLACES
#      the configuration, so a typo in `examples/` would never be seen by it.
#
# The Node suite runs ONCE, in the contract half. It drives HTML fixtures in its own headless browser
# and reads no configuration, so a second run would repeat identical work; the contract half already
# reports it at zero skips.
#
# EXIT STATUS: 0 only when every half that ran passed. A half that could not run says so in the
# summary and is not a failure - see the reference guard below.
#
# USAGE
#   bash scripts/test-all.sh
#   npm test                     # the same thing
#
# The halves on their own:
#   npm run test:contract        # both suites against the fixtures, zero skips
#   npm run test:suites          # both suites against this checkout's own configuration
#   npm run test:python / test:node

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="$ROOT/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3)"

DATA_DIR="$("$PYTHON" src/paths.py 2>/dev/null | tail -1)"

contract_result="NOT RUN"
config_result="NOT RUN"
status=0

# --------------------------------------------------------------------------- 1. the contract half
echo "=============================================================="
echo "== 1/2  the contract suite - both suites, zero skips"
echo "=============================================================="
bash scripts/run-contract-tests.sh
contract_status=$?
case "$contract_status" in
  0)   contract_result="passed" ;;
  # THE CONTRACT HALF CAN NO LONGER BE "NOT RUN". It used to have one way of declining rather than failing:
  # the reference guard, which refused to install invented per-ATS control maps over a checkout that already
  # had the user's own. Nothing is installed inside the checkout any more, so there is nothing left to
  # refuse, and a non-zero status here is a failure like any other.
  *)   contract_result="FAILED (exit $contract_status)"
       status=1 ;;
esac

# --------------------------------------------------------------------------- 2. the configuration half
echo
echo "=============================================================="
echo "== 2/2  the configuration suite - against this checkout's data/"
echo "=============================================================="
if [[ -d "$DATA_DIR" ]]; then
  # The discovery arguments live in ONE place, `scripts['test:python']`, which the contract runner
  # reads as well - so a change to the discovery roots reaches both halves or neither.
  PY_CMD="$(node -p "require('./package.json').scripts['test:python'].split(' -m unittest ')[1]")" \
    || PY_CMD="discover -s src -t ."
  "$PYTHON" -m unittest $PY_CMD
  config_status=$?
  if [[ $config_status -eq 0 ]]; then
    config_result="passed"
  else
    config_result="FAILED (exit $config_status)"
    status=1
  fi
else
  echo "No data directory at $DATA_DIR, so this half has nothing to read."
  echo "The modules that assert facts about a configured toolkit report FileNotFoundError here rather"
  echo "than skipping - they are testing what the file CONTAINS, not that it is absent. Either run"
  echo "    bash scripts/setup-examples.sh"
  echo "and use the examples as your configuration, or point ATS_DATA_DIR at your own."
  echo
  echo "This is not a failure: the contract half above already ran every module, against fixtures."
  config_result="NOT RUN - no data directory (see above)"
fi

# --------------------------------------------------------------------------- the summary
echo
echo "=============================================================="
printf '== result\n'
printf '   %-46s %s\n' "contract suite (fixtures, zero skips)" "$contract_result"
printf '   %-46s %s\n' "configuration suite (this checkout's data/)" "$config_result"
[[ $status -eq 0 ]] && echo "   => 0" || echo "   => $status"
exit $status
