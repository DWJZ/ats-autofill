"""Where this checkout's data lives. The single definition of the `ATS_DATA_DIR` setting.

WHY THIS EXISTS. Every tool here reads its configuration from one directory beside the code: the two
canonical profiles, the tracker, the answer-rule table, the tenant policies. That directory used to be
spelled out as `ROOT / "data"` in nineteen files, one path segment at a time, and the cost was not
cosmetic. Because the path could not be pointed anywhere else, the contract-test runner had no way to run
the suite against a fabricated configuration except to MOVE the user's real `data/` aside, install the
fixtures in its place, and put it back afterwards - machinery whose failure mode is a destroyed
application history. One setting replaces all of it:

    ATS_DATA_DIR=/somewhere/else npm test

and the fixtures can live in a temporary directory that nobody owns.

ROOT      the repository root, from this file's own location (`src/paths.py` is one level down).
DATA_DIR  `$ATS_DATA_DIR` when it is set, otherwise `ROOT / "data"`.

THE VARIABLE IS READ HERE AND NOWHERE ELSE, at import time, so every module in a process agrees on one
answer. Reading it at each call site is how a single run ends up with two directories: half the code
looking at the configured one and half at the default, with no error to show for it. A module that
cannot import this file (a shell script, say) asks for the answer - `python3 src/paths.py` prints
`DATA_DIR` - rather than re-deriving it and becoming a second definition.
"""
from __future__ import annotations

import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

#: Resolved once, here. A relative `ATS_DATA_DIR` is read against the working directory the process
#: started in, which is what a caller writing `ATS_DATA_DIR=fixtures npm test` means by it.
_env = os.environ.get("ATS_DATA_DIR")
DATA_DIR = pathlib.Path(_env).expanduser().resolve() if _env else ROOT / "data"


if __name__ == "__main__":
    # The one caller that cannot import this module is `scripts/setup-examples.sh`, and the reason it
    # asks rather than computes is the reason this file exists: `ATS_DATA_DIR` written out a second
    # time in a shell script is a second definition of the setting, and the two would drift.
    print(DATA_DIR)
