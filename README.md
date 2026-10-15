# ats-autofill

A local-first toolkit for automating job applications on ATS (applicant-tracking-system) web forms —
Greenhouse, Ashby, Lever, Workday, Phenom, SmartRecruiters and the react-select widgets they use.

It drives Chrome over the DevTools Protocol. It attaches to a browser that is already running, and when
none is it starts one of its own — in a profile inside the data directory, headless by default. It never
quits or restarts a browser it did not start, and never takes the focus away from what you are doing.

> **Working in this repo with a coding agent?** Start with [`AGENTS.md`](AGENTS.md) — the operating
> contract and a routing table saying which file to read before which action. The numbered rules that
> source comments cite live in [`docs/RULES.md`](docs/RULES.md).
>
> The loadable procedures live in [`skills/`](skills): one for taking a posting through to a
> submitted application, one for driving the form controls themselves. They are plain `SKILL.md`
> files, so **point your agent at that folder** — Codex reads repo skills from `.agents/skills/`,
> Claude Code from `.claude/skills/`; copy or link `skills/` into whichever one you use.

## The idea: read back what the page actually committed

Every form-filling tool can make a control *look* filled. The failure this project exists to catch is the
one where a control reports success and **holds nothing** — and the only way to tell the two apart is to
read the page back after writing to it.

So the unit of work here is not "write a value into a field". It is:

1. **scan** the form into a machine-readable inventory of controls (`inspect_ats_form.mjs`),
2. **fill** it from a JSON spec (`apply_form_spec.mjs`),
3. **read every value back** off the rendered page (`audit_form_fields.mjs`, `diagnose_form.mjs`),
4. and only then **submit**, through a verification gate that refuses the click if any expectation failed
   (`verify_and_submit.mjs`).

That last step is the whole difference. A filled-looking field proves nothing, so the gate asks whether the
*rendered* value is the answer that was intended: a combobox whose committed option is displayed, a Yes/No
pair that reads checked, a required control that is non-empty, a value that matches the expected text.

The failure modes are on the record in the source comments, because each one bought a tool:

* **A placeholder read back as a value.** A control showing `Select...` counted as answered, so a required
  question was reported clean while the employer would have refused it over the blank. `field_state.mjs`
  exists to answer "is this a real value, or is the control telling you it has none".
* **A fallback selector that matched the wrong input.** When an id-less control is emitted with an empty
  ref, a loose selector finds *some* field, and the application goes out with the wrong text in the right box.
* **A value the page never committed.** A widget can display an option as container text without storing it;
  the read-back is the only check that sees the difference.
* **A pre-filled value that is a claim nobody made.** An ATS default in a location, salary or date field is a
  statement about the applicant that the applicant never stated, so pre-filled values are read too.

The same idea runs through the Python side: the pipeline renders a tailored resume to PDF, then rasterises
the pages and fails the render when a page comes out blank-looking, rather than shipping a PDF nobody read.

## What it is not

Being explicit, because the interesting parts of this project are the places where it stops:

* **It does not bypass logins, CAPTCHAs or bot protection.** A password, a 2FA prompt, an image CAPTCHA or a
  verification code that cannot be read is where an application stops and the tab is left for the person to
  finish. There is no attempt to defeat a challenge — the tools report it and stop.
* **It does not submit without review.** `apply_form_spec.mjs` refuses any spec that asks it to submit;
  writing and submitting are separate steps, and submission goes through an expectation gate with a dry run.
* **It does not take over your browser.** It attaches over CDP to an instance on the debugging port, opens
  background tabs only, and never calls `bringToFront`. If nothing is answering on that port it starts its
  **own** Chrome — dedicated profile, headless by default — and a Chrome it did not start is one it will not
  quit or restart. `src/forms/chrome_launch.mjs` is the whole of that behaviour, and
  `src/tools/check_no_focus_steal.py` is a test.
* **It does not invent facts.** A form is filled only from the canonical configuration files; an answer that
  is not in them is left blank and reported. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
* **It is macOS-oriented.** Verification-code reading and mailbox triage drive Mail.app through AppleScript
  (`osascript`), which is macOS-only. The form tools themselves are portable Node.

## Requirements

