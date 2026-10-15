#!/bin/bash
# setup-examples.sh - copy the example configuration into the data directory, once.
#
# WHY THIS EXISTS. The code in src/ is generic; the configuration is not. Every tool in this repo
# reads its facts from candidate_profile.json and application_profile.json, its answer rules from
# form_specs/answer_rules.json, the record of what was applied to from applications.csv, and the
# employer limits and letter wording from three more files. Without them the harness runs and does
# nothing useful, which is exactly what a fresh checkout looks like.
#
# WHERE "THE DATA DIRECTORY" IS. It is a SETTING, not the literal `data/`: `src/paths.py` holds its
# single definition (`$ATS_DATA_DIR` when it is set, `<repo>/data` otherwise), and this script asks
# that file for the answer instead of reading the variable's name a second time here, where the two
# copies would drift apart. So `ATS_DATA_DIR=/somewhere/else bash scripts/setup-examples.sh` sets up
# that directory, and that is also how the contract-test runner fills in its temporary fixture tree
# without going anywhere near the configuration a real user has here.
#
# This script is the one setup step: it copies each example from examples/ to the path the code
# reads, and it REFUSES TO OVERWRITE a file that already exists - so re-running it after you
# have filled in your own facts cannot destroy them. If a file is reported as "keep", that is
# the script doing its job, not an error.
#
# Usage:  bash scripts/setup-examples.sh
#         scripts/setup-examples.sh
#         ATS_DATA_DIR=/somewhere/else bash scripts/setup-examples.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-$(command -v python3)}"
DATA_DIR="$("$PYTHON" "$ROOT/src/paths.py")" || {
  printf 'cannot ask src/paths.py where the data directory is\n' >&2
  exit 1
}

created=0
kept=0
missing=0

# copy_example <example file under examples/> <destination, relative to the data directory>
copy_example() {
  local src="examples/$1"
  local dst="$DATA_DIR/$2"

  if [[ ! -f "$src" ]]; then
    printf 'MISSING  %s - the example file itself is not in the repo\n' "$src" >&2
    missing=$((missing + 1))
    return 0
  fi

  # Create the destination directory only when the file is really about to be written, so a
  # re-run does not leave empty directories behind.
  if [[ -e "$dst" ]]; then
    printf 'keep     %-42s (already exists - not overwritten)\n' "$2"
    kept=$((kept + 1))
    return 0
  fi

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  printf 'create   %-42s (from %s)\n' "$2" "$src"
  created=$((created + 1))
}

printf 'data directory: %s\n\n' "$DATA_DIR"

# The two canonical profile files. Everything the tool says about the applicant comes from
# these, and nothing that is not in them is ever invented.
copy_example candidate_profile.example.json        candidate_profile.json
copy_example application_profile.example.json      application_profile.json

# The answer-rule table: wordings that recur, answered once with a note naming their source.
copy_example answer_rules.example.json             form_specs/answer_rules.json

# The board registry: which Greenhouse/Lever/Ashby/Workday boards to fetch, the words the Workday
# channel searches for, and the timezone the daily report is filed under. The boards you track are
# yours, so this file lives in the data directory and not in `src/` - see its own `queries_comment`
# and `timezone_comment` for the two values that used to be constants in `daily_screen.py`.
copy_example daily_sources.example.json              screening/sources.json

# The tracker: one row per posting, with its status. A row is not an application - only
# `submitted_by_user` / `submitted_by_agent` mean one was sent.
copy_example tracker.example.csv                   applications.csv

# What individual employers will and will not do, learned the expensive way.
copy_example tenant_policies.example.json          tenant_policies.json

# The application caps, read before a form is opened so a capped board is refused early.
copy_example tenant_caps.example.json              form_specs/tenant_caps.json

