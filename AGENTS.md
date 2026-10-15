# ats-autofill — the operating contract

Guidance for an agent working **in this repository**. It is deliberately short: it holds the rules
that never change and a routing table. Everything procedural is in the file the table names, and it
is read when it is needed, not before.

> **This file must stay small.** It is loaded into every session before any work starts, so its cost
> is paid every time and its detail is read by nobody. If you are about to add an explanation here,
> it belongs in `docs/` — or, if it is a lesson about a form behaving badly, it belongs in a **test**
> (see rule 1 below).

## What this is

A local-first toolkit for driving ATS (applicant-tracking-system) job-application forms over Chrome
DevTools Protocol. The one idea that shapes everything: **writing a value into a control proves
nothing, so every fill is read back off the rendered page** before anything is submitted.

Read [`README.md`](README.md) for what it does and does not do. Read [`docs/RULES.md`](docs/RULES.md)
for the numbered operating rules the source comments cite — those references are to that file.

## First: is this checkout configured at all?

**The configuration that ships here is an example describing a fictional person, and every value in it
reads as an answer to a real employer.** So before filling anything, look at the data directory:

- **It holds the example files, or it does not exist yet** → **stop and ask the person for the facts.**
  Every field the tool fills comes from there, and the example's `Example Candidate` of Springfield
  would otherwise be their name on a real application. What is needed: **identity and contact**;
  **address**; **education**; **work history, with the bullets that go on a resume**; the **standard
  answers every form asks** — work authorisation, sponsorship, relocation, consent, demographics; and
  the **compensating rule** — an answer that is not in the configuration stays blank and is reported,
  never invented.
- **Never fill a form from the example values, and never invent a fact to fill a gap. A blank the
  drafter reports back is the correct outcome**, not a failure to work around.

Which file holds which fact is [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), and it is not
restated here; `bash scripts/setup-examples.sh` is what puts the examples in place to be replaced.

**Ask the check rather than reading the files against `examples/` by eye.**
`.venv/bin/python3 src/tools/check_configuration.py` reports which of four states the data directory is
in — `absent`, `example`, `partial` (the state a bootstrap is in half way through, and the one that reads
as done), `configured` — names the files still holding example values and what each one holds, and exits
non-zero unless the checkout is usable. Run it first, and again after answering.

**Answer through the tool, not by editing nine files by hand.**
`.venv/bin/python3 src/tools/configure.py <answers.json>` merges one answers document into the shipped
examples, refuses to overwrite any file that is not still the example, and prints the state the check
would print. Its docstring is the shape of that file; `docs/CONFIGURATION.md` documents it in full.

## Hard rules for working here

1. **A lesson becomes a test, never a paragraph.** When a form does something unexpected, the fix is
   a fixture plus an assertion, with the tenant, the date and the markup that fooled it in **that
   test's comment**. A paragraph in a document is read once and believed forever; a test fails.
   If a lesson cannot be expressed as a test, that is a finding about the lesson.
2. **The browser is yours; a second instance is the tool's.** Run
   `node src/forms/chrome_launch.mjs` before any browser work. It **probes the port first and attaches
   when something answers**; only when nothing does it starts a Chrome whose profile lives **inside the
   data directory** (`<data>/chrome-cdp-profile`) — never the profile of the browser you are using. It
   is **headless by default** so nothing takes your focus; `--visible` is for the two things a headless
   instance cannot do with you (signing in to a board in a fresh profile, finishing a CAPTCHA). **It
   never quits or restarts anything**, and neither should you: a Chrome this tool did not start is not
   a Chrome it may end. Open **background** tabs only, and never call `bringToFront`. `page.goto()` and
   `context.newPage()` steal focus — use `src/forms/cdp_tabs.mjs open`. Port **9222 is refused** by the
   launcher: it belongs to another program on the machine. `src/tools/check_no_focus_steal.py` enforces
   the part of this that is greppable.
3. **Never write a fact about a person into this repository.** The tool fills forms from
   `data/`, which holds one real person's answers. `data/` is gitignored and must stay that way;
   examples under `examples/` are the schema, not content. A leaked profile is not a code leak — it
   is a stranger holding someone's address, phone number, visa status and salary expectation.
4. **Fill only from canonical data, and leave a gap empty rather than inventing an answer.** An
   answer that is not in the configuration stays blank and is reported. A wrong `Yes` is a false
   statement on a real application and cannot be taken back.
5. **Do not submit without the gate.** `src/forms/apply_form_spec.mjs` refuses a spec that asks it to
   submit; submission goes through `src/forms/verify_and_submit.mjs` and its expectations. Writing
   and submitting are separate steps on purpose.

## Routing table — read the right thing before acting

