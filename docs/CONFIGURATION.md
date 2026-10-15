# Configuration

The code in `src/` is generic. **The configuration files are the tool's whole input** — no fact about the
applicant lives in the source. Copying the examples into the data directory is the step that turns this from a
demo into something that works for one specific person, and the moment it stops being generic.

```bash
bash scripts/setup-examples.sh      # creates <data>/, <data>/form_specs/, <data>/cover_letter/ and fills them
```

The script copies the example files in `examples/` to the paths the code reads — eight of the nine, since
`resume_profile.example.json` is a per-application template you copy yourself — and **never overwrites a file
that already exists**, so re-running it cannot clobber your own answers. It is the only setup step.

> **If the files below are the shipped examples, this checkout is not configured yet.** They describe a fictional person, and every value in them reads as an answer to a real employer. `AGENTS.md` opens with what to do about that - stop and ask the user for their facts - and the detail of what each file holds is the table further down this page.

## Where that directory is — `ATS_DATA_DIR`

The directory is a **setting**, not a name: `src/paths.py` defines `ROOT` and `DATA_DIR` (`$ATS_DATA_DIR` when
it is set, `<repo>/data` otherwise), and every module, script and shell entry point asks it — `src/paths.mjs` for
Node, `python3 src/paths.py` (which prints the resolved directory) for the shell. Every `data/…` path written
below is relative to it, so a second person's configuration can live outside the checkout, and so the contract
suite can run against a temporary tree:

```bash
ATS_DATA_DIR=~/ats-config bash scripts/setup-examples.sh

# "Should I apply to this?" — the duplicate check, which runs before any tailored work exists:
ATS_DATA_DIR=~/ats-config .venv/bin/python3 src/screening/check_duplicate.py "<posting-url>"
```

Every command that reads the configuration carries that prefix; drop it and the tools use `<repo>/data`.

"What should I apply to?" is two questions, and only one of them has a command. `check_duplicate.py` above is the
half the tracker can answer: whether this requisition, or a re-post of it under a new id, is already recorded — it
keys on the **requisition URL**, so what it is handed must be a posting URL and not the board's front page. The other
half, whether the tenant will take one more application, is `data/form_specs/tenant_caps.json` read through the
counting in `src/screening/tenant_caps.py`. That module has no command line of its own by design, because
`blocking_rule` takes the tracker rows, the caps and a date as arguments, so the caller is a preflight script of
yours (the one this project used, `data/scratch/preflight_role.py`, does not ship). The subcommand that used to do
part of this job, `preflight`, was removed on 2026-10-06.

Two things it does **not** cover. `output/` and `tmp/` stay beside the code — they hold generated documents and
render scratch space, not answers about a person. And a path recorded *inside* a configuration file, such as a
role profile's `template_docx`, is still resolved against the repository root: that is what a relative path in
one of those files has always meant, and the toolkit's own defaults are the half that follows the setting.

**The launched browser's profile is the one thing the toolkit writes here that is not configuration.** When no debugging instance is running, `src/forms/chrome_launch.mjs` starts one with its profile at `<data directory>/chrome-cdp-profile`, so it travels with everything else and a `--profile` pointing anywhere else is refused rather than honoured - a tool must never attach to or disturb the browser you are using. Nothing starts beside a live instance, and nothing here can stop or restart one it did not start.

## What each file is, and what reads it

