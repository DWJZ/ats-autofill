#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
# Project-local virtualenv first (see requirements.txt) - the pipeline must not depend on a
# system Python. Create it with:
#   python3 -m venv .venv && .venv/bin/python3 -m pip install -r requirements.txt
VENV_PYTHON="$ROOT/.venv/bin/python3"

if [[ -x "$VENV_PYTHON" ]]; then
  PYTHON="$VENV_PYTHON"
else
  PYTHON="$(command -v python3)"
fi

exec "$PYTHON" "$ROOT/src/pipeline/application_pipeline.py" "$@"