| What you are about to do | Read first |
| --- | --- |
| Fill anything at all from `data/` | the section above — then [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for which file holds which fact |
| Start or attach to the browser | `node src/forms/chrome_launch.mjs` — probes first, attaches if anything answers, `--print-command` to see what it would run |
| Understand what this tool is for, or what it refuses to do | [`README.md`](README.md) |
| Fill a form for the first time | `src/forms/inspect_ats_form.mjs` → `src/forms/draft_form_spec.py` → `src/forms/apply_form_spec.mjs`, in that order; each one's docstring says what it will not do |
| A fill that "succeeded" left the page empty | [`src/forms/diagnose_form.mjs`](src/forms/diagnose_form.mjs), then [`src/forms/field_state.mjs`](src/forms/field_state.mjs) — the placeholder that reads back as a value |
| Submit, or check before submitting | [`src/forms/verify_and_submit.mjs`](src/forms/verify_and_submit.mjs) — the expectation gate |
| Find out what a page actually contains | `node src/forms/inspect_ats_form.mjs <url-substring> --options` — read-only, prints facts |
| Add or change a widget fixture | [`src/forms/fixture_browser.mjs`](src/forms/fixture_browser.mjs) — the tests launch their **own** headless browser and a missing one is a skip, not a failure |
| Work out which configuration file holds a fact | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) |
| Understand a numbered rule a comment cites | [`docs/RULES.md`](docs/RULES.md) |
| Screen a posting before doing any work on it | `src/screening/check_duplicate.py`, then `src/screening/screen_urls.py` |
| Render a resume or cover letter | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — the master DOCX is yours to supply |
| Run the tests | `npm test` (below) |
| Run the tests with nothing skipping | `npm run test:contract` (below) |

## Skills

`skills/` holds the loadable procedures for the two jobs this repository does. Each is a plain
`SKILL.md` with YAML frontmatter, and the folder is deliberately unremarkable so that it is
**portable**: every harness that supports skills reads them from a directory of its own — Codex from
`.agents/skills/`, Claude Code from `.claude/skills/` — so point yours at this folder, or copy or link
it into the location your harness expects. `AGENTS.md` is the one file harnesses read on their own,
which is why it carries this pointer.

| Skill | Load it when |
| --- | --- |
| [`skills/submitting-an-application/`](skills/submitting-an-application/SKILL.md) | Taking a posting from a URL to a recorded outcome: screen, dedupe, tailor, fill, read back, gate, submit |
| [`skills/driving-ats-widgets/`](skills/driving-ats-widgets/SKILL.md) | Filling a control, or one that refuses to commit — comboboxes, react-selects, yes/no pairs, radio groups, uploads |

A skill holds **procedure and routing, never lessons** — a lesson belongs in a test (rule 1). The
There are no per-platform control maps, and nothing resolves a `references/` directory. What a platform
needs is asserted where it can fail: a page shape in `src/forms/fixtures/observed-shapes.json` with
`test_shape_coverage.mjs`, a control nothing can fill in `test_fill_roundtrip.mjs`, a screening sentence
in `test_screen_patterns.py`'s `CASES`, a tenant's policy or cap in `data/tenant_policies.json` or
`data/form_specs/tenant_caps.json`.

## Tests

```bash
npm test                        # both suites, against the data directory as it stands
ATS_DATA_DIR=/tmp/x npm test    # the same suites against another configuration (see src/paths.py)
npm run test:contract           # the same two suites against a fabricated configuration: 0 skips
```

`npm test` needs `.venv` (see `README.md`) and `node_modules`, and it **skips** the assertions that
describe a *configured* toolkit rather than code — a skip names what is missing. `npm run
test:contract` materialises `tests/fixtures/contract/` for the duration of one run so those assertions
execute: the configuration goes into a temporary directory outside the repository that `ATS_DATA_DIR`
points at, so this checkout's own `data/` is never read, written or moved. **Nothing is written inside the
checkout at all** — the fixture set is the whole of it — and the runner proves that by comparing the tree
before and after the run.

Where the configuration lives is the one setting: `src/paths.py` defines `ROOT` and `DATA_DIR`
(`$ATS_DATA_DIR` when set, `<repo>/data` otherwise), `src/paths.mjs` is its Node twin, and a shell
script asks for it with `python3 src/paths.py`. No module builds `data/` itself.

Both suites discover their own files: adding `src/**/test_*.py` or `src/forms/test_*.mjs` is enough
to have it run. Nothing needs registering in `package.json`.

## Where things live

| Path | Holds |
| --- | --- |
| `src/forms/` | The form pipeline: scan, draft a spec, fill, read back, gate the submit |
| `src/screening/` | Finding and filtering postings *before* anything is tailored |
| `src/pipeline/` | Producing an application's documents (resume, cover letter) |
| `src/metrics/` | What each application cost, read off the tool's own telemetry |
| `src/tools/` | Small single-purpose checkers, plus the Mail.app AppleScripts |
| `examples/` | Placeholder configuration — the schema, every value invented |
| `data/` | Where a real configuration goes. **Never commit it.** |
| `tests/fixtures/contract/` | Fabricated configuration used to run the skipped assertions |