| File (copied from `examples/`) | Holds | Read by |
| --- | --- | --- |
| `data/candidate_profile.json` (`candidate_profile.example.json`) | Identity, `confirmed_skills`, `safe_metrics`, `do_not_claim`, `resume_tracks`, and the two answer blocks: `standard_answers` (the questions every ATS asks — including `work_authorization`, which decides which postings the screen keeps, see below) and `standing_answers` (the answers you give every time) | `src/forms/draft_form_spec.py`, `src/forms/greenhouse_standard.mjs`, `src/pipeline/application_pipeline.py`, `src/pipeline/generate_tailored_resume.py`, `src/pipeline/build_cover_letter.py`, `src/screening/daily_screen.py`, `src/screening/screen_urls.py` (for the recorded compensation fallback, through `draft_form_spec.compensation_rule`) |
| `data/application_profile.json` (`application_profile.example.json`) | Contact block, address, education, work history with resume bullets, `workday_defaults`, resume view (`summary` / `skills` / `projects`) | `src/forms/draft_form_spec.py`, `src/forms/answer_school.mjs`, `src/forms/greenhouse_standard.mjs`, `src/autofill/workday/workday_runner.mjs`, `src/pipeline/application_pipeline.py`, `src/pipeline/build_resume.py`, `src/pipeline/build_cover_letter.py` |
| `data/form_specs/answer_rules.json` (`answer_rules.example.json`) | Wordings that recur, answered once, each with a note naming where the answer comes from. Tried **before** the drafter's built-in table | `src/forms/draft_form_spec.py` |
| `data/screening/sources.json` (`daily_sources.example.json`) | The boards to scan, the words the Workday channel searches for, the report's timezone, and the `filters` gates below | `src/screening/daily_screen.py`, `src/screening/screen_newgrad_postings.py` |
| `data/applications.csv` (`tracker.example.csv`) | One row per posting: date, company, title, source URL, eligibility verdict, recommended track, track scores, status, notes | `src/screening/tracker_index.py` (`load_rows`) is the shared reader, and `check_duplicate.py`, `daily_screen.py`, `screen_urls.py`, `filter_unapplied.py`, `harvest_board_slugs.py`, `screen_newgrad_postings.py` and several tests go through it. It is **not the only reader**: `src/pipeline/application_pipeline.py` has its own `read_tracker` (for `prepare` / `record-status` / `duplicates` / `handover`), and `src/screening/scan_tracker_tenants.py` opens the file itself — which is why the UTF-8 BOM is handled in more than one place. `src/pipeline/job_app_assistant.py` opens it to write. Nothing under `src/metrics/` reads it, and `src/screening/tenant_caps.py` takes its rows as arguments and borrows only the status vocabulary |
| `data/tenant_policies.json` (`tenant_policies.example.json`) | What individual employers will and will not do — `skip`, `no_sponsorship`, `form_only_bar` — with the evidence that established it | `src/screening/scan_registry_fresh.py` reads the `skip` policies, through `tenant_caps.tenant_skip_names`, so a skipped employer's roles stop surfacing as candidates; the rest is read by a person before tailoring for that tenant. Its shape is asserted by `src/screening/test_tenant_policies.py`: it is read by a person before tailoring for that tenant. Its shape is asserted by `src/screening/test_tenant_policies.py` |
| `data/form_specs/tenant_caps.json` (`tenant_caps.example.json`) | Application caps per board, keyed by the ATS **board slug**: cap, window, kind, and any second limit the same tenant states elsewhere | The counting lives in `src/screening/tenant_caps.py`; the file's shape and the counting are asserted by `src/screening/test_tenant_caps.py`. It is consulted *before* a form is opened, because a cap discovered at Submit costs a complete fill |
| `data/cover_letter/template.txt` (`cover_letter_template.example.txt`) | The letter's sentences, with `{{placeholders}}` for every fact | `src/pipeline/build_cover_letter.py`. An unresolved placeholder is an error, not a blank: a letter that says "I have  building" is worse than no letter |
| `data/form_specs/ashby_pairs_standing.json` (`ashby_pairs_standing.example.json`) | The standing table: recurring questions answered once, each with a note naming its source — plus `kind: "yesno"` for the ones a form wants committed as a pair | `src/forms/ashby_yesno.mjs`, `src/forms/press_all_pairs.mjs`, `src/forms/verify_and_submit.mjs` (it checks the page against the table before submitting), `src/forms/ashby_finish_form.mjs` |

`data/screening/sources.json` (`daily_sources.example.json`) is the board registry, and it is configuration
like everything else here. It used to live at `src/screening/daily_sources.json` and shipped inside the source
tree, on the reasoning that "nothing in it is about the applicant" — which was wrong on its own terms: it also
carried the words the Workday channel searches for (`"software engineer"`, `"software"`), and those are a fact
about the searcher. It holds three things:

* **the boards** — Greenhouse, Lever, Ashby and Workday slugs to fetch;
* **`queries`** and **`timezone`** — the words that channel searches for, and the zone the daily report is
  filed under. Both were constants in `daily_screen.py`;
* **`filters`** — the field and region gates, below.

## Which postings the screen keeps — `filters` in the board registry