| | |
| --- | --- |
| OS | macOS for the Mail.app/AppleScript tools; Linux and Windows can run the form tools |
| Python | 3.10+ with a project-local virtualenv (`.venv`) built from [`requirements.txt`](requirements.txt) |
| Node | **22+** — the test command hands `node --test` a quoted glob, and glob support in the test runner arrived in Node 21: on 18 and 20 the argument is read as a literal path, no file has that name, and the widget tests do not run at all. With `playwright-core` from [`package.json`](package.json) |
| Chrome | a debugging instance on the port. `node src/forms/chrome_launch.mjs` starts one if none is running, and attaches if there is; bring your own with a remote debugging port and it will use that instead |
| LibreOffice | **required for the resume pipeline**, and **downloaded for you**: `prepare` renders DOCX to PDF, and on macOS a missing LibreOffice makes it fetch the project-local copy into `.cache/` (about 300 MB, once, with the download announced and cached). `SOFFICE_PATH` points it at an install you already have, and `ATS_NO_SOFFICE_DOWNLOAD=1` keeps the old behaviour — a message naming the two install commands. Only the screening and form-filling halves run without it at all |

```bash
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm install
# `npm install` failing with EPERM on the cache? That is root-owned files from an earlier sudo
# run, not this project. Re-run it with a cache of your own:
#   npm install --cache /tmp/npm-cache
```

### Starting Chrome with a debugging port

```bash
node src/forms/chrome_launch.mjs              # attach if the port answers, otherwise start a browser
node src/forms/chrome_launch.mjs --probe      # just say whether it answers — starts nothing
node src/forms/chrome_launch.mjs --visible    # start with a window, for a sign-in or a CAPTCHA
node src/forms/chrome_launch.mjs --port 9333  # a port other than the default
```

The tools connect to `http://127.0.0.1:9223` by default (`--cdp` overrides it). What the launcher does, in the
order it does it:

1. **Probes the port first**, and if something is answering it prints `attach:` and starts nothing. That is what
   makes "never a second instance" a property of the tool rather than a promise about how it is used.
2. **Otherwise starts Chrome in its own profile**, `<data>/chrome-cdp-profile` — inside the data directory so it
   travels with your configuration, and never the profile of the browser you are using. A `--profile` outside
   the data directory is **refused**, not honoured: a launcher that can be pointed at a personal profile will be,
   once.
3. **Headless by default**, so nothing appears and nothing takes your focus. `--headless=new` speaks the same
   DevTools protocol as a windowed instance — `test_fill_roundtrip.mjs` drives every real filler against a
   headless browser for this reason. Use `--visible` when you need a window: signing in to a board for the first
   time in a fresh profile, or finishing a CAPTCHA, are the two things a headless instance cannot do with you.
4. **Starts only, never stops.** There is no quit, restart or kill path in the file, so a browser this tool did
   not start is one it cannot end. Port **9222** is refused outright: on some machines it belongs to another
   program entirely.

`--print-command` reports the decision and the exact command line without running anything, which is how to check
what it would do on a machine where a browser must not be started. Exit status is `0` when the port answers, `2`
when it does not, and `1` when the tool refuses to start (a reserved port, a refused profile, no browser found).

Two habits worth keeping: sign in to the job boards once in that profile by hand — it is a fresh profile, and
the session persists between runs — and after the first sign-in, prefer a headless launch; the browser's own
window is only in the way. And if you would rather run your own launcher, nothing here requires the tool's:

```bash
#!/bin/bash
# start-chrome-debug.sh — a Chrome with a debugging port, in its own profile.
set -euo pipefail

PORT="${CDP_PORT:-9223}"                          # the port the tools default to
PROFILE="${CDP_PROFILE:-$PWD/.cache/chrome-cdp-profile}"

mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check

# Confirm it is up before running any tool:
until curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null; do sleep 1; done
echo "CDP ready on http://127.0.0.1:$PORT"
```

A browser you start this way is one the launcher will **attach** to rather than start beside — while it is
answering on the port, `chrome_launch.mjs` does nothing at all. The one habit that matters either way: never point
the tools at a browser you are working in — a background tab is not a guarantee that a form's own JavaScript is idle.

DOCX→PDF rendering needs LibreOffice on the machine. `brew install --cask libreoffice`, or
`bash src/tools/install_libreoffice.sh`, which unpacks a project-local copy under `.cache/libreoffice` and
needs no admin rights. `src/pipeline/render_docx.py` finds either one; page rasterisation uses `pypdfium2`,
so poppler is not required.

## Get started

```bash
bash scripts/setup-examples.sh
```

That is the only setup step: it copies the example files in [`examples/`](examples) to the data directory —
**eight of the nine**: `resume_profile.example.json` is a template you copy per application rather than a file to
edit in place (see the role profile below) — and refuses to overwrite a file that already exists. Then edit those
files with your own facts — see the note at the end of this README.