# The standing table: questions that recur, answered once with a note naming their source. The Ashby
# helpers are unusable without it, and it is the one file where a wrong entry becomes a false
# statement rather than a gap - so read the notes in the example before you add your own.
copy_example ashby_pairs_standing.example.json     form_specs/ashby_pairs_standing.json

# TWO DIRECTORIES THAT MUST EXIST AND HAVE NO FILE TO COPY.
#
# `resume_profiles/` holds one role profile per application - a file you create by copying
# `examples/resume_profile.example.json`, which is why nothing is installed here. Without the
# directory the first `prepare --profile …` fails on the copy rather than on anything the toolkit
# explains. `resume_templates/` holds your master DOCX, which is yours to supply; `python3
# src/pipeline/make_master_resume.py` writes a scaffold with the styles the renderer needs, and it
# lands at the path the renderer actually opens.
# The example person's resume, rendered through the real renderer, so a new checkout can run `prepare`
# without a build step first. The body is discarded on every render - `build_resume` keeps the page setup
# and the three named styles and rebuilds the text from application_profile.json - so the mock content in
# it costs nothing and shows the reader what the output looks like. Replace it with your own layout, or
# delete it and run `python3 src/pipeline/make_master_resume.py` for a blank one.
copy_example resume_template.example.docx          resume_templates/Example_Candidate_Backend_Resume.docx

mkdir -p "$DATA_DIR/resume_profiles" "$DATA_DIR/resume_templates"
printf 'mkdir    %-42s (empty: one role profile per application goes here)\n' "resume_profiles/"
printf 'mkdir    %-42s (holds the example master DOCX just copied)\n' "resume_templates/"

# The cover-letter wording. Every {{placeholder}} in it is filled by name from the two
# profiles, so a fact that is not in them cannot appear in a letter.
copy_example cover_letter_template.example.txt     cover_letter/template.txt

printf '\n'

if [[ "$missing" -gt 0 ]]; then
  printf 'Finished with %d missing example file(s): the checkout is incomplete.\n' "$missing" >&2
  exit 1
fi

printf 'Created %d file(s), kept %d existing file(s).\n' "$created" "$kept"
cat <<'NOTE'

NEXT: the examples describe one fictional person ("Example Candidate", Springfield, Illinois).
Every value in them is a placeholder, and the ones that matter most are the ones that read as
answers rather than as placeholders:

  * the yes/no fields (work authorisation, sponsorship, relocation, consent), because a wrong
    "Yes" or "No" here is a false statement on a real application;
  * eligibility and status fields under `workday_defaults`;
  * the demographic option text, which must match the form's own wording;
  * `do_not_claim` - the list of things you must never be described as having done;
  * `standing_answers.compensation`, which is a number about you;
  * every `note` in `ashby_pairs_standing.json`, because that table answers questions in bulk and a
    stale note there means a question answered wrongly on every form that asks it.

Edit the eight files above with your own facts before filling any form, and never commit them:
they are ignored by .gitignore for exactly that reason.

TWO MORE THINGS BEFORE THE FIRST `prepare`, and neither can be copied by this script:

  1. THE MASTER RESUME DOCX. The resume pipeline is template-driven - it patches a document you
     supply rather than generating one - so it needs the layout to exist. A scaffold with the
     paragraph styles the renderer requires is one command away:

         .venv/bin/python3 src/pipeline/make_master_resume.py

     It writes to the path the renderer actually opens, so `prepare` finds it. What the renderer
     keeps out of that document (the page setup and three named styles, and nothing else) is in
     "The master resume DOCX is yours to supply" in docs/CONFIGURATION.md.

  2. A ROLE PROFILE PER APPLICATION, in `data/resume_profiles/`. It describes the POSTING, not you -
     four fields are required and the rest are optional overrides. Copy the template and fill it in:

         cp examples/resume_profile.example.json data/resume_profiles/<company>_<role>.json
         .venv/bin/python3 src/pipeline/application_pipeline.py prepare \
             --profile data/resume_profiles/<company>_<role>.json
NOTE