**The words that describe your field are a fact about you, and they were six regexes in the source.** A nurse
or a designer running this screen got `not_engineering` on every posting and a report saying it had found
nothing. The `filters` block in `data/screening/sources.json` is where they live now; the shipped values are
still the software-engineering ones, so an unconfigured run behaves exactly as it always did.

| Key | What it is |
| --- | --- |
| `field_include` | The words that put a posting in your field. **A list is whole words**, each matched on its own — `["nurse"]` matches "Registered Nurse" and `"nursing"` does **not**; a string is a regex |
| `field_exclude` | Titles that are in the field's building but not the job you want (`nurse recruiter`) |
| `skip_title` | **The role families your field does not want to read** — the shipped value is software's `qa|test|ios|android|mobile|data engineer|machine learning|devops|sre`. The general words that apply everywhere (`manager`, `director`, `intern`, `recruiter`, `sales`) are not here; they are code, because no field writes "Manager" differently. Same rule as the other negatives: the shipped words stand while there is no `filters` block, and a block that names no `skip_title` gets **no** field skip gate rather than software's |
| `title_topics_exclude` | Topics that make a title irrelevant to you. Historically one person's "hardware is noise for a backend candidate" |
| `region_include` / `region_exclude` | Where you can work, from the location field. `[]` means no gate |
| `title_region_include` / `title_region_exclude` | The same, for a region a title carries when the location field does not |

**Where `field_include` comes from, in order:** the registry; else `candidate_profile.json` →
`resume_tracks[*].keywords`, because "what field are you in" is already recorded there; else the software
default. **Whichever it uses is printed**, because a gate decides what you never see and a count of excluded
postings looks the same whether the gate is right or wrong. A profile whose track keywords describe a
*specialism* — `backend`, `api`, `distributed` — will screen out postings titled with the field's own name,
and the note is how you find that out.

**Two rules worth knowing, both deliberate.** Naming a field and no region turns the region gate **off**
rather than keeping the US default: a wrong region silently hides postings, so it has to be stated. And once
a `filters` block exists at all, the two negative keys default to **none** unless you name them back — a
blocked title is a posting nobody ever sees, so the safe direction is to show one that could have been hidden.

**One widening to expect.** A registry written before `skip_title` existed names a field and no skip words, which reads as "no field skip gate" — so a `QA Engineer` or an `iOS Engineer` title is now kept where it was dropped before. The direction is deliberate (widen, never hide), and pasting the value you want into `filters.skip_title` restores exactly the old screening. An installed `data/screening/sources.json` predates the key, so it is one of these.

### The level vocabulary — `levels`, beside `filters`

**Seniority words are not field words.** "Senior" and "Staff" read the same in nursing as in software, so
the four patterns that decide a posting's level are their own block:

| Key | What it matches |
| --- | --- |
| `junior` | `Registered Nurse I`, `Software Engineer I`, `entry level`, `new grad` |
| `mid` | `… II`, `mid-level`, `level 2` |
| `senior` | `Senior`, `Staff`, `Lead`, `Principal` |
| `management` | `Manager`, `Director`, `Head of` |

A list is whole words, a string is a regex — the same rule as `filters`. The shipped values are the
patterns this project used, so an unconfigured run ranks exactly as it always did.

**The same block feeds the report.** `job_app_assistant`'s "Seniority hints" line reads these words, so a registry that names its own rungs is reported in them (a nursing registry reports `RN II`, not `software engineer ii`). A run with no `levels` block still reports software's three, which is the behaviour this project had.

**A missing `levels` block costs ranking, never a posting.** The level feeds the rank order and the
management filter; a title nobody recognises falls back to `unknown`, which ranks low and is never hidden.
Levels deliberately have **no** fallback to `resume_tracks[*].keywords`: those words describe the work, not
the rung.

### What the board listing shows now

`src/screening/list_board_jobs.py` used to hide every job whose title did not match a hardcoded
`engineer|developer|swe|architect|programmer` list — which is to say, every job on a hospital's board.
It now **prints every job and marks the ones in your field**, with a `roles in your field: N of M` summary.
Its own docstring had promised "no filtering" since it was written; a display gate's false negative is
invisible, which is why it is gone rather than reconfigured.

`src/screening/scan_registry_fresh.py` and `scan_tracker_tenants.py` screen in your configured field, the
same as `daily_screen.py`.

## Which postings the screen drops — `standard_answers.work_authorization`