**If you already have a tracker from an earlier version of this toolkit**, read
[Bringing an existing tracker with you](docs/CONFIGURATION.md#bringing-an-existing-tracker-with-you) before the
first duplicate check. Only two status values count as "sent", and a row carrying anything else is treated as an
application that never happened — which is how a duplicate application gets sent, because
`check_duplicate.py` reads the status column to decide.

Two inputs are deliberately **not** copied, because they are yours to create:

* **the master resume DOCX** in `data/resume_templates/`. The resume pipeline is template-driven — you supply
  the layout and it fills it. `.venv/bin/python3 src/pipeline/make_master_resume.py` writes a scaffold with the
  styles the renderer requires, at the path the renderer opens; see
  [the master resume DOCX](docs/CONFIGURATION.md#the-master-resume-docx-is-yours-to-supply) for what it keeps
  out of that document.
* **a role profile per application** in `data/resume_profiles/`. It describes the *posting*, not you: four
  fields are required and the rest are overrides. Copy
  [`examples/resume_profile.example.json`](examples/resume_profile.example.json), fill it in, and pass it to
  `prepare`.

A first run, end to end, against a form you already have open in the debugging Chrome:

```bash
# 1. Screen postings (stdlib only; writes output/daily_<date>.md)
python3 src/screening/daily_screen.py --top 5 --jd-top 15

# 2. Is this posting already applied to, or a re-post of one that was?
.venv/bin/python3 src/screening/check_duplicate.py "https://job-boards.greenhouse.io/<board>/jobs/<id>"

# 3. Write the role profile for THIS posting, then tailor the documents from it.
#    (First run only: .venv/bin/python3 src/pipeline/make_master_resume.py, to create the master DOCX.)
cp examples/resume_profile.example.json data/resume_profiles/<slug>.json   # then fill it in
.venv/bin/python3 src/pipeline/application_pipeline.py prepare \
    --profile data/resume_profiles/<slug>.json
#    -> output/pdf/<...>_Resume.pdf, and the tracker row this application will be recorded against

# 4. Inventory the open form — this is read-only, and prints nothing but facts
node src/forms/inspect_ats_form.mjs "<url-substring>" --options --out tmp/<slug>_fields.json

# 5. Turn the inventory into a fill spec from your canonical data (+ a needs_review list)
python3 src/forms/draft_form_spec.py tmp/<slug>_fields.json \
    --job "<Company> — <Role>" \
    --resume output/pdf/<...>_Resume.pdf \
    --cover-letter output/pdf/<...>_Cover_Letter.pdf \
    --out data/form_specs/<slug>.spec.json

# 6. Fill it (never submits), then audit every control on the page
node src/forms/apply_form_spec.mjs data/form_specs/<slug>.spec.json
node src/forms/audit_form_fields.mjs "<url-substring>"

# 7. Read back, gate, and — only if every expectation holds — submit
node src/forms/verify_and_submit.mjs "<url-substring>" "<slug>" --company "<Name>" \
    --expect '[{"kind":"valueIs","value":"Example Candidate"},{"kind":"noEmptyRequired","ids":["first_name"]}]' \
    --dry-run
```

When a form reveals new controls only after it has been filled — cascading EEO blocks do this — run the loop
instead of repeating steps 3 to 5 by hand:

```bash
node src/forms/refill_until_stable.mjs "<url-substring>" --max-rounds 4
```

It stops when a round produces **no new controls**, which is not the same as "no blanks left": a control can
be visible, impossible to fill and correctly listed for a person.

## What lives where

| Directory | Contents |
| --- | --- |
| `src/forms/` | The form pipeline. `inspect_ats_form.mjs` (read-only inventory), `widget_scan.mjs` + `widget_fingerprint.mjs` (how controls are seen and classified), `draft_form_spec.py` (inventory → fill spec, from canonical data only), `apply_form_spec.mjs` (fill, never submit), `audit_form_fields.mjs` + `diagnose_form.mjs` + `field_state.mjs` (read every value back; decide whether it is a real answer), `verify_and_submit.mjs` (the expectation gate), `refill_until_stable.mjs` (scan → draft → fill until the form stops revealing controls), `cdp_tabs.mjs` (background tabs, no focus stealing), `chrome_launch.mjs` (probe the port; attach if it answers, otherwise start an own-profile browser — see [Starting Chrome](#starting-chrome-with-a-debugging-port)). Widget regression tests live here too, with HTML fixtures in `fixtures/` rendered in a private **headless** browser by `fixture_browser.mjs`, so a form's shape can be tested without touching a live application |
| `src/screening/` | Finding and filtering postings before anything is tailored. `daily_screen.py` + `data/screening/sources.json` (the boards to fetch, the field and region words in its `filters` block, dedupe, rank, classify work-authorisation language and drop the postings whose requirement the applicant cannot meet — which requirement that is comes from `standard_answers.work_authorization`, and nothing is dropped when it is unset, see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#which-postings-the-screen-drops--standard_answerswork_authorization)), `screen_newgrad_postings.py` (the shared field/level vocabulary every screener below uses), `screen_urls.py` (JD text → hard bars), `harvest_board_slugs.py` (real board slugs from search), `list_board_jobs.py`, `scan_registry_fresh.py`, `scan_tracker_tenants.py` (re-read the live boards already in the tracker), `check_duplicate.py` (NEW / DUPLICATE / REVIEW for a posting URL), `filter_unapplied.py`, `tracker_index.py` (the shared reader of the tracker CSV — not the only one: `application_pipeline.py` and `scan_tracker_tenants.py` open it themselves, see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)), `tenant_caps.py` (may this board take one more application) |
| `src/pipeline/` | Everything that produces an application's documents. `application_pipeline.py` (the `prepare` / `record-status` / `duplicates` / `handover` CLI, also reachable as `./run_application_pipeline.command`), `generate_tailored_resume.py` (patch a master DOCX into a tailored one), `build_resume.py`, `build_cover_letter.py` + `cover_letter_template.py` (render the letter from canonical facts; an unresolved placeholder is an error), `resume_artifacts.py` (PDF QA: page count, text, blank-page detection), `render_docx.py` (DOCX → PDF → page PNGs), `summary_guard.py`, `job_app_assistant.py` |
| `src/metrics/` | What happened to each application, in machine-readable form. `ledger.py` (an append-only ledger written as the event happens — how many times a submit was attempted, and what each refusal said, exist nowhere else), `ledger_report.py` (read it back per application) |
| `src/tools/` | Small, single-purpose tools: `check_no_focus_steal.py` (report code that would steal focus), `check_profile_summaries.py` (catch an over-long summary before a render wastes the round), `live_callers.py` (does a script still have a real caller, comments excluded), `install_libreoffice.sh`, and the Mail.app AppleScripts used to read verification codes and triage application mail |
| `src/autofill/` | The **Workday** wizard, and only that: `workday_runner.mjs` (drive a whole Workday application from one payload plus a per-step answer plan), `workday_experience_helper.mjs` (the `My Experience` step — work history, education, LinkedIn, resume upload), `workday_playwright_adapter.mjs` (the bridge that lets that helper run against a plain Playwright page) and a README beside them. There is no Greenhouse, Ashby, Lever, SmartRecruiters or Phenom code here: the configs generated for those platforms used to be written to `src/autofill/<platform>/`, and they are per-job state, so they now land in the data directory (`<data>/autofill/<platform>/`). `src/forms/` is the generic layer |

`examples/` holds placeholder configuration; `data/` is where it goes (and is never committed). `tmp/`,
`.cache/` and most of `output/` are generated and ignored.

## Tests

```bash
npm test
```

**That is every assertion this repository has, in two runs, and it works on a bare clone.** The two
halves have different subjects, so neither replaces the other:

* **the contract suite** runs both suites against a fabricated fixture set and asserts **zero skips**.
  Twenty-two assertions read a fact that only a *configured* toolkit has — a tenant's application cap,
  a saved role profile, a per-ATS control map, the answer rules for one employer's wording — so on a
  checkout holding only the example files they have nothing to read and skip. This half gives them a
  subject, and it leaves your own `data/` alone: the fixtures go to a temporary directory outside the
  checkout and `ATS_DATA_DIR` points the run at it.
* **the configuration suite** runs the Python modules against whatever `data/` holds — the examples
  after `setup-examples.sh`, or your own facts. The contract half cannot check this, because it
  *replaces* the configuration; a typo in `examples/` would never be seen by it. It reports
  `OK (skipped=16)` on the examples, and the 16 are named as they skip.

The Node suite runs once, in the contract half: it drives HTML fixtures in its own browser and reads no
configuration, so a second run would repeat identical work.

**The halves on their own**, when one is what you want:

```bash
npm run test:contract        # both suites against tests/fixtures/contract/, zero skips
npm run test:suites          # both suites against this checkout's own configuration
npm run test:python          # just the Python modules
npm run test:node            # just the Node tests
```

**Both halves always run.** There is no half that refuses to start and no `NOT RUN` result: the fixture set goes to a temporary directory outside the repository, so nothing in it can collide with anything you have configured. A non-zero status is a failure.

**Discovery, not a list.** A new `src/**/test_*.py` or `src/forms/test_*.mjs` runs the moment it exists;
nothing needs registering. The `__init__.py` files in `src/` and its subdirectories are what make it
work — `unittest` only recurses into packages, and without them discovery finds **zero tests and reports
success**, which is the worst possible way for a test runner to fail. Do not delete them.

**One test is a known slow spot.** `test_fill_roundtrip.mjs`'s `refill_until_stable` loop drives three
rounds of scan → draft → fill through real subprocesses, so it is bounded by the machine rather than by
the property it asserts; its own comment records that the limit was raised once already for exactly
this. It is the test to look at first if a run takes far longer than the others.

**Discovery, not a list.** A new `src/**/test_*.py` or `src/forms/test_*.mjs` runs the moment it
exists; nothing needs registering. The `__init__.py` files in `src/` and its subdirectories are what
make it work — `unittest` only recurses into packages, and without them discovery finds **zero tests
and reports success**, which is the worst possible way for a test runner to fail. Do not delete them.

Run a single module while working:

```bash
# one Python module
.venv/bin/python3 -m unittest src.forms.test_answer_rules

# one Node test file
node --test src/forms/test_fill_roundtrip.mjs
```

Three honest notes about the suites:

* The widget tests need a Chromium build. `fixture_browser.mjs` launches its **own** headless browser, never
  the one on 9223, and a missing build is treated as a **skip** rather than a failure — a test suite that
  fails because a browser is not cached tells you nothing about the code.
* Some tests assert the **content** of the configuration they find rather than its shape: the tenant policy
  and cap files, the answer-rule table, the preferred-location order, the tracker. They are written against
  one person's own data, and a placeholder configuration does not satisfy them. Rather than weaken an
  assertion to fit, those tests **skip with a reason naming what is absent** — so a green run with skips means
  "the code is fine and this checkout has no real data yet", and a real table whose rules stop firing still
  fails. The skip reasons are the honest list of what a fresh checkout cannot test.
* `unittest` **loads every module it is given before it runs any test**, so a module that raises at import
  time — because a file it reads at import is missing — prints a traceback and runs nothing at all. That is
  the loader, not the runner. It is why the modules the suites collect read their files lazily and skip
  when one is absent.

Those skips can be turned into runs, against fabricated data, without a checkout ever holding a real answer:

```bash
npm run test:contract        # the same two suites, against tests/fixtures/contract/
```

`tests/fixtures/contract/` is a **fabricated** tracker, caps file, tenant-policy file, answer-rule table and
saved role profile, plus the per-ATS reference files. Every value in it is invented. The configuration half is
installed into a **temporary directory outside the repository**, and `ATS_DATA_DIR` points the whole run at it
— so this checkout's own `data/`, where a real user's answers live, is never read, never written and never
That directory is a **setting**, not a name baked into nineteen files:

```bash
ATS_DATA_DIR=/somewhere/else npm test                 # the whole suite against another configuration
ATS_DATA_DIR=/somewhere/else bash scripts/setup-examples.sh
```

`src/paths.py` holds the single definition (`$ATS_DATA_DIR` when it is set, `<repo>/data` otherwise) and every
module, script and shell entry point asks it — `src/paths.mjs` is the Node twin, and the shell scripts call
`python3 src/paths.py`, which prints the resolved directory. Two consequences worth knowing: a second person
can keep their own configuration outside the checkout, and `npm run test:contract` can run against a
temporary tree.

## The example profile is not me — and it is not you either

`examples/*.example.json` describe a fictional person: **Example Candidate**, of Springfield, Illinois,
who went to Lakeside State University, Fairview. Every string in them is a placeholder, and the files exist
to show the exact schema the code reads.

```bash
bash scripts/setup-examples.sh      # copies examples/ into the data directory without overwriting anything
```

Then edit the eight files it copied with your own facts — the ninth example,
`resume_profile.example.json`, is the template you copy once per application instead. The values that matter most are
the ones that read as answers rather than as placeholders:

* the yes/no fields — work authorisation, sponsorship, relocation, consent — because a wrong `Yes` or `No`
  there is a false statement on a real application;
* the eligibility and status fields under `workday_defaults`;
* demographic option text, which must match the form's own wording;
* `do_not_claim`, the list of things you must never be described as having done;
* `standing_answers.compensation`, which is a number about you;
* every `note` in `ashby_pairs_standing.json` — that table answers recurring questions in bulk, so a stale
  note there is a question answered wrongly on every form that asks it.

And do not commit any of it: the files are ignored by `.gitignore`, which also explains why.

## Licence

MIT — see [`LICENSE`](LICENSE). Use it, change it, ship it; keep the notice in copies.