**A work-authorisation requirement is a bar for one applicant and an open door for another.** "Must be a
U.S. citizen" is a wall for someone on a student visa and an open door for a citizen; "we are unable to
sponsor" is a wall for one and irrelevant to a green-card holder. `src/screening/daily_screen.py` reads the
posting's wording into a requirement, and this setting decides whether that requirement disqualifies you:

| Value | Meets |
| --- | --- |
| `us_citizen` | citizenship, U.S.-person, a clearance you must be able to obtain, residency, and the whole no-sponsorship family |
| `permanent_resident` | all of the above **except** citizenship and an already-held clearance |
| `authorized_no_sponsorship_needed` | the no-sponsorship family only (an EAD, OPT, TN and so on) |
| `requires_sponsorship` | none of them |

**Leave it unset and nothing is filtered.** Every posting is kept and its requirement is reported, which is
the safe direction: a posting dropped by mistake is one you never learn about, and cannot recover by
reading harder, while a posting kept by mistake costs one reading. Anything that is not one of the four
values above counts as unset.

**A clearance you must ALREADY hold is a bar for everyone** — nothing in a profile supplies one. "Ability
to obtain a security clearance", which a citizen can do, is treated separately from "active final DoD
Secret clearance required", because the two read the same to a keyword screen and mean opposite things.

## Bringing your own facts in — one answers file

`scripts/setup-examples.sh` installs the schema; the facts are yours. **Writing them by hand, file by
file, is the step that is easy to get wrong and impossible to see**: a profile that keeps the example's
`work_authorization: Yes` parses, renders and fills a form, and the false answer is only visible to the
employer. `src/tools/configure.py` takes the answers as one JSON document and writes them into the data
directory.

```bash
.venv/bin/python3 src/tools/configure.py answers.json             # into <repo>/data
.venv/bin/python3 src/tools/configure.py answers.json --data-dir ~/ats-config
.venv/bin/python3 src/tools/configure.py answers.json --dry-run   # report the plan, write nothing
```

```json
{
  "files": {
    "candidate_profile.json":       { "candidate": { "name": "…", "email": "…" } },
    "application_profile.json":     { "candidate": { "address": { "city": "…" } } },
    "form_specs/answer_rules.json": { "rules": [ { "questionRe": "…", "answer": "…", "note": "…" } ] },
    "screening/sources.json":       { "filters": { "field_include": ["nurse"] }, "queries": ["registered nurse"] },
    "applications.csv":             { "rows": [] },
    "cover_letter/template.txt":    "Dear {{company}} Hiring Team, …",
    "resume_profiles/<slug>.json":  { "company": "…", "role": "…", "source": "…", "summary": "…" }
  }
}
```

| Rule | What it means |
| --- | --- |
| A key is a path **relative to the data directory** | the ten files in `src/tools/check_configuration.py`'s table, or `<name>.json` under `resume_profiles/`. An absolute path or a `..` is refused rather than resolved — this tool writes into one directory |
| The skeleton is always the shipped example | the shape of every file comes from `examples/`, so it cannot drift from the code; your answers are merged into it |
| Objects merge; lists and scalars replace | a key you do not mention keeps the example's value, which is exactly what the check reports as `partly` |
| `null` deletes the key | how an example override that does not apply to you is removed (`"template_docx": null`, `"legal_name_native": null`). Deleting leaves the question blank and reported, which is the honest outcome |
| `applications.csv` takes `{"rows": […]}` | rows keyed by the example's own header; `{"rows": []}` is an empty tracker that still has its header. A column the example does not have is refused |
| The master resume DOCX cannot be written from answers | it is a binary file: put yours in `resume_templates/` and name it in `resume_tracks.<track>.template_docx` |

**A file that is not still its example is never overwritten, and no flag changes that.** A destination is
written only when it is missing or still byte-for-byte the example it was copied from — so a second run of
the same answers is a no-op, and a real tracker with a hundred rows in it survives one.

**Both entry points report the state.** `src/tools/check_configuration.py` prints `state: absent` /
`example` / `partial` / `configured`, names the files still holding example values and the paths inside
them, and exits non-zero unless the checkout is `configured`; `configure.py` ends with the same report and
the same status. Run the check first, and again after answering — `partial` is the state a bootstrap is in
half way through.
```

## The role profile — one per application

`prepare` takes `--profile <path>` and that path is a file you write, one per posting, in
`data/resume_profiles/`. Nothing generates it, because it is the one thing in the pipeline that is a
judgement about a specific job rather than a fact about you.

**It describes the POSTING, not the candidate.** That is the design, and it is enforced: your history,
skills and education come from `application_profile.json`, and a role profile that restates them is a
second copy of a fact — which is a copy that can drift. `validate_profile` also reads the profile's
text and refuses it if it claims anything on your `do_not_claim` list, so a summary that oversells is
rejected before anything is rendered rather than after.

**Four fields are required**, and the error names whichever are missing:

| Field | What it is |
| --- | --- |
| `company` | the employer, as the tracker spells it |
| `role` | the title, as the posting spells it |
| `source` | the **requisition URL** — this is what the duplicate check keys on, so it must not be the board's front page |
| `summary` | the opening paragraph of the resume, in your own voice. 450–800 characters, first person — `summary_guard.py` refuses anything outside that, refuses third-person phrasing, and refuses a subject-less fragment |

**Everything else is an optional override**, and omitting it is the normal case: `track`,
`header_title`, `template_docx`, `paragraph_replacements`, `skills`, `work_experience`, `jd_text`,
`websites` — and note that `header_title`, `skills` and `work_experience` are read for the `do_not_claim` check rather than for content: **`header_title` in particular changes nothing in the document.** This project's own header line is printed, and comes from `resume_tracks`, not from here.

Start from [`examples/resume_profile.example.json`](../examples/resume_profile.example.json) — it
carries every field, a `_readme` explaining the contract, and a summary that already satisfies the
guard so a first run is not refused for a reason you have to guess at:

```
cp examples/resume_profile.example.json data/resume_profiles/<company>_<role>.json
.venv/bin/python3 src/pipeline/application_pipeline.py prepare \
    --profile data/resume_profiles/<company>_<role>.json
```


**Keys on a track, beyond the resume files**: `keywords` (the words that describe your field — the
screening gate reads them when the registry names no `field_include`), `positioning` (the advice printed
for this track), `skill_lines` / `skill_lines_senior` (the Core Skills the tailored resume carries — a track
that records neither leaves the candidate's own skills on the page), and `default_header_title` (a printed
header, see below). All six are documented with comment keys in the example file itself.

**The header title is PRINTED, not rendered.** `job_app_assistant tailor` resolves it as
`--header-title` → `resume_tracks.<track>.default_header_title` → the posting's own title → a sentence
naming what is missing. Nothing writes it into a PDF or a DOCX today; the resume's header is the
candidate's name, from `application_profile.json`.

## The master resume DOCX is yours to supply

The resume pipeline is **template-driven**: it patches a master DOCX into a tailored resume rather than
generating one from scratch. The layout is yours — the toolkit fills the document you designed, it does not
design one for you — which is why no `.docx` ships with the repository.

**Where it goes.** `data/resume_templates/`, and the path is configuration rather than a fixed expectation: the
example profile names it in `resume_tracks.<track>.template_docx` (and `candidate.base_resume_docx`), and
`generate_tailored_resume.py --template <path>` overrides it for one run. The name the toolkit checks by default
is where the renderer opens the master from (`build_resume.TEMPLATE`), so a master under a different name needs
both the profile and that constant pointed at it.

**Get a working one in one command.** You do not have to reverse-engineer the required styles:

```
.venv/bin/python3 src/pipeline/make_master_resume.py            # writes to the path the renderer opens
.venv/bin/python3 src/pipeline/make_master_resume.py --out data/resume_templates/your_master.docx --name "Your Name"
```

It reads that path from `build_resume.TEMPLATE` rather than repeating it, so the scaffold always lands where
the renderer will look.

**What it reads out of it.** The layout, not the content. The renderer keeps the document's page setup and the
named paragraph styles it writes with — `ResumeName` for the name line, `SectionHead` for section headings,
`Normal` for everything else — then discards the body text and rebuilds the resume from
`application_profile.json` (`resume.summary`, `resume.skills`, `work_experience`, `resume.projects`,
`education`). A master whose styles go by other names fails with `no style with name 'ResumeName'`: that error
means the file you supplied is not the layout the renderer expects, and the fix is to copy those styles into
your document, not to edit the code.

The cover letter is the same idea and is already covered: its wording lives in
`data/cover_letter/template.txt`, filled by name from the two profiles — see
`examples/cover_letter_template.example.txt`.

Two rules these files are built around:

* **The tracker carries a UTF-8 BOM** (it is written with `encoding="utf-8-sig"`), and every reader that does not
  want a `\ufeff` glued to the first header name opens it with `utf-8-sig` for that reason. More than one reader
  does — see the row above.
* **A row in the tracker is not an application.** Only `submitted_by_user` and `submitted_by_agent` mean one was
  sent; `materials_ready`, `filled_for_review` and `not_applied` are records, and `not_applied` does not block a
  later attempt at the same posting.

### Bringing an existing tracker with you

**Check the status vocabulary before pointing this toolkit at a tracker you already have.** Those two values are
the only ones that count as "sent", and a row carrying *any other* string is treated as an application that never
happened — so the duplicate check will let you apply a second time to a job you already applied to. That is the one
mistake this project treats as unrecoverable, and a wrong status value is a silent way to make it.

An older tracker may spell the value differently. Count what your rows actually use before the first run:

```
grep -c 'submitted_by_' <your-tracker>.csv
sed 's/submitted_by_OLD/submitted_by_agent/g' <your-tracker>.csv > /tmp/migrated.csv
python3 -c "import csv,collections,sys; print(collections.Counter( \
  r['status'] for r in csv.DictReader(open(sys.argv[1], encoding='utf-8-sig'))))" /tmp/migrated.csv
```

The last line is the one that matters: **check that the number of sent rows is what you expect** before you trust
the duplicate check. Do it in a copy and keep the original — a tracker is the record of what you actually sent, and
it is the one file in this project that cannot be reconstructed from anywhere else.

## One rule: fill only from canonical data

**A form is filled only from the canonical data, and an answer that is not in the data is left blank and
reported rather than invented.**

That is the whole honesty model. When the drafter cannot find an answer it does not guess — it emits a
`needs_review` entry naming the question, and the field stays empty until a person answers it. The same applies
to numbers: a compensation field is answered from the top of the band the posting publishes, or from the
fallback recorded in `standing_answers.compensation`, and the fill spec records **which of the two a number
was**, because "the employer published this" and "we chose this" are different facts about an application.

It also means a blank is a finding, not a failure. A form that will not accept a blank is reported back with
the list of unanswered questions, so the answer is supplied once and persisted (a rule in `answer_rules.json`,
or a value in the profile) instead of being re-invented for the next application.

## `do_not_claim`

`do_not_claim` is a flat list of terms that must **never** appear as a claim about the applicant: a technology
they have not actually used, a certification they do not hold, a status or authorisation they are not in.

A tool that fills forms needs one because the failure mode is not a blank — it is a plausible answer. A form
asks "have you used X?", the filler has a profile shaped like the letter X used to be, and a wrong "Yes" is
submitted under the applicant's name. `do_not_claim` is the list that says *not this, not even once*, and it is
enforced in three places:

* `src/pipeline/application_pipeline.py` (when it validates a role profile's resume content) and
  `src/pipeline/generate_tailored_resume.py` reject a claim in a resume or a generated document, with a
  word-boundary matcher so a banned `Java` is not read inside a confirmed `JavaScript`, and so `C++` / `C#`
  stay whole. `src/pipeline/resume_artifacts.py` applies the allowed-phrase exemptions.
* `src/pipeline/cover_letter_template.py` re-checks the rendered letter, as the last line of defence.
* `src/pipeline/job_app_assistant.py` raises a caution when the *posting* itself names a banned term, so a role
  built on a stack you cannot claim is flagged before anything is tailored for it.

Two details worth keeping when you edit the list:

* **An honest negative is still a mention.** Describing a gap without naming the banned term is the safe form;
  "I have not used <term>" puts the term back in front of an employer who was checking for it.
* **`do_not_claim_allowed_phrases` is the narrow exception.** A term can be true of a *project* while remaining
  false as a claim about the person — "maintained services whose backend was <legacy stack>" is a fact about the
  work. A phrase listed there is allowed; every other mention is still rejected.

## Never commit these files

The configuration describes one real person: name, email, phone, address, education, work history, work
authorisation, salary expectation and the record of every job applied to. `.gitignore` ignores the files above
by default and explains why. `git add -f` overrides it, so the ignore file is a safety net rather than the
protection: never run a blanket `git add -A` in a checkout that holds answers about a real person.
